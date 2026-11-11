// Stage 1 (incentives): owner-defined payment plans ("pay in parts", PayPal partial payments).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, type KnownInvoice } from "../lib/agent/checks";
import { buildDrafterUser, reconcile, type Draft } from "../lib/agent/drafter";
import { buildCriticUser } from "../lib/agent/critic";
import { currentPolicy } from "../lib/agent/incentives";
import {
  OFFERS_OFF, assembleNote, offerFor, offerSentence, offerTerms, paymentPlanPolicySchema, planFor, type DraftPlan, type Offer, type PaymentPlanPolicy,
} from "../lib/agent/policy";
import { currentRulesVersion, rulesVersionFor } from "../lib/agent/rules-version";
import type { InvoiceRecord } from "../lib/agent/sweep";
import { executeApproval, partialPaymentUpdate, previewExecution, setExecutorDepsForTesting, type RemindRequest } from "../lib/executor/execute";
import { approveAndExecute, approveProposal, QueueError } from "../lib/queue/actions";
import { PayPalError } from "../lib/paypal/client";
import type { Invoice } from "../lib/paypal/invoices";
import { hashDraft, type Store } from "../lib/db";
import { createHash } from "node:crypto";
import { cleanDrafts, isolate, loadReplay, passAll, reset, stubModels, tagJson } from "./helpers";
import { runAgent } from "../lib/agent/pipeline";

const POLICY: PaymentPlanPolicy = { enabled: true, minInvoiceAmount: 500, minDaysOverdue: 7, maxParts: 3, minPaymentAmount: 100 };

const rec = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  invoiceId: "INV2-6", invoiceNumber: "DEMO-06", status: "SENT", currency: "USD", amountTotal: "2350.00", amountDue: "2350.00", amountPaid: null,
  invoiceDate: "2026-08-20", dueDate: "2026-09-19", daysOverdue: 48, recipientEmail: "c@example.com", lastReminderAt: null, severity: 3,
  untrusted: { recipientName: "Morgan Late", note: null, items: [] }, flags: [], ...over,
});
const R6 = rec();
const BODY = "Hello, this is a final notice for invoice DEMO-06 for $2,350.00, which was due September 19, 2026. Please pay promptly.";
const known: KnownInvoice[] = [{ invoiceId: R6.invoiceId, invoiceNumber: R6.invoiceNumber, amountDue: R6.amountDue, currency: "USD", recipientEmail: R6.recipientEmail, recipientName: R6.untrusted.recipientName }];
const draftPlan = (r: InvoiceRecord, p = POLICY) => planFor(r, p) as Extract<DraftPlan, { action: "draft" }>;
const mk = (body: string, offer: Offer | null, choice: "payment_plan" | "none" = offer ? "payment_plan" : "none"): Draft =>
  ({ invoiceId: R6.invoiceId, kind: "reminder", tone: "final_notice", subject: "Final notice: invoice DEMO-06", note: assembleNote(body, offer), offer, offerChoice: choice });
const checksOf = (d: Draft, plan = draftPlan(R6)) => checkDraft(d, plan, known).map((i) => `${i.check}: ${i.problem}`);

// ---- terms and eligibility (pure) -------------------------------------------------------

test("offer terms: minimum is the policy minimum raised so the balance never needs more than maxParts; cents, rounded up", () => {
  assert.deepEqual(offerTerms("2350.00", "USD", POLICY), { kind: "payment_plan", parts: 3, minimumAmount: "783.34", currency: "USD" });
  assert.deepEqual(offerTerms("640.00", "USD", { ...POLICY, minPaymentAmount: 250 }), { kind: "payment_plan", parts: 3, minimumAmount: "250.00", currency: "USD" });
  assert.deepEqual(offerTerms("400.00", "USD", { ...POLICY, maxParts: 4, minPaymentAmount: 150 }), { kind: "payment_plan", parts: 3, minimumAmount: "150.00", currency: "USD" }, "fewer parts when the minimum payment binds");
  assert.equal(offerTerms("150.00", "USD", { ...POLICY, minPaymentAmount: 100 })!.parts, 2);
  assert.equal(offerTerms("100.00", "USD", { ...POLICY, minPaymentAmount: 100 }), null, "one part is not a plan");
  for (const amt of ["0.03", "999.99", "2350.00", "10000.01"]) {
    const o = offerTerms(amt, "USD", { ...POLICY, minPaymentAmount: 0.01 * 100 });
    if (o) assert.ok(o.parts <= POLICY.maxParts && Number(o.minimumAmount) * o.parts >= Number(amt), amt);
  }
  assert.equal(offerSentence(offerTerms("2350.00", "USD", POLICY)!), "You can pay this invoice in up to 3 parts of at least $783.34 each.");
});

test("eligibility is code's: off, flagged text, too small, too new → no offer, with the reason", () => {
  assert.ok(offerFor(R6, POLICY).offer);
  assert.match(offerFor(R6, OFFERS_OFF).why, /off/);
  assert.match(offerFor(rec({ flags: ["concession_request"] }), POLICY).why, /flagged/);
  assert.match(offerFor(rec({ amountDue: "499.99" }), POLICY).why, /under \$500/);
  assert.match(offerFor(rec({ daysOverdue: 6 }), POLICY).why, /less than 7 days/);
  assert.equal(draftPlan(R6, OFFERS_OFF).offer, null, "planFor defaults to offers off");
  assert.equal((planFor(R6) as Extract<DraftPlan, { action: "draft" }>).offer, null);
});

test("policy schema: bounds enforced, unknown keys refused", () => {
  assert.ok(paymentPlanPolicySchema.safeParse(POLICY).success);
  assert.equal(paymentPlanPolicySchema.safeParse({ ...POLICY, maxParts: 1 }).success, false);
  assert.equal(paymentPlanPolicySchema.safeParse({ ...POLICY, minDaysOverdue: 61 }).success, false, "over 60 days always goes to a human");
  assert.equal(paymentPlanPolicySchema.safeParse({ ...POLICY, minPaymentAmount: 0 }).success, false);
  assert.equal(paymentPlanPolicySchema.safeParse({ ...POLICY, discountPercent: 50 }).success, false);
});

// ---- drafter: chooses, never writes terms ------------------------------------------------

test("drafter: sees only offerAllowed; code attaches the terms only when chosen AND eligible", () => {
  const eligible = draftPlan(R6);
  const ineligible = draftPlan(rec({ invoiceId: "INV2-5", invoiceNumber: "DEMO-05", amountDue: "640.00", daysOverdue: 6, dueDate: "2026-10-31" }));
  const user = buildDrafterUser([eligible, ineligible]);
  assert.match(user, /"offerAllowed": true/);
  assert.match(user, /"offerAllowed": false/);
  assert.doesNotMatch(user, /783\.34|minimumAmount|"parts"/, "the drafter never sees the terms");

  const out = { drafts: cleanDrafts(user, {}, ["DEMO-06", "DEMO-05"]).drafts as never };
  const r = reconcile([eligible, ineligible], out, null);
  const d6 = r.drafts.find((d) => d.invoiceId === "INV2-6")!;
  const d5 = r.drafts.find((d) => d.invoiceId === "INV2-5")!;
  assert.deepEqual(d6.offer, eligible.offer);
  assert.ok(d6.note.includes(`\n\n${offerSentence(eligible.offer!)}\n\nYou can view and pay`), "sentence sits before the fixed closing");
  assert.equal(d5.offer, null);
  assert.equal(d5.offerChoice, "payment_plan");
  assert.ok(checkDraft(d5, ineligible, known).some((i) => i.check === "b" && /outside the owner's policy/.test(i.problem)), "an ineligible request is a (b) block");
});

// ---- check (b): only the code-rendered sentence -------------------------------------------

test("(b): the exact policy offer passes; anything else about parts or instalments blocks", () => {
  const offer = draftPlan(R6).offer!;
  assert.deepEqual(checksOf(mk(BODY, offer)), []);
  assert.deepEqual(checksOf(mk(BODY, null)), [], "no offer is always fine");
  // The drafter writes the offer itself (no terms attached).
  assert.ok(checksOf(mk(`${BODY} You can pay this invoice in up to 3 parts of at least $783.34 each.`, null)).some((s) => s.startsWith("b:")));
  assert.ok(checksOf(mk(`${BODY} You could also pay it in parts.`, null)).some((s) => s.startsWith("b: offer wording")));
  assert.ok(checksOf(mk(`${BODY} Smaller payments are fine.`, null)).some((s) => s.startsWith("b:")));
  assert.ok(checksOf(mk(`${BODY} We can set up a payment plan.`, null)).some((s) => s.startsWith("b: concession")));
  // A second copy, an edited copy, or the sentence with no terms attached.
  assert.ok(checksOf(mk(`${BODY} ${offerSentence(offer)}`, offer)).some((s) => s.startsWith("b:")), "duplicate");
  const edited = { ...mk(BODY, offer), note: mk(BODY, offer).note.replace("up to 3 parts", "up to 4 parts") };
  assert.ok(checksOf(edited).some((s) => s.includes("exact offer sentence")));
  // Over the limit, and offers on a policy that is now off.
  const over: Offer = { ...offer, parts: 6, minimumAmount: "391.67" };
  assert.ok(checksOf(mk(BODY, over)).some((s) => /differ from the owner's policy/.test(s)));
  assert.ok(checksOf(mk(BODY, offer), draftPlan(R6, OFFERS_OFF)).some((s) => /payment plans are off/.test(s)));
  // The 50% demand is still a block, offer or not.
  assert.ok(checksOf(mk(`${BODY} We can take 50% off.`, offer)).some((s) => s.startsWith("b: concession")));
});

test("critic gets the policy and each invoice's one allowed sentence (or null)", () => {
  const plans = [draftPlan(R6), draftPlan(rec({ invoiceId: "INV2-8", invoiceNumber: "DEMO-08", amountDue: "310.00", flags: ["concession_request"] }))];
  const user = buildCriticUser({ records: plans.map((p) => p.record), plans, deferred: [], underReview: [], alreadyCovered: [], policy: POLICY });
  assert.match(user, /"allowedOffer": "You can pay this invoice in up to 3 parts of at least \$783\.34 each\."/);
  assert.match(user, /"allowedOffer": null/);
  assert.match(user, /<offer_policy>[\s\S]*"maxParts": 3[\s\S]*<\/offer_policy>/);
  assert.match(buildCriticUser({ records: [], plans: [], deferred: [], underReview: [], alreadyCovered: [] }), /"paymentPlans": "off"/);
});

// ---- storage, hash, rules version -----------------------------------------------------------

let store: Store;
beforeEach(() => { store = isolate("2026-11-07T20:00:00Z"); });
afterEach(() => { reset(); setExecutorDepsForTesting(null); });

test("hash: drafts without an offer hash exactly as before; the offer is part of the approved content", () => {
  const base = { invoiceId: "I", kind: "reminder" as const, tone: "firm", subject: "S", note: "N" };
  assert.equal(hashDraft(base), hashDraft({ ...base, offer: null }));
  const v1 = createHash("sha256").update("kairos-draft-v1\0").update(JSON.stringify(["I", "reminder", "firm", "S", "N"])).digest("hex");
  assert.equal(hashDraft(base), v1, "v1 formula unchanged, so existing approvals stay valid");
  const o: Offer = { kind: "payment_plan", parts: 3, minimumAmount: "783.34", currency: "USD" };
  assert.notEqual(hashDraft({ ...base, offer: o }), hashDraft(base));
  assert.notEqual(hashDraft({ ...base, offer: o }), hashDraft({ ...base, offer: { ...o, minimumAmount: "783.35" } }));
});

test("policy: append-only versions, latest wins, off until saved; saving a change changes the rules version", async () => {
  assert.deepEqual((await currentPolicy()).policy, OFFERS_OFF);
  const v0 = await currentRulesVersion();
  assert.equal(v0, rulesVersionFor(OFFERS_OFF));
  await store.appendIncentivePolicy({ policy: { paymentPlan: POLICY }, actor: "user:admin" });
  const v1 = await currentRulesVersion();
  assert.notEqual(v1, v0);
  await store.appendIncentivePolicy({ policy: { paymentPlan: { ...POLICY, maxParts: 4 } }, actor: "user:admin" });
  assert.equal((await currentPolicy()).policy.maxParts, 4);
  assert.equal((await currentPolicy()).version, 2);
  assert.notEqual(await currentRulesVersion(), v1);
  assert.equal((await store.listIncentivePolicies()).length, 2);
  assert.ok((await store.listAudit({ entityType: "incentive_policy" })).length === 2);
  await store.appendIncentivePolicy({ policy: { paymentPlan: { garbage: true } }, actor: "user:admin" });
  assert.equal((await currentPolicy()).policy.enabled, false, "an unreadable policy means offers off");
});

// ---- executor: enable partial payment, then remind -------------------------------------------

const liveInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: R6.invoiceId, status: "SENT",
  detail: { invoice_number: "DEMO-06", currency_code: "USD", payment_term: { due_date: "2026-09-19" } },
  amount: { currency_code: "USD", value: "2350.00" }, due_amount: { currency_code: "USD", value: "2350.00" },
  configuration: { allow_tip: false, template_id: "TEMP-1" },
  ...over,
});
type Ev = { kind: "enable"; body: Invoice } | { kind: "send"; req: RemindRequest };

async function offerProposal(offer: Offer | null = offerTerms("2350.00", "USD", POLICY)) {
  await store.appendIncentivePolicy({ policy: { paymentPlan: POLICY }, actor: "user:admin" });
  const run = await store.createRun({});
  return store.createProposal({ runId: run.id, invoiceId: R6.invoiceId, kind: "reminder", tone: "final_notice", subject: "Final notice: invoice DEMO-06",
    note: assembleNote(BODY, offer), offer, status: "passed", rulesVersion: await currentRulesVersion() });
}
function deps(events: Ev[], over: Parameters<typeof setExecutorDepsForTesting>[0] = {}) {
  setExecutorDepsForTesting({
    fetchInvoice: async () => liveInvoice(),
    ensureToken: async () => {},
    send: async (req) => { events.push({ kind: "send", req }); },
    enablePartialPayment: async (inv, offer) => { events.push({ kind: "enable", body: partialPaymentUpdate(inv, offer) }); },
    killActive: () => false,
    enabled: () => true,
    ...over,
  });
}

test("executor: turns on partial payments with the approved minimum (keeping the invoice's other settings), THEN sends the reminder", async () => {
  const ev: Ev[] = [];
  deps(ev);
  const p = await offerProposal();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "sent", r.reason);
  assert.deepEqual(ev.map((e) => e.kind), ["enable", "send"]);
  const body = (ev[0] as { body: Invoice }).body;
  assert.deepEqual(body.configuration, { allow_tip: false, template_id: "TEMP-1", partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: "USD", value: "783.34" } } });
  assert.equal(body.id, R6.invoiceId);
  assert.ok((ev[1] as { req: RemindRequest }).req.body.note!.includes("up to 3 parts of at least $783.34"));
  assert.ok(r.steps.some((s) => s.name === "offer_terms" && s.ok));
  assert.ok((await store.listAudit({ entityType: "proposal", entityId: p.id })).some((a) => a.event === "executor.partial_payment_enabled"));
});

test("executor: already enabled with the same minimum (a retry) → no second update", async () => {
  const ev: Ev[] = [];
  deps(ev, { fetchInvoice: async () => liveInvoice({ configuration: { partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: "USD", value: "783.34" } } } }) });
  const p = await offerProposal();
  assert.equal((await approveAndExecute(p.id, "user:admin")).execution.outcome, "sent");
  assert.deepEqual(ev.map((e) => e.kind), ["send"]);
});

test("executor: dry run never updates the invoice", async () => {
  const ev2: Ev[] = [];
  deps(ev2, { enabled: () => false });
  const q = await offerProposal();
  assert.equal((await approveAndExecute(q.id, "user:admin")).execution.outcome, "dry_run");
  assert.deepEqual(ev2, []);
  assert.equal((await previewExecution(q.id)).outcome, "dry_run");
});

test("executor: a reminder without an offer never updates the invoice", async () => {
  const ev3: Ev[] = [];
  deps(ev3);
  const plain = await offerProposal(null);
  assert.equal((await approveAndExecute(plain.id, "user:admin")).execution.outcome, "sent");
  assert.deepEqual(ev3.map((e) => e.kind), ["send"]);
});

test("executor: enabling definitely failed → reminder NOT sent, token released; outcome unknown → no release, blocked", async () => {
  const ev: Ev[] = [];
  deps(ev, { enablePartialPayment: async () => { throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "nope", "dbg-1"); } });
  const p = await offerProposal();
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "failed");
  assert.match(r.reason, /reminder was not sent/);
  assert.equal(r.tokenReleased, true);
  assert.deepEqual(ev, [], "no reminder");
  assert.equal((await store.getProposal(p.id))!.status, "passed", "approvable again");

  for (const err of [new PayPalError(503, "SERVICE_UNAVAILABLE", "x"), Object.assign(new Error("t"), { name: "TimeoutError" })]) {
    const ev2: Ev[] = [];
    deps(ev2, { enablePartialPayment: async () => { throw err; } });
    const q = await offerProposal();
    const u = (await approveAndExecute(q.id, "user:admin")).execution;
    assert.equal(u.outcome, "unknown", err.name);
    assert.equal(u.tokenReleased, false);
    assert.match(u.reason, /partial payments may or may not have been enabled\. The reminder was NOT sent/);
    assert.deepEqual(ev2, []);
    assert.equal((await store.getProposal(q.id))!.status, "blocked");
  }
});

test("a policy change makes waiting offer drafts stale: can't be approved, and the executor blocks a held token", async () => {
  const ev: Ev[] = [];
  deps(ev);
  const p = await offerProposal();
  const { token } = await approveProposal(p.id, "user:admin");
  await store.appendIncentivePolicy({ policy: { paymentPlan: { ...POLICY, maxParts: 2 } }, actor: "user:admin" });
  const r = await executeApproval(token);
  assert.equal(r.outcome, "blocked");
  assert.match(r.reason, /stale rules/);
  assert.deepEqual(ev, []);
  const q = await store.createProposal({ runId: p.runId, invoiceId: R6.invoiceId, kind: "reminder", tone: "final_notice", subject: "S", note: "N", status: "passed", rulesVersion: p.rulesVersion });
  await assert.rejects(approveProposal(q.id, "user:admin"), (e: QueueError) => e.code === "STALE_RULES");
});

test("executor: the approved terms are re-derived from the live balance and current policy", async () => {
  const ev: Ev[] = [];
  deps(ev);
  // Approved terms that the policy would not produce (e.g. a forged row with a valid rules stamp).
  const p = await offerProposal({ kind: "payment_plan", parts: 6, minimumAmount: "391.67", currency: "USD" });
  const r = (await approveAndExecute(p.id, "user:admin")).execution;
  assert.equal(r.outcome, "blocked");
  assert.ok(r.steps.some((s) => s.name === "offer_terms" && !s.ok));
  assert.deepEqual(ev, []);
});

test("pipeline (stubbed models, policy on): the offer reaches Approvals with its terms; an ineligible request is blocked; the 50% injection invoice gets no offer", async () => {
  const fx = loadReplay();
  store = isolate(fx.sweep.asOf);
  await store.appendIncentivePolicy({ policy: { paymentPlan: POLICY }, actor: "user:admin" });
  let drafterSaw = "";
  stubModels({
    drafter: (req) => { drafterSaw = req.user; return { json: cleanDrafts(req.user, {}, ["DEMO-06", "DEMO-05", "DEMO-08"]) }; },
    critic: (req) => ({ json: passAll(req.user) }),
  });
  const report = await runAgent({ sweep: async () => fx.sweep });
  const outcome = Object.fromEntries(report.outcomes.map((o) => [o.invoiceNumber, o.outcome]));
  assert.equal(outcome["DEMO-06"], "passed");
  assert.equal(outcome["DEMO-05"], "blocked", "asked for an offer the policy doesn't allow");
  assert.equal(outcome["DEMO-08"], "blocked", "flagged invoice: no offers");
  assert.equal(report.rulesVersion, rulesVersionFor(POLICY));
  const facts = tagJson<{ invoiceNumber: string; offerAllowed: boolean }[]>(drafterSaw, "invoices_to_draft");
  assert.deepEqual(facts.filter((f) => f.offerAllowed).map((f) => f.invoiceNumber), ["DEMO-06"]);

  const [p6] = await store.listProposals({ status: ["passed"] });
  assert.deepEqual(p6.offer, { kind: "payment_plan", parts: 3, minimumAmount: "783.34", currency: "USD" });
  assert.equal(p6.rulesVersion, rulesVersionFor(POLICY));
  assert.ok(p6.note!.includes("You can pay this invoice in up to 3 parts of at least $783.34 each."));
  assert.equal(p6.draftHash, hashDraft(p6));
  const blocked = await store.listProposals({ status: ["blocked"] });
  assert.ok(blocked.every((b) => /outside the owner's policy/.test(b.reason ?? "")), blocked.map((b) => b.reason).join(" | "));
});
