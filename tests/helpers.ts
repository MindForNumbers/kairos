import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStoreForTesting, setStoreForTesting, type Store } from "../lib/db";
import { setClockForTesting } from "../lib/clock";
import { setTransportForTesting, type TransportRequest, type TransportResponse } from "../lib/llm/client";
import type { Issue } from "../lib/agent/checks";
import type { Draft } from "../lib/agent/drafter";
import { CLOSING_LINE } from "../lib/agent/policy";
import type { InvoiceRecord, SweepResult } from "../lib/agent/sweep";

export type ReplayCase = {
  id: string;
  invoiceNumber: string;
  origin: string;
  draft: Draft | null;
  recordedCritic: Issue[] | null;
  expect: { decision: "passed" | "revise" | "blocked"; criticFails: string[]; codeFails: string[] };
};
export type ReplayFixture = { source: string; sweep: SweepResult; cases: ReplayCase[] };

export function loadReplay(): ReplayFixture {
  return JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/replay.json"), "utf8"));
}

export const recordOf = (s: SweepResult, n: string): InvoiceRecord => s.candidates.find((c) => c.invoiceNumber === n)!;

/** The model-written body of a stored note (everything before the fixed closing). */
export const bodyOf = (note: string) => note.slice(0, note.indexOf(`\n\n${CLOSING_LINE}`));

/** Fresh temp DB as the process store, and the clock pinned to the fixture's sweep time. */
export function isolate(asOf: string): Store {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kairos-test-"));
  const store = openStoreForTesting(join(dir, "test.db"));
  setStoreForTesting(store);
  setClockForTesting(asOf);
  return store;
}

export function reset(): void {
  setStoreForTesting(null);
  setClockForTesting(null);
  setTransportForTesting(null);
}

/** Pull the JSON inside <tag>…</tag> from a prompt. */
export function tagJson<T>(user: string, tag: string): T {
  const m = user.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!m) throw new Error(`no <${tag}> in prompt`);
  return JSON.parse(m[1]);
}

type Handler = (req: TransportRequest, call: number) => { json?: unknown; refusal?: boolean; usage?: Partial<TransportResponse["usage"]> };

/** Stub the model API: one handler per purpose. Records every request. */
export function stubModels(handlers: { drafter: Handler; critic: Handler }) {
  const calls: { purpose: string; model: string; user: string }[] = [];
  const counts: Record<string, number> = { drafter: 0, critic: 0 };
  setTransportForTesting(async (req) => {
    const h = handlers[req.purpose as "drafter" | "critic"];
    if (!h) throw new Error(`unexpected model call: ${req.purpose}`);
    calls.push({ purpose: req.purpose, model: req.model, user: req.user });
    const out = h(req, counts[req.purpose]++);
    return {
      model: req.model,
      requestId: `req_stub_${req.purpose}_${counts[req.purpose]}`,
      stopReason: out.refusal ? "refusal" : "end_turn",
      refusalCategory: out.refusal ? "general_harms" : null,
      usage: { inputTokens: 3000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, ...out.usage },
      text: out.refusal ? null : JSON.stringify(out.json),
    };
  });
  return { calls, counts };
}

/** A critic answer that passes every draft under review and reports no omissions. */
export function passAll(user: string) {
  const drafts = tagJson<{ invoiceId: string }[]>(user, "drafts_under_review");
  const ok = { pass: true, problem: null };
  return {
    reviews: drafts.map((d) => ({ invoiceId: d.invoiceId, a_facts_match: ok, b_no_concessions: ok, c_no_other_customer_data: ok, d_traces_to_one_overdue_invoice: ok })),
    e_omitted: [] as { invoiceId: string; problem: string }[],
    urgency_warnings: [] as unknown[],
  };
}

/** A clean drafter answer for every invoice in the prompt. */
export function cleanDrafts(user: string, override: Record<string, string | null> = {}) {
  const facts = tagJson<{ invoiceId: string; invoiceNumber: string; amountDue: string; dueDate: string }[]>(user, "invoices_to_draft");
  return {
    drafts: facts
      .filter((f) => override[f.invoiceNumber] !== null)
      .map((f) => ({
        invoiceId: f.invoiceId, action: "remind", subject: `Payment reminder: invoice ${f.invoiceNumber}`,
        body: override[f.invoiceNumber] ?? `Hello, invoice ${f.invoiceNumber} for ${f.amountDue} was due ${f.dueDate}. Please make payment now.`,
        escalationReason: null,
      })),
  };
}
