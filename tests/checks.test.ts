import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCoverage, checkDraft, type KnownInvoice } from "../lib/agent/checks";
import { assembleNote, planFor, type DraftPlan } from "../lib/agent/policy";
import type { InvoiceRecord } from "../lib/agent/sweep";
import type { Draft } from "../lib/agent/drafter";

const rec = (id: string, num: string, amount: string, due: string, days: number, name = "Taylor Inject"): InvoiceRecord => ({
  invoiceId: id, invoiceNumber: num, status: "SENT", currency: "USD", amountTotal: amount, amountDue: amount, amountPaid: null,
  invoiceDate: null, dueDate: due, daysOverdue: days, recipientEmail: `${num}@example.com`, lastReminderAt: null, severity: 2,
  untrusted: { recipientName: name, note: null, items: [] }, flags: [],
});
const R8 = rec("INV2-8", "DEMO-08", "310.00", "2026-10-25", 12);
const R7 = rec("INV2-7", "DEMO-07", "380.00", "2026-08-23", 75, "Casey Late");
const plan = planFor(R8) as Extract<DraftPlan, { action: "draft" }>;
const known: KnownInvoice[] = [R8, R7].map((r) => ({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, amountDue: r.amountDue, currency: "USD", recipientEmail: r.recipientEmail, recipientName: r.untrusted.recipientName }));
const mk = (body: string, subject = "Payment required for invoice DEMO-08"): Draft => ({ invoiceId: "INV2-8", kind: "reminder", tone: "firm", subject, note: assembleNote(body) });
const checks = (d: Draft) => checkDraft(d, plan, known).map((i) => i.check).sort().join("");

test("clean draft passes all code checks", () => {
  assert.deepEqual(checkDraft(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026, and payment is still outstanding. Please pay the full amount now."), plan, known), []);
});

test("(a) missing or wrong facts, day counts, durations, email description, threats, word limit", () => {
  assert.equal(checks(mk("Hello, invoice DEMO-08 for $301.00 was due October 25, 2026.")), "aa");           // wrong amount: missing + stated
  assert.equal(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026, now 12 days overdue.")), "a");
  assert.equal(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026, for some time now.")), "a");
  assert.equal(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. Click the button below.")), "a");
  assert.equal(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026, or late fees apply.")), "a");
  assert.equal(checks(mk(`Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. ${"word ".repeat(60)}`)), "a");
});

test("(b) concessions, status claims and new deadlines", () => {
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. We can offer a 50% discount.")), /b/);
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 due October 25, 2026 has been marked as paid.")), /b/);
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. Please pay by November 30, 2026.")), /b/);
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. No rush, take your time.")), /b/);
  assert.equal(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026 and remains unpaid.")), "", "'unpaid' is not a paid claim");
});

test("(c) another customer's invoice, amount, name or email", () => {
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. DEMO-07 is also outstanding.")), /c/);
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026, plus $380.00.")), /c/);
  assert.match(checks(mk("Hello Casey Late, invoice DEMO-08 for $310.00 was due October 25, 2026.")), /c/);
  assert.match(checks(mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026. Reply to billing@example.com.")), /c/);
});

test("(d) tone mismatch; (e) coverage", () => {
  assert.equal(checks({ ...mk("Hello, invoice DEMO-08 for $310.00 was due October 25, 2026."), tone: "friendly" }), "d");
  const plans = [planFor(R8), planFor(R7)];
  assert.deepEqual(checkCoverage(plans, new Set()).map((x) => x.invoiceId), ["INV2-8"], "policy escalations aren't drafts to cover");
  assert.deepEqual(checkCoverage(plans, new Set(["INV2-8"])), []);
});
