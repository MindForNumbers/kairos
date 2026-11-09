import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { addDays, daysBetween, localDate, nowMs, startOfLocalDay, timezone } from "@/lib/clock";
import { getStore, type Proposal } from "@/lib/db";
import { fetchInvoice, listAllInvoices, type Invoice } from "@/lib/agent/paypal-read";
import { CHASEABLE, GRACE_DAYS_EXPORT, REMINDER_COOLDOWN_DAYS, dueDateOf, holdingProposal, sweep } from "@/lib/agent/sweep";
import { cleanUntrusted, flagUntrusted } from "@/lib/agent/untrusted";
import { ESCALATE_AFTER_DAYS, currentReason } from "@/lib/agent/policy";
import { runAgent } from "@/lib/agent/pipeline";
import { RunBusyError, withRunLock } from "@/lib/agent/run-guard";
import { CostCapError } from "@/lib/agent/budget";
import { amountDue, createdAt, currencyOf, daysOverdue, isOpen, recipientEmail, stats, sumDue, toCents, fromCents } from "@/lib/invoice-stats";

/**
 * Kairos chat tools. READ-ONLY, plus exactly one action: request_reminder_proposals, which
 * runs the normal agent pipeline (sweep rules → drafter → critic/code checks → Approvals).
 * Nothing here sends, approves, rejects, resolves or writes to PayPal; the boundary rule for
 * lib/chat/ and the allowlist test enforce that.
 *
 * Every tool returns { data, untrusted }. `untrusted` holds customer-visible free text
 * (names, notes, item text, critic reasons that may quote it). The engine wraps it in
 * <untrusted_data> so the model treats it as data, never instructions.
 */

export type ToolResult = { data: unknown; untrusted?: unknown; proposals?: ProposalOutcome[] };
export type ProposalOutcome = { invoiceNumber: string | null; invoiceId: string; outcome: string; proposalId: string | null; detail: string };

/** Per-turn cache so several tools in one message don't re-list every invoice. */
export class ToolContext {
  private all: Promise<{ invoices: Invoice[]; truncated: boolean }> | null = null;
  readonly today = localDate();
  listAll() {
    this.all ??= listAllInvoices();
    return this.all;
  }
  /** Accepts a PayPal invoice ID or an invoice number like "DEMO-08" (case-insensitive). */
  async resolve(ref: string): Promise<Invoice | null> {
    const r = ref.trim();
    const { invoices } = await this.listAll();
    const hit = invoices.find((i) => i.id === r || (i.detail.invoice_number ?? "").toLowerCase() === r.toLowerCase());
    return hit ? fetchInvoice(hit.id) : null;
  }
}

const nameOf = (inv: Invoice) => {
  const n = inv.primary_recipients?.[0]?.billing_info?.name;
  return cleanUntrusted(n?.full_name || [n?.given_name, n?.surname].filter(Boolean).join(" "), 140);
};
const money = (cur: string, v: string) => `${v} ${cur}`;

/** Timestamps in the business timezone, e.g. "Nov 6, 2026, 10:53 PM PST" (never raw UTC). */
export const local = (iso: string) => {
  const d = new Date(iso);
  // dateStyle/timeStyle can't be combined with timeZoneName, so take the zone abbreviation separately.
  const when = new Intl.DateTimeFormat("en-US", { timeZone: timezone(), dateStyle: "medium", timeStyle: "short" }).format(d);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: timezone(), timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
  return zone ? `${when} ${zone}` : when;
};

function row(inv: Invoice, today: string) {
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.detail.invoice_number ?? null,
    status: inv.status,
    customerEmail: recipientEmail(inv),
    total: inv.amount ? money(inv.amount.currency_code, inv.amount.value) : null,
    amountDue: isOpen(inv) ? money(currencyOf(inv), amountDue(inv)) : money(currencyOf(inv), "0.00"),
    invoiceDate: inv.detail.invoice_date ?? null,
    dueDate: dueDateOf(inv),
    daysOverdue: daysOverdue(inv, today),
  };
}

// ---- Agent state for one invoice: what Kairos would do and what the user can do next ----------

type AgentState = {
  state: "not_open" | "not_due" | "grace_period" | "cooldown" | "awaiting_approval" | "needs_human" | "eligible_for_reminder";
  detail: string;
  lastReminder: { at: string; source: string } | null;
};

async function agentState(inv: Invoice, today: string): Promise<{ state: AgentState; holdReason: string | null }> {
  const store = getStore();
  const last = await store.lastSendFor(inv.id);
  const lastReminder = last ? { at: local(last.sentAt), source: last.source } : null;
  if (!CHASEABLE.has(inv.status)) return { state: { state: "not_open", detail: `invoice is ${inv.status}; nothing to collect`, lastReminder }, holdReason: null };
  const due = dueDateOf(inv);
  const late = due ? daysBetween(due, today) : 0;
  if (!due || late <= 0) return { state: { state: "not_due", detail: due ? `due ${due}` : "no due date", lastReminder }, holdReason: null };
  const hold = await holdingProposal(inv.id);
  if (hold?.reason === "in_queue") return { state: { state: "awaiting_approval", detail: `a reminder draft is waiting on the Approvals page (${hold.proposal.status})`, lastReminder }, holdReason: null };
  if (hold?.reason === "needs_human") {
    const detail = late > ESCALATE_AFTER_DAYS
      ? `over ${ESCALATE_AFTER_DAYS} days overdue: Kairos never drafts automated reminders for these. The owner should contact the customer directly, then resolve or dismiss it on the Approvals page.`
      : hold.proposal.status === "blocked"
        ? "a draft was blocked by Kairos's checks and is held on the Approvals page; resolve or dismiss it there, and Kairos can draft again on a later run"
        : "escalated to a human on the Approvals page; resolve or dismiss it there";
    return { state: { state: "needs_human", detail, lastReminder }, holdReason: currentReason(hold.proposal.reason, late) };
  }
  if (late < GRACE_DAYS_EXPORT) return { state: { state: "grace_period", detail: `${late} days late; reminders start after ${GRACE_DAYS_EXPORT} days`, lastReminder }, holdReason: null };
  if (last && Date.parse(last.sentAt) > nowMs() - REMINDER_COOLDOWN_DAYS * 86_400_000) {
    return { state: { state: "cooldown", detail: `reminded ${last.sentAt.slice(0, 10)}; next reminder possible after ${addDays(last.sentAt.slice(0, 10), REMINDER_COOLDOWN_DAYS)}`, lastReminder }, holdReason: null };
  }
  if (late > ESCALATE_AFTER_DAYS) return { state: { state: "eligible_for_reminder", detail: `${late} days overdue: over ${ESCALATE_AFTER_DAYS} days, so a draft request will be escalated to a human instead of drafted`, lastReminder }, holdReason: null };
  return { state: { state: "eligible_for_reminder", detail: `${late} days overdue; Kairos can draft a reminder for approval`, lastReminder }, holdReason: null };
}

// ---- Tool definitions (strict schemas: every property required, nullable when optional) ----------

const obj = (properties: Record<string, unknown>) => ({ type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false });
const invoiceRef = { type: "string", description: "Invoice number (e.g. DEMO-08) or PayPal invoice ID (INV2-...)." };

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  { name: "get_summary", strict: true,
    description: "Business snapshot right now: total unpaid and overdue amounts, counts, oldest overdue, reminders awaiting approval, items needing a human, reminders sent today.",
    input_schema: obj({}) },
  { name: "list_invoices", strict: true,
    description: "List invoices with status, amounts, due dates and days overdue. Use for 'what's overdue', 'show unpaid', or one customer's invoices.",
    input_schema: obj({
      status: { type: "string", enum: ["open", "overdue", "paid", "cancelled", "draft", "all"], description: "open = sent and not fully paid." },
      customer: { type: ["string", "null"], description: "Filter by customer email or name (substring), or null." },
      sort: { type: "string", enum: ["most_overdue", "largest_due", "newest"] },
      limit: { type: "integer", description: "1 to 50." },
    }) },
  { name: "customers_owing", strict: true,
    description: "Who owes money: open balances grouped by customer, with overdue counts and the oldest overdue days. Use for 'who owes me'.",
    input_schema: obj({ limit: { type: "integer", description: "1 to 50." } }) },
  { name: "get_invoice", strict: true,
    description: "Full detail for one invoice: amounts, dates, line items, payments received, reminders sent, and Kairos's state for it (eligible for a reminder, awaiting approval, cooldown, ...). Use it before explaining an invoice or suggesting next steps.",
    input_schema: obj({ invoice: invoiceRef }) },
  { name: "customer_history", strict: true,
    description: "A customer's payment history: every invoice for that email, payments received with dates, how many days after the due date they paid, reminders sent, and what is still owed.",
    input_schema: obj({ customer_email: { type: "string" } }) },
  { name: "reminder_history", strict: true,
    description: "What happened to reminders for one invoice: drafts Kairos made, their review result, approvals, sends (or why not sent), rejections and resolutions, in time order.",
    input_schema: obj({ invoice: invoiceRef }) },
  { name: "get_queue", strict: true,
    description: "The Approvals page right now: reminder drafts awaiting approval, and items that need a human (blocked or escalated) with the reason.",
    input_schema: obj({}) },
  { name: "preview_overdue", strict: true,
    description: "Read-only preview of what a Kairos run would draft now: which overdue invoices are in the next run, which are deferred, and which are skipped and why.",
    input_schema: obj({}) },
  { name: "request_reminder_proposals", strict: true,
    description: "Ask Kairos to DRAFT payment reminders for up to 5 invoices. Drafts go through the normal checks and land on the Approvals page; nothing is sent until the user approves there. Only call this after the user has asked for it or said yes to your offer. Takes invoice references only.",
    input_schema: obj({ invoices: { type: "array", items: invoiceRef, description: "1 to 5 invoices." } }) },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

// ---- Handlers -----------------------------------------------------------------------------------

type Input = Record<string, unknown>;

/** Strict tool schemas can't carry min/max, so bounds are enforced here. */
const clampLimit = (v: unknown) => Math.min(50, Math.max(1, Math.trunc(Number(v)) || 20));

export async function runTool(name: string, input: Input, ctx: ToolContext): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}`);
  return handler(input, ctx);
}

const HANDLERS: Record<string, (input: Input, ctx: ToolContext) => Promise<ToolResult>> = {
  async get_summary(_i, ctx) {
    const { invoices, truncated } = await ctx.listAll();
    const s = stats(invoices, ctx.today);
    const store = getStore();
    const [queued, human, sentToday] = await Promise.all([
      store.listProposals({ status: ["passed", "approved"] }),
      store.listProposals({ status: ["blocked", "escalated"] }),
      store.countSendsSince(startOfLocalDay()),
    ]);
    return { data: {
      today: ctx.today,
      unpaid: s.unpaid, overdue: s.overdueTotals, openInvoices: s.openCount, overdueInvoices: s.overdueCount, oldestOverdueDays: s.oldestOverdueDays,
      remindersAwaitingApproval: queued.length, needsHuman: human.filter((p) => !p.resolution).length, remindersSentToday: sentToday,
      totalInvoices: invoices.length, truncated,
    } };
  },

  async list_invoices(i, ctx) {
    const { invoices } = await ctx.listAll();
    const status = i.status as string;
    const q = typeof i.customer === "string" ? i.customer.toLowerCase().trim() : "";
    let rows = invoices.filter((inv) =>
      status === "all" ? true
      : status === "open" ? isOpen(inv)
      : status === "overdue" ? daysOverdue(inv, ctx.today) > 0
      : status === "paid" ? ["PAID", "MARKED_AS_PAID"].includes(inv.status)
      : status === "cancelled" ? inv.status === "CANCELLED"
      : inv.status === "DRAFT");
    if (q) rows = rows.filter((inv) => (recipientEmail(inv) ?? "").toLowerCase().includes(q) || (nameOf(inv) ?? "").toLowerCase().includes(q));
    const sort = i.sort as string;
    rows.sort((a, b) => sort === "largest_due" ? toCents(amountDue(b)) * Number(isOpen(b)) - toCents(amountDue(a)) * Number(isOpen(a))
      : sort === "most_overdue" ? daysOverdue(b, ctx.today) - daysOverdue(a, ctx.today)
      : createdAt(b).localeCompare(createdAt(a)));
    const limited = rows.slice(0, clampLimit(i.limit));
    return {
      data: { today: ctx.today, matched: rows.length, shown: limited.length, totalDueOfMatched: sumDue(rows.filter(isOpen)), invoices: limited.map((inv) => row(inv, ctx.today)) },
      untrusted: { customerNames: Object.fromEntries(limited.map((inv) => [inv.id, nameOf(inv)])) },
    };
  },

  async customers_owing(i, ctx) {
    const { invoices } = await ctx.listAll();
    const by = new Map<string, Invoice[]>();
    for (const inv of invoices.filter(isOpen)) {
      const key = recipientEmail(inv) ?? "(no email)";
      by.set(key, [...(by.get(key) ?? []), inv]);
    }
    const customers = [...by].map(([email, invs]) => ({
      customerEmail: email,
      owes: sumDue(invs),
      openInvoices: invs.length,
      overdueInvoices: invs.filter((x) => daysOverdue(x, ctx.today) > 0).length,
      oldestOverdueDays: Math.max(0, ...invs.map((x) => daysOverdue(x, ctx.today))),
      invoiceNumbers: invs.map((x) => x.detail.invoice_number ?? x.id),
    })).sort((a, b) => toCents(b.owes[0]?.value) - toCents(a.owes[0]?.value));
    const shown = customers.slice(0, clampLimit(i.limit));
    return {
      data: { today: ctx.today, customersWithBalance: customers.length, customers: shown },
      // One email can carry different names on different invoices: list them all, don't pick one.
      untrusted: { namesOnInvoicesByEmail: Object.fromEntries(shown.map((c) => [c.customerEmail, [...new Set(by.get(c.customerEmail)!.map(nameOf).filter(Boolean))]])) },
    };
  },

  async get_invoice(i, ctx) {
    const inv = await ctx.resolve(String(i.invoice));
    if (!inv) return { data: { found: false, invoice: i.invoice } };
    const { state, holdReason } = await agentState(inv, ctx.today);
    const store = getStore();
    const reminders = (await store.listLedger({ invoiceId: inv.id })).map((l) => ({ at: local(l.sentAt), source: l.source }));
    const items = (inv.items ?? []).slice(0, 20);
    return {
      data: {
        found: true, ...row(inv, ctx.today),
        amountPaid: inv.payments?.paid_amount ? money(inv.payments.paid_amount.currency_code, inv.payments.paid_amount.value) : null,
        payments: (inv.payments?.transactions ?? []).map((t) => ({ date: t.payment_date ?? null, method: t.method ?? null, amount: t.amount ? money(t.amount.currency_code, t.amount.value) : null })),
        paymentTerm: inv.detail.payment_term?.term_type ?? null,
        lineItems: items.map((it, n) => ({ line: n + 1, quantity: it.quantity, unitPrice: money(it.unit_amount.currency_code, it.unit_amount.value), taxPercent: it.tax?.percent ?? null })),
        remindersSent: reminders,
        kairos: state,
      },
      untrusted: {
        customerName: nameOf(inv),
        note: cleanUntrusted(inv.detail.note),
        lineItemText: items.map((it, n) => ({ line: n + 1, name: cleanUntrusted(it.name, 200), description: cleanUntrusted(it.description) })),
        holdReason,
        flags: flagUntrusted(inv.detail.note, nameOf(inv), ...items.flatMap((it) => [it.name, it.description])),
      },
    };
  },

  async customer_history(i, ctx) {
    const email = String(i.customer_email).toLowerCase().trim();
    const { invoices } = await ctx.listAll();
    const mine = invoices.filter((inv) => (recipientEmail(inv) ?? "").toLowerCase() === email);
    if (!mine.length) return { data: { found: false, customerEmail: email } };
    const store = getStore();
    // Summaries omit payments; fetch detail for invoices that received money (bounded).
    const paidish = mine.filter((inv) => ["PAID", "MARKED_AS_PAID", "PARTIALLY_PAID"].includes(inv.status)).slice(0, 15);
    const details = new Map((await Promise.all(paidish.map((inv) => fetchInvoice(inv.id)))).map((d) => [d.id, d]));
    const history = await Promise.all(mine.sort((a, b) => createdAt(a).localeCompare(createdAt(b))).map(async (inv) => {
      const d = details.get(inv.id);
      const due = dueDateOf(inv);
      const payments = (d?.payments?.transactions ?? []).map((t) => ({
        date: t.payment_date ?? null, method: t.method ?? null, amount: t.amount ? money(t.amount.currency_code, t.amount.value) : null,
        daysAfterDue: t.payment_date && due ? daysBetween(due, t.payment_date) : null,
      }));
      return { ...row(inv, ctx.today), payments, remindersSent: (await store.listLedger({ invoiceId: inv.id })).length };
    }));
    const lateness = history.flatMap((h) => h.payments.map((p) => p.daysAfterDue)).filter((x): x is number => x !== null);
    const paidCents = history.flatMap((h) => h.payments).reduce((s, p) => s + toCents(p.amount?.split(" ")[0]), 0);
    return {
      data: {
        customerEmail: email, invoices: history.length,
        outstanding: sumDue(mine.filter(isOpen)),
        paidTotal: paidCents ? `${fromCents(paidCents)} ${currencyOf(mine[0])}` : null,
        paymentsReceived: lateness.length,
        averageDaysAfterDue: lateness.length ? Math.round(lateness.reduce((a, b) => a + b, 0) / lateness.length) : null,
        history,
      },
      untrusted: { namesOnInvoices: Object.fromEntries(mine.map((inv) => [inv.detail.invoice_number ?? inv.id, nameOf(inv)])) },
    };
  },

  async reminder_history(i, ctx) {
    const inv = await ctx.resolve(String(i.invoice));
    if (!inv) return { data: { found: false, invoice: i.invoice } };
    const store = getStore();
    const proposals = (await store.listProposals({ invoiceId: inv.id })).reverse();
    const reasons: Record<string, string | null> = {};
    const events: { at: string; what: string; proposalId?: string }[] = [];
    for (const p of proposals) {
      reasons[p.id] = currentReason(p.reason, daysOverdue(inv, ctx.today) || null);
      events.push({ at: p.createdAt, proposalId: p.id, what: p.kind === "escalate" ? "Kairos escalated it to a human (no draft)" : `Kairos drafted a ${p.tone ?? ""} reminder (revision ${p.revision})` });
      for (const e of (await store.listAudit({ entityType: "proposal", entityId: p.id })).reverse()) {
        const label = AUDIT_LABEL[e.event] ?? (e.event.startsWith("executor.") ? `executor: ${e.event.slice(9)}` : null);
        if (label) events.push({ at: e.at, proposalId: p.id, what: label });
      }
      if (p.resolution) events.push({ at: p.resolution.at, proposalId: p.id, what: `a human marked it ${p.resolution.action}` });
    }
    for (const l of await store.listLedger({ invoiceId: inv.id })) events.push({ at: l.sentAt, what: `reminder SENT (${l.source})` });
    for (const e of await store.listAudit({ entityType: "invoice", entityId: inv.id })) {
      if (e.event.startsWith("manual_remind.") && e.event !== "manual_remind.sent") events.push({ at: e.at, what: `manual reminder ${e.event.slice(14)}` });
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    const sent = (await store.listLedger({ invoiceId: inv.id })).length;
    return {
      data: {
        invoiceNumber: inv.detail.invoice_number ?? null, invoiceId: inv.id, invoiceStatus: inv.status,
        remindersActuallySent: sent,
        events: events.map((e) => ({ ...e, at: local(e.at) })),
        drafts: proposals.map((p) => ({ proposalId: p.id, kind: p.kind, revision: p.revision, tone: p.tone, drafted: local(p.createdAt), now: STATUS_MEANING[p.status] ?? p.status, resolved: p.resolution?.action ?? null })),
      },
      // Reasons can quote critic findings, which can quote customer text.
      untrusted: { proposalReasons: reasons },
    };
  },

  async get_queue(_i, ctx) {
    const store = getStore();
    const { invoices } = await ctx.listAll();
    const daysNow = (id: string) => { const inv = invoices.find((x) => x.id === id); return inv ? daysOverdue(inv, ctx.today) || null : null; };
    const [queued, human] = await Promise.all([
      store.listProposals({ status: ["passed", "approved"] }),
      store.listProposals({ status: ["blocked", "escalated"] }),
    ]);
    const open = human.filter((p) => !p.resolution);
    const invoiceNumber = async (p: Proposal) => ((await store.getRun(p.runId))?.sweep as { candidates?: { invoiceId: string; invoiceNumber: string | null }[] } | null)
      ?.candidates?.find((c) => c.invoiceId === p.invoiceId)?.invoiceNumber ?? null;
    return {
      data: {
        awaitingApproval: await Promise.all(queued.map(async (p) => ({ invoiceNumber: await invoiceNumber(p), invoiceId: p.invoiceId, tone: p.tone, drafted: local(p.createdAt), proposalId: p.id }))),
        needsHuman: await Promise.all(open.map(async (p) => ({ invoiceNumber: await invoiceNumber(p), invoiceId: p.invoiceId, status: p.status, proposalId: p.id }))),
        approvalsPage: "/approvals",
      },
      untrusted: { reasons: Object.fromEntries(open.map((p) => [p.id, currentReason(p.reason, daysNow(p.invoiceId))])) },
    };
  },

  async preview_overdue() {
    const s = await sweep({ audit: false });
    const brief = (r: { invoiceId: string; invoiceNumber: string | null; daysOverdue: number; amountDue: string | null; currency: string }) =>
      ({ invoiceNumber: r.invoiceNumber, invoiceId: r.invoiceId, daysOverdue: r.daysOverdue, amountDue: r.amountDue ? `${r.amountDue} ${r.currency}` : null });
    return { data: {
      today: s.today, overdue: s.counts.overdue,
      nextRun: s.candidates.map(brief), deferredToLaterRun: s.deferred.map(brief),
      skipped: s.excluded.map((e) => ({ invoiceNumber: e.invoiceNumber, daysOverdue: e.daysOverdue, reason: e.reason, detail: e.detail })),
      flagged: s.candidates.concat(s.deferred).filter((c) => c.flags.length).map((c) => ({ invoiceNumber: c.invoiceNumber, flags: c.flags })),
    } };
  },

  async request_reminder_proposals(i, ctx) {
    // Strict schemas can't express array bounds; enforce them here.
    const refs = (Array.isArray(i.invoices) ? (i.invoices as string[]) : []).filter((r) => typeof r === "string" && r.trim()).slice(0, 5);
    if (!refs.length) throw new Error("request_reminder_proposals needs 1 to 5 invoice references");
    const resolved = await Promise.all(refs.map(async (r) => ({ ref: r, inv: await ctx.resolve(r) })));
    const ids = resolved.filter((x) => x.inv).map((x) => x.inv!.id);
    const outcomes: ProposalOutcome[] = resolved.filter((x) => !x.inv).map((x) => ({ invoiceNumber: x.ref, invoiceId: "", outcome: "not_found", proposalId: null, detail: "no such invoice" }));
    if (ids.length) {
      try {
        const report = await withRunLock(() => runAgent({ only: ids }));
        for (const x of resolved.filter((r) => r.inv)) {
          const inv = x.inv!;
          const o = report.outcomes.find((r) => r.invoiceId === inv.id);
          const ex = report.sweep.excluded.find((e) => e.invoiceId === inv.id);
          outcomes.push(o
            ? { invoiceNumber: o.invoiceNumber, invoiceId: inv.id, outcome: o.outcome, proposalId: o.proposalId,
                detail: o.outcome === "passed" ? "draft passed review and is waiting on the Approvals page" : o.outcome === "escalated" ? "escalated to a human on the Approvals page" : "draft was blocked by review; see the Approvals page" }
            : { invoiceNumber: inv.detail.invoice_number ?? null, invoiceId: inv.id, outcome: ex ? `not_drafted:${ex.reason}` : "not_drafted:not_overdue_or_not_open", proposalId: null,
                detail: ex ? ex.detail : "the invoice is not open and past due" });
        }
        if (report.halted) outcomes.push({ invoiceNumber: null, invoiceId: "", outcome: "halted", proposalId: null, detail: report.halted.message });
      } catch (err) {
        const detail = err instanceof RunBusyError ? "another Kairos run is in progress; try again in a minute"
          : err instanceof CostCapError ? `spend cap reached: ${err.message}` : `the run failed: ${(err as Error).message}`;
        for (const x of resolved.filter((r) => r.inv)) outcomes.push({ invoiceNumber: x.inv!.detail.invoice_number ?? null, invoiceId: x.inv!.id, outcome: "failed", proposalId: null, detail });
      }
    }
    // Reasons from the pipeline can echo customer text: keep them out of `data`.
    return {
      data: { requested: refs, results: outcomes.map(({ detail: _d, ...o }) => o), approvalsPage: "/approvals", note: "Nothing has been sent. Drafts wait for approval on the Approvals page." },
      untrusted: { details: Object.fromEntries(outcomes.map((o) => [o.invoiceNumber ?? o.invoiceId, o.detail])) },
      proposals: outcomes,
    };
  },
};

/** What each proposal status means, in owner terms. */
const STATUS_MEANING: Record<string, string> = {
  pending_review: "being reviewed",
  revised: "replaced by a revised draft",
  passed: "waiting on the Approvals page (can be approved)",
  approved: "being sent right now, or the send outcome is unknown",
  blocked: "blocked by Kairos's checks; held on the Approvals page for a human",
  escalated: "escalated to a human on the Approvals page",
  sent: "sent to the customer",
  skipped: "not sent: the invoice was paid or changed before sending",
  rejected: "rejected by a human (Kairos can draft a fresh one on a later run)",
};

const AUDIT_LABEL: Record<string, string> = {
  "approval.minted": "a human approved it",
  "proposal.rejected": "a human rejected the draft",
  "proposal.resolved": "a human marked it resolved",
  "proposal.dismissed": "a human dismissed it",
  "executor.sent": "executor: reminder sent",
  "executor.dry_run": "executor: DRY RUN, all checks passed but nothing was sent (sending is switched off); the draft went back to the Approvals queue",
  "executor.deferred": "executor: deferred, not sent (quiet hours, daily cap, 7-day rule or KILL); the draft went back to the Approvals queue",
  "executor.skipped": "executor: skipped, not sent",
  "executor.failed": "executor: failed, not sent",
  "executor.unknown": "executor: outcome UNKNOWN (check PayPal)",
  "executor.blocked": "executor: blocked",
};
