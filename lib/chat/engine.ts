import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { timezone } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { chatCall, chatModel, type CallMeta } from "@/lib/llm/client";
import { safeJson } from "@/lib/agent/drafter";
import { CostCapError, createChatTurnBudget } from "@/lib/agent/budget";
import { fetchInvoice } from "@/lib/agent/paypal-read";
import { CHAT_SYSTEM, turnContext } from "./prompt";
import { TOOL_DEFINITIONS, ToolContext, runTool, type ProposalOutcome } from "./tools";

/**
 * One chat message: a bounded tool loop (≤ MAX_CALLS model calls), every call under the
 * per-message and daily spend caps. The transcript lives server-side and is replayed
 * verbatim each turn (thinking blocks included), append-only, so the browser can't forge
 * earlier turns or tool results.
 */

export const MAX_CALLS = 6;
export const MAX_MESSAGES = 60;
const MAX_TOKENS = 4000;

export type ToolActivity = { name: string; input: unknown; ok: boolean; summary: string };

/** Live events for the streaming panel. */
export type TurnEvents = {
  onText?: (delta: string) => void;
  onToolStart?: (a: { id: string; name: string; summary: string }) => void;
  onToolDone?: (a: { id: string; name: string; summary: string; ok: boolean }) => void;
  onProposals?: (p: ProposalOutcome[]) => void;
};

export type TurnResult = {
  sessionId: string;
  /** True when the old conversation was too long and this turn started a fresh one. */
  newSession: boolean;
  reply: string;
  tools: ToolActivity[];
  proposals: ProposalOutcome[];
  costUsd: number;
  stop: "answered" | "call_limit" | "spend_cap" | "refusal" | "max_tokens";
};

type Stored =
  | { kind: "user_text"; content: { blocks: Anthropic.ContentBlockParam[]; display: string; invoiceId: string | null } }
  | { kind: "assistant"; content: { blocks: Anthropic.ContentBlock[] } }
  | { kind: "tool_results"; content: { blocks: Anthropic.ToolResultBlockParam[]; activity: ToolActivity[]; outcomes?: { invoiceNumber: string | null; outcome: string }[] } };

function toParams(rows: Stored[]): Anthropic.MessageParam[] {
  return rows.map((r) =>
    r.kind === "assistant"
      ? { role: "assistant", content: r.content.blocks as unknown as Anthropic.ContentBlockParam[] }
      : { role: "user", content: r.content.blocks });
}

/** Wrap a tool result: trusted data and untrusted customer text in separate, escaped blocks. */
export function formatToolResult(r: { data: unknown; untrusted?: unknown }): string {
  let out = `<tool_data>\n${safeJson(r.data)}\n</tool_data>`;
  if (r.untrusted !== undefined) out += `\n<untrusted_data>\n${safeJson(r.untrusted)}\n</untrusted_data>`;
  return out;
}

function summarize(name: string, input: Record<string, unknown>): string {
  const ref = (input.invoice ?? input.customer_email ?? (Array.isArray(input.invoices) ? (input.invoices as string[]).join(", ") : "")) as string;
  const label: Record<string, string> = {
    get_summary: "Checked PayPal invoices", list_invoices: "Checked PayPal invoices", customers_owing: "Checked who owes money",
    get_invoice: `Looked up ${ref}`, customer_history: `Read payment history for ${ref}`, reminder_history: `Read reminder history for ${ref}`,
    get_queue: "Checked Approvals", recent_sends: "Checked sent reminders", get_report: "Built a report", recent_payments: "Checked payments received", preview_overdue: "Checked what's overdue", request_reminder_proposals: `Drafting reminders for ${ref}`,
  };
  return label[name] ?? name;
}

export async function chatTurn(opts: { sessionId?: string | null; text: string; invoiceId?: string | null }, events: TurnEvents = {}): Promise<TurnResult> {
  const store = getStore();
  let newSession = false;
  let session = opts.sessionId ? await store.getChatSession(opts.sessionId) : null;
  let history = session ? ((await store.listChatMessages(session.id)).map((m) => ({ kind: m.kind, content: m.content })) as Stored[]) : [];
  if (!session || history.length >= MAX_MESSAGES) {
    newSession = !!session;
    session = await store.createChatSession();
    history = [];
  }
  const sessionId = session.id;
  const ctx = new ToolContext();

  // Page context: the server looks the invoice up itself; the client only names it.
  let viewing: { invoiceNumber: string | null; invoiceId: string } | null = null;
  if (opts.invoiceId) {
    try {
      const inv = await fetchInvoice(opts.invoiceId);
      viewing = { invoiceNumber: inv.detail.invoice_number ?? null, invoiceId: inv.id };
    } catch { /* unknown invoice: ignore the context */ }
  }

  const user: Stored = { kind: "user_text", content: {
    blocks: [{ type: "text", text: `${turnContext({ today: ctx.today, timezone: timezone(), viewing })}\n\n${opts.text}` }],
    display: opts.text, invoiceId: viewing?.invoiceId ?? null,
  } };
  await store.appendChatMessage({ sessionId, role: "user", kind: user.kind, content: user.content });
  history.push(user);

  const budget = createChatTurnBudget(sessionId);
  const tools: ToolActivity[] = [];
  const proposals: ProposalOutcome[] = [];
  const metas: CallMeta[] = [];
  let reply = "";
  let stop: TurnResult["stop"] = "call_limit";

  try {
    for (let call = 0; call < MAX_CALLS; call++) {
      const { response, meta } = await chatCall({
        purpose: "chat", model: chatModel(), system: CHAT_SYSTEM, messages: toParams(history), tools: TOOL_DEFINITIONS,
        maxTokens: MAX_TOKENS, effort: "medium", budget, onTextDelta: events.onText,
      });
      metas.push(meta);
      const assistant: Stored = { kind: "assistant", content: { blocks: response.content } };
      await store.appendChatMessage({ sessionId, role: "assistant", kind: "assistant", content: assistant.content });
      history.push(assistant);

      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (response.stopReason === "refusal") { reply = text || "I can't help with that one."; stop = "refusal"; break; }
      if (response.stopReason === "max_tokens") { reply = text || "That answer ran too long; try a narrower question."; stop = "max_tokens"; break; }

      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) { reply = text; stop = "answered"; break; }

      // Run the requested tools (sequentially: a draft request should see fresh state).
      const results: Anthropic.ToolResultBlockParam[] = [];
      const activity: ToolActivity[] = [];
      const batchOutcomes: { invoiceNumber: string | null; outcome: string }[] = [];
      for (const u of uses) {
        const input = (u.input ?? {}) as Record<string, unknown>;
        const summary = summarize(u.name, input);
        events.onToolStart?.({ id: u.id, name: u.name, summary });
        try {
          const r = await runTool(u.name, input, ctx);
          if (r.proposals) {
            proposals.push(...r.proposals);
            batchOutcomes.push(...r.proposals.map((p) => ({ invoiceNumber: p.invoiceNumber, outcome: p.outcome })));
            events.onProposals?.(r.proposals);
          }
          results.push({ type: "tool_result", tool_use_id: u.id, content: formatToolResult(r) });
          activity.push({ name: u.name, input, ok: true, summary });
          events.onToolDone?.({ id: u.id, name: u.name, summary, ok: true });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: (err as Error).message });
          activity.push({ name: u.name, input, ok: false, summary: `${summary} (failed)` });
          events.onToolDone?.({ id: u.id, name: u.name, summary, ok: false });
        }
      }
      tools.push(...activity);
      const toolMsg: Stored = { kind: "tool_results", content: { blocks: results, activity, ...(batchOutcomes.length ? { outcomes: batchOutcomes } : {}) } };
      await store.appendChatMessage({ sessionId, role: "user", kind: "tool_results", content: toolMsg.content });
      history.push(toolMsg);
      if (text) reply = text;
    }
    if (stop === "call_limit") reply = reply || "I looked at a lot for that one and didn't finish. Could you narrow the question?";
  } catch (err) {
    if (!(err instanceof CostCapError)) throw err;
    stop = "spend_cap";
    reply = err.cap === "daily"
      ? "I've reached today's spending limit for AI calls, so I can't answer more today. Your data is unchanged."
      : "That question needed more work than one message allows. Try asking something narrower.";
  }

  const costUsd = metas.reduce((s, m) => s + m.costUsd, 0);
  await store.audit({ actor: "chat", event: "chat.turn", entityType: "chat_session", entityId: sessionId, data: {
    stop, calls: metas.length, costUsd, model: metas[0]?.model ?? chatModel(), requestIds: metas.map((m) => m.requestId),
    tools: tools.map((t) => ({ name: t.name, input: t.input, ok: t.ok })),
    proposals: proposals.map((p) => ({ invoiceId: p.invoiceId, outcome: p.outcome, proposalId: p.proposalId })),
    viewing: viewing?.invoiceId ?? null,
  } });
  return { sessionId, newSession, reply, tools, proposals, costUsd, stop };
}

/** The conversation as the panel shows it: what the user typed, Kairos's replies, and tool activity. */
export async function transcript(sessionId: string) {
  const rows = (await getStore().listChatMessages(sessionId)) as unknown as (Stored & { at: string })[];
  const out: { role: "user" | "assistant" | "activity" | "drafts"; text: string; at: string; outcomes?: { invoiceNumber: string | null; outcome: string }[] }[] = [];
  let pending: { invoiceNumber: string | null; outcome: string }[] = [];
  for (const r of rows) {
    if (r.kind === "user_text") {
      if (pending.length) { out.push({ role: "drafts", text: "", at: r.at, outcomes: pending }); pending = []; }
      out.push({ role: "user", text: r.content.display, at: r.at });
    } else if (r.kind === "tool_results") {
      for (const a of r.content.activity) out.push({ role: "activity", text: a.summary, at: r.at });
      if (r.content.outcomes) pending.push(...r.content.outcomes);
    }
    else {
      const text = r.content.blocks.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) out.push({ role: "assistant", text, at: r.at });
    }
  }
  // Like the live panel: the drafts card follows Kairos's reply.
  if (pending.length) out.push({ role: "drafts", text: "", at: rows.at(-1)?.at ?? "", outcomes: pending });
  return out;
}
