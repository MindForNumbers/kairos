import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { setClockForTesting } from "../lib/clock";
import { PayPalError } from "../lib/paypal/client";
import type { Invoice } from "../lib/paypal/invoices";
import { classifySendError, executeApproval, previewExecution, setExecutorDepsForTesting, type RemindRequest } from "../lib/executor/execute";
import { sendManualReminder } from "../lib/executor/manual";
import { inQuietHours } from "../lib/executor/limits";
import { approveAndExecute, approveProposal, hashToken, liveApproval } from "../lib/queue/actions";
import { RULES_VERSION as CODE_RULES_VERSION, rulesVersionFor } from "../lib/agent/rules-version";
import { OFFERS_OFF } from "../lib/agent/policy";
/** The current rules version with no policy saved (offers off). */
const RULES_VERSION = rulesVersionFor(OFFERS_OFF);
import { assembleNote } from "../lib/agent/policy";
import type { Store } from "../lib/db";
import { isolate, loadReplay, reset } from "./helpers";

const fx = loadReplay();
const NOON_PT = "2026-11-07T20:00:00Z"; // 12:00 in America/Los_Angeles: outside quiet hours
const rec = fx.sweep.candidates.find((c) => c.invoiceNumber === "DEMO-08")!;
const NOTE = assembleNote("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026, and payment is still outstanding. Please pay the full amount now.");

const liveInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: rec.invoiceId, status: "UNPAID",
  detail: { invoice_number: "DEMO-08", currency_code: "USD", payment_term: { due_date: "2026-10-25" } },
  amount: { currency_code: "USD", value: "310.00" }, due_amount: { currency_code: "USD", value: "310.00" },
  ...over,
});

type Calls = { sends: { req: RemindRequest; requestId: string }[]; tokens: number };
let store: Store;
let calls: Calls;

function deps(over: Parameters<typeof setExecutorDepsForTesting>[0] = {}) {
  setExecutorDepsForTesting({
    fetchInvoice: async () => liveInvoice(),
    ensureToken: async () => { calls.tokens++; },
    send: async (req, requestId) => { calls.sends.push({ req, requestId }); },
    killActive: () => false,
    enabled: () => true,
    ...over,
  });
}

async function queued(opts: { rulesVersion?: string | null; note?: string } = {}) {
  const run = await store.createRun(fx.sweep);
  return store.createProposal({ runId: run.id, invoiceId: rec.invoiceId, kind: "reminder", tone: "firm", subject: "Payment required: invoice DEMO-08",
    note: opts.note ?? NOTE, status: "passed", rulesVersion: opts.rulesVersion === undefined ? RULES_VERSION : opts.rulesVersion });
}

beforeEach(() => {
  store = isolate(NOON_PT);
  calls = { sends: [], tokens: 0 };
});
afterEach(() => {
  reset();
  setExecutorDepsForTesting(null);
  delete process.env.KAIROS_DAILY_SEND_CAP;
});

test("happy path: one send, ledger written, token burned, proposal sent; token can't be reused", async () => {
  deps();
  const p = await queued();
  const { token } = await approveProposal(p.id, "user:admin");
  const r = await executeApproval(token);
  assert.equal(r.outcome, "sent", r.reason);
  assert.equal(calls.sends.length, 1);
  assert.deepEqual(calls.sends[0].req, {
    method: "POST", path: `/v2/invoicing/invoices/${rec.invoiceId}/remind`,
    body: { subject: "Payment required: invoice DEMO-08", note: NOTE, send_to_recipient: true, send_to_invoicer: false },
  });
  assert.equal((await store.getProposal(p.id))!.status, "sent");
  const ledger = await store.listLedger();
  assert.deepEqual(ledger.map((l) => [l.source, l.invoiceId, l.proposalId]), [["agent", rec.invoiceId, p.id]]);
  assert.ok((await store.listApprovals(p.id))[0].usedAt, "burned");
  assert.equal((await executeApproval(token)).outcome, "rejected");
  assert.equal(calls.sends.length, 1, "no second send");
  assert.ok((await store.listAudit({ entityType: "proposal", entityId: p.id })).some((e) => e.event === "executor.sent"));
});

test("one click: approveAndExecute never exposes the token and reports the execution", async () => {
  deps();
  const p = await queued();
  const r = await approveAndExecute(p.id, "user:admin");
  assert.equal(r.execution.outcome, "sent");
  assert.ok(!("token" in r));
});

test("dry run: every check runs, PayPal is never called, token released, proposal back to passed", async () => {
  deps({ enabled: () => false });
  const p = await queued();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "dry_run");
  assert.equal(calls.sends.length, 0);
  assert.equal(calls.tokens, 0, "doesn't even fetch an OAuth token");
  assert.equal(r.tokenReleased, true);
  assert.equal(r.request?.path, `/v2/invoicing/invoices/${rec.invoiceId}/remind`);
  assert.equal((await store.getProposal(p.id))!.status, "passed");
  assert.equal((await store.listLedger()).length, 0);
  assert.equal((await approveAndExecute(p.id, "user:admin")).execution.outcome, "dry_run", "can be approved again right away");
});

test("re-fetch: paid or cancelled invoice is skipped (terminal), nothing sent", async () => {
  for (const status of ["PAID", "MARKED_AS_PAID", "CANCELLED"] as const) {
    deps({ fetchInvoice: async () => liveInvoice({ status }) });
    const p = await queued();
    const r = (await approveAndExecute(p.id, "user:admin")).execution;
    assert.equal(r.outcome, "skipped", status);
    assert.equal((await store.getProposal(p.id))!.status, "skipped");
  }
  assert.equal(calls.sends.length, 0);
});

test("re-fetch: amount due changed since drafting (partial payment) → skipped", async () => {
  deps({ fetchInvoice: async () => liveInvoice({ status: "PARTIALLY_PAID", due_amount: { currency_code: "USD", value: "110.00" } }) });
  const p = await queued();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "skipped");
  assert.match(r.reason, /no longer matches the invoice \(now: DEMO-08, \$110\.00/);
  assert.equal(calls.sends.length, 0);
});

test("quiet hours: deferred, nothing sent, draft stays approvable", async () => {
  setClockForTesting("2026-11-08T06:30:00Z"); // 22:30 PT
  deps();
  const p = await queued();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "deferred");
  assert.match(r.reason, /quiet hours/);
  assert.equal(calls.sends.length, 0);
  assert.equal((await store.getProposal(p.id))!.status, "passed");
  assert.equal(liveApproval(await store.listApprovals(p.id)), undefined, "token released");
  assert.equal(inQuietHours(7 * 60 + 59), true);
  assert.equal(inQuietHours(8 * 60), false);
  assert.equal(inQuietHours(20 * 60 + 59), false);
  assert.equal(inQuietHours(21 * 60), true);
});

test("daily cap counts manual sends too", async () => {
  process.env.KAIROS_DAILY_SEND_CAP = "1";
  deps();
  await store.recordManualSend({ invoiceId: "INV2-OTHER", subject: null, note: null, actor: "user:admin" });
  const p = await queued();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "deferred");
  assert.match(r.reason, /daily cap: 1 of 1 sent today/);
  assert.equal(calls.sends.length, 0);
});

test("7-day rule: a reminder (even manual) within 7 days defers the agent send", async () => {
  deps();
  setClockForTesting("2026-11-05T20:00:00Z");
  await store.recordManualSend({ invoiceId: rec.invoiceId, subject: null, note: null, actor: "user:admin" });
  setClockForTesting(NOON_PT);
  const p = await queued();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "deferred");
  assert.match(r.reason, /cooldown/);
  assert.equal(calls.sends.length, 0);
});

test("KILL: before the claim (token untouched) and appearing mid-checks (token released)", async () => {
  deps({ killActive: () => true });
  const p = await queued();
  const r1 = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r1.outcome, "deferred");
  assert.ok(!(await store.listApprovals(p.id))[0].claimedAt, "never claimed");

  let n = 0;
  deps({ killActive: () => n++ > 0 }); // clear at the start, present right before sending
  const r2 = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r2.outcome, "deferred");
  assert.equal(r2.steps.at(-1)!.name, "kill_again");
  assert.equal(r2.tokenReleased, true);
  assert.equal(calls.sends.length, 0);
});

test("PayPal 4xx / connection refused / auth failure: definitely not sent → token released, draft approvable again", async () => {
  const cases: [string, Parameters<typeof deps>[0]][] = [
    ["422", { send: async () => { throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "nope", "dbg422"); } }],
    ["429", { send: async () => { throw new PayPalError(429, "RATE_LIMIT_REACHED", "slow down", "dbg429"); } }],
    ["ECONNREFUSED", { send: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } }],
    ["auth", { ensureToken: async () => { throw new Error("invalid_client"); } }],
  ];
  for (const [name, over] of cases) {
    deps(over);
    const p = await queued();
    const r = (await approveAndExecute(p.id, "user:admin")).execution;
    assert.equal(r.outcome, "failed", name);
    assert.equal(r.tokenReleased, true, name);
    assert.equal((await store.getProposal(p.id))!.status, "passed", name);
    await store.updateProposalStatus(p.id, { status: "rejected" }, ["passed"]); // tidy for the next case
  }
  assert.equal((await store.listLedger()).length, 0);
});

test("PayPal 5xx / timeout / connection reset: outcome UNKNOWN → no release, no retry, blocked for a human", async () => {
  const cases: [string, () => never][] = [
    ["503", () => { throw new PayPalError(503, "SERVICE_UNAVAILABLE", "try later", "dbg503"); }],
    ["timeout", () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }],
    ["reset", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }],
  ];
  for (const [name, boom] of cases) {
    let attempts = 0;
    deps({ send: async () => { attempts++; boom(); } });
    const p = await queued();
    const r = (await approveAndExecute(p.id, "user:admin")).execution;
    assert.equal(r.outcome, "unknown", name);
    assert.equal(attempts, 1, `${name}: exactly one attempt`);
    assert.equal(r.tokenReleased, false, name);
    const after = (await store.getProposal(p.id))!;
    assert.equal(after.status, "blocked", name);
    assert.match(after.reason!, /^Send outcome UNKNOWN/);
    assert.ok(liveApproval(await store.listApprovals(p.id)), `${name}: token stays claimed`);
  }
  assert.equal((await store.listLedger()).length, 0);
});

test("integrity: stale rules or a tampered approval are blocked even with a valid token", async () => {
  deps();
  const old = await queued({ rulesVersion: "r-000000000000" });
  await store.updateProposalStatus(old.id, { status: "approved" }, ["passed"]);
  await store.createApproval({ proposalId: old.id, tokenHash: hashToken("t-stale"), draftHash: old.draftHash, approvedBy: "user:admin", ttlMs: 900_000 });
  const r1 = await executeApproval("t-stale");
  assert.equal(r1.outcome, "blocked");
  assert.match(r1.reason, /stale rules/);

  const p = await queued();
  await store.updateProposalStatus(p.id, { status: "approved" }, ["passed"]);
  await store.createApproval({ proposalId: p.id, tokenHash: hashToken("t-wrong-hash"), draftHash: "0".repeat(64), approvedBy: "user:admin", ttlMs: 900_000 });
  const r2 = await executeApproval("t-wrong-hash");
  assert.equal(r2.outcome, "blocked");
  assert.match(r2.reason, /hash mismatch/);
  assert.equal(calls.sends.length, 0);
});

test("preview: read-only plan with the exact request, no claim, no send", async () => {
  deps({ enabled: () => false });
  const p = await queued();
  const r = await previewExecution(p.id);
  assert.equal(r.outcome, "dry_run");
  assert.deepEqual(r.steps.map((s) => [s.name, s.ok]), [
    ["draft_hash", true], ["rules_version", true], ["refetch_invoice", true], ["facts_unchanged", true],
    ["kill", true], ["cooldown", true], ["daily_cap", true], ["quiet_hours", true],
  ]);
  assert.equal(r.request?.body.note, NOTE);
  assert.equal((await store.listApprovals(p.id)).length, 0);
  assert.equal((await store.getProposal(p.id))!.status, "passed");
});

test("manual reminders: KILL halts; limits warn until confirmed; one attempt; ledger written", async () => {
  deps({ killActive: () => true });
  assert.equal((await sendManualReminder(rec.invoiceId, {}, { actor: "user:admin", confirmed: true })).status, "halted");

  deps();
  const first = await sendManualReminder(rec.invoiceId, { note: "Friendly nudge" }, { actor: "user:admin", confirmed: false });
  assert.equal(first.status, "sent", "no warnings the first time");
  const second = await sendManualReminder(rec.invoiceId, {}, { actor: "user:admin", confirmed: false });
  assert.equal(second.status, "needs_confirmation");
  assert.match((second as { warnings: string[] }).warnings[0], /Reminded within the last 7 days/);
  const third = await sendManualReminder(rec.invoiceId, {}, { actor: "user:admin", confirmed: true });
  assert.equal(third.status, "sent");
  assert.equal(calls.sends.length, 2);
  assert.deepEqual(calls.sends[0].req.body, { subject: undefined, note: "Friendly nudge", send_to_recipient: true, send_to_invoicer: false });
  assert.deepEqual((await store.listLedger()).map((l) => l.source), ["manual", "manual"]);
});

test("classifySendError", () => {
  assert.equal(classifySendError(new PayPalError(400, "INVALID_REQUEST", "x")).sent, "no");
  assert.equal(classifySendError(new PayPalError(500, "INTERNAL_SERVER_ERROR", "x")).sent, "unknown");
  assert.equal(classifySendError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })).sent, "no");
  assert.equal(classifySendError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })).sent, "unknown");
  assert.equal(classifySendError(new SyntaxError("Unexpected token")).sent, "unknown");
});
