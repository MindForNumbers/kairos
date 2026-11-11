import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Invoice } from "../lib/paypal/invoices";
import type { Store } from "../lib/db";
import { daysToPayment, handleInvoiceEvent, setWebhookInvoiceFetchForTesting } from "../lib/webhooks/invoice-events";
import { closeProposalsForInvoice } from "../lib/queue/close";
import { authorizeCron } from "../lib/cron";
import { CUSTOMERS, demoNumber, demoStamp, isDemoNumber, issueDate, parseEmails, paymentDate } from "../lib/demo/reset";
import { isolate, reset } from "./helpers";

let store: Store;
beforeEach(() => { store = isolate("2026-11-10T20:00:00Z"); });
afterEach(() => { reset(); setWebhookInvoiceFetchForTesting(null); delete process.env.KAIROS_CRON_SECRET; });

async function proposal(invoiceId: string, status: "passed" | "approved" | "escalated" | "blocked" | "sent") {
  const run = (await store.listRuns(1))[0] ?? (await store.createRun({}));
  const p = await store.createProposal({ runId: run.id, invoiceId, kind: status === "escalated" ? "escalate" : "reminder", tone: "friendly", subject: "S", note: "N", status: status === "sent" ? "passed" : status });
  if (status === "sent") await store.updateProposalStatus(p.id, { status: "sent" });
  return p.id;
}

const paidInvoice: Invoice = {
  id: "INV2-PAID", status: "PAID",
  detail: { invoice_number: "TS-261110-1043", currency_code: "USD", invoice_date: "2026-11-04", payment_term: { due_date: "2026-11-07" } },
  payments: { paid_amount: { currency_code: "USD", value: "250.00" }, transactions: [{ payment_date: "2026-11-09", method: "PAYPAL", amount: { currency_code: "USD", value: "250.00" } }] },
};

test("webhook PAID: closes open proposals (waiting → skipped, escalated → dismissed), leaves sent ones, records days-to-payment", async () => {
  const waiting = await proposal("INV2-PAID", "passed");
  const escalated = await proposal("INV2-PAID", "escalated");
  const sent = await proposal("INV2-PAID", "sent");
  const other = await proposal("INV2-OTHER", "passed");
  setWebhookInvoiceFetchForTesting(async () => structuredClone(paidInvoice));

  const r = await handleInvoiceEvent({ id: "WH-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-PAID", status: "PAID" } } });
  assert.equal(r.duplicate, false);
  assert.equal(r.closed, 2);
  assert.deepEqual(r.days, { invoiceNumber: "TS-261110-1043", paidOn: "2026-11-09", invoiceDate: "2026-11-04", dueDate: "2026-11-07", daysToPayment: 5, daysAfterDue: 2 });

  assert.equal((await store.getProposal(waiting))!.status, "skipped");
  assert.equal((await store.getProposal(escalated))!.resolution?.action, "dismissed");
  assert.equal((await store.getProposal(sent))!.status, "sent");
  assert.equal((await store.getProposal(other))!.status, "passed", "other invoices untouched");
  const [paid] = (await store.listAudit({ entityType: "invoice", entityId: "INV2-PAID" })).filter((a) => a.event === "invoice.paid");
  assert.equal((paid.data as { daysAfterDue: number }).daysAfterDue, 2);
});

test("webhook dedupe: a redelivered event id does nothing the second time", async () => {
  await proposal("INV2-X", "passed");
  let fetched = 0;
  setWebhookInvoiceFetchForTesting(async () => { fetched++; return structuredClone(paidInvoice); });
  const ev = { id: "WH-2", event_type: "INVOICING.INVOICE.CANCELLED", resource: { invoice: { id: "INV2-X" } } };
  assert.equal((await handleInvoiceEvent(ev)).closed, 1);
  const again = await handleInvoiceEvent(ev);
  assert.deepEqual(again, { duplicate: true, closed: 0 });
  assert.equal(fetched, 0, "CANCELLED needs no invoice fetch");
  assert.equal((await store.listAudit({})).filter((a) => a.event === "proposal.closed").length, 1);
});

test("webhook: a failure before recording leaves the event unrecorded, so PayPal's redelivery is handled", async () => {
  setWebhookInvoiceFetchForTesting(async () => { throw new Error("PayPal down"); });
  const ev = { id: "WH-3", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-PAID" } } };
  await assert.rejects(handleInvoiceEvent(ev), /PayPal down/);
  assert.equal(await store.hasWebhookEvent("WH-3"), false);
  setWebhookInvoiceFetchForTesting(async () => structuredClone(paidInvoice));
  assert.equal((await handleInvoiceEvent(ev)).duplicate, false);
  assert.equal(await store.hasWebhookEvent("WH-3"), true);
});

test("UPDATED events are recorded only; closeProposalsForInvoice dry run changes nothing", async () => {
  const p = await proposal("INV2-U", "passed");
  const r = await handleInvoiceEvent({ id: "WH-4", event_type: "INVOICING.INVOICE.UPDATED", resource: { invoice: { id: "INV2-U" } } });
  assert.equal(r.closed, 0);
  assert.equal((await closeProposalsForInvoice("INV2-U", "x", "t", true)).length, 1);
  assert.equal((await store.getProposal(p))!.status, "passed");
});

test("daysToPayment uses the last payment date; null when unpaid", () => {
  assert.equal(daysToPayment({ ...paidInvoice, payments: undefined }), null);
});

test("cron auth: refuses without a long secret, rejects a wrong bearer, accepts the right one", () => {
  const req = (auth?: string) => new Request("https://x/api/cron/agent-run", { method: "POST", headers: auth ? { authorization: auth } : {} });
  assert.equal(authorizeCron(req("Bearer anything"))!.status, 503);
  process.env.KAIROS_CRON_SECRET = "short";
  assert.equal(authorizeCron(req("Bearer short"))!.status, 503);
  process.env.KAIROS_CRON_SECRET = "s".repeat(40);
  assert.equal(authorizeCron(req())!.status, 401);
  assert.equal(authorizeCron(req("Bearer " + "s".repeat(39)))!.status, 401);
  assert.equal(authorizeCron(req("Basic " + "s".repeat(40)))!.status, 401);
  assert.equal(authorizeCron(req("Bearer " + "s".repeat(40))), null);
});

test("demo numbers are date-stamped and fit PayPal's 25 characters; dates land in the current month", () => {
  assert.equal(demoStamp("2026-11-10"), "261110");
  const longest = demoNumber("TS", "2026-11-10", "1048");
  assert.equal(longest, "TS-261110-1048");
  assert.ok(longest.length <= 25);
  for (const c of CUSTOMERS) for (const s of c.invoices) assert.ok(demoNumber("TS", "2026-12-31", s.n).length <= 25);

  assert.equal(issueDate("2026-11-07", "2026-11-10"), "2026-11-04");
  assert.equal(issueDate("2026-10-28", "2026-11-10"), "2026-09-28");
  const paidThisMonth = CUSTOMERS.flatMap((c) => c.invoices).find((s) => s.paidThisMonth)!;
  assert.equal(paymentDate(paidThisMonth, "2026-10-31", "2026-11-10"), "2026-11-07");
  assert.equal(paymentDate(paidThisMonth, "2026-11-22", "2026-12-02"), "2026-12-01", "never before the 1st");
  assert.throws(() => parseEmails("a@x.co,b@x.co,c@x.co"), /exactly 4/);
});

test("the reset only matches the 8 seeded demo numbers, never an owner's invoice that PayPal numbered after them", () => {
  for (const n of ["TS-1043", "TS-261110-1048", "TS-261109-1041"]) assert.equal(isDemoNumber(n, "TS"), true, n);
  for (const n of ["TS-1049", "TS-261110-1049", "TS-261110-1040", "TS-26111-1043", "XTS-1043", "TS-1043-A", "0003", "DEMO-05"]) {
    assert.equal(isDemoNumber(n, "TS"), false, n);
  }
});
