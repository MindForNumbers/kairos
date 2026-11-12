import { test } from "node:test";
import assert from "node:assert/strict";
import type { Invoice } from "../lib/paypal/invoices";
import type { DirectorPlan } from "../lib/director/model";
import { buildReportsData, parseMoney, shortBucket, type ReportData } from "../lib/reports/build";

const inv = (id: string, n: string, status: string, due: string, amount: string, email: string, name: string): Invoice => ({
  id, status,
  detail: { invoice_number: n, currency_code: "USD", invoice_date: "2026-10-01", payment_term: { due_date: due } },
  amount: { currency_code: "USD", value: amount },
  due_amount: { currency_code: "USD", value: status === "PAID" ? "0.00" : amount },
  primary_recipients: [{ billing_info: { email_address: email, name: { full_name: name } } }],
} as Invoice);

const invoices = [
  inv("I1", "TS-1", "SENT", "2026-09-24", "2350.00", "maya@x.co", "Maya"),
  inv("I2", "TS-2", "SENT", "2026-11-20", "100.10", "dan@x.co", "Dan"),
  inv("I3", "TS-3", "PAID", "2026-10-01", "500.00", "dan@x.co", "Dan"),
  inv("I4", "TS-4", "DRAFT", "2026-12-01", "9.00", "dan@x.co", "Dan"),
];

const report: ReportData = {
  today: "2026-11-11",
  period: { name: "this_month", from: "2026-11-01", to: "2026-11-11" },
  aging: [
    { bucket: "current (not yet due)", invoices: 1, due: [{ currency: "USD", value: "100.10", count: 1 }] },
    { bucket: "1-30 days past due", invoices: 0, due: [] },
    { bucket: "31-60 days past due", invoices: 1, due: [{ currency: "USD", value: "2350.00", count: 1 }] },
    { bucket: "61+ days past due", invoices: 0, due: [] },
  ],
  money: { collectedInPeriod: ["5127.50 USD"], invoicedInPeriod: ["5062.50 USD"], outstandingNow: [{ currency: "USD", value: "2450.10", count: 2 }], paymentsInPeriod: 3, invoicesIssuedInPeriod: 4, openInvoicesNow: 2 },
  topCustomersOwing: [{ customerEmail: "maya@x.co", owes: [{ currency: "USD", value: "2350.00", count: 1 }], openInvoices: 1, oldestOverdueDays: 48 }],
  reminders: { sentInPeriod: 1, sentByAgent: 1, sentManually: 0, waitingForApproval: 2, needingHuman: 2, invoicesReminded: 1, remindedInvoicesPaidSince: 0, paidAfterReminderSummary: "0 of the 1 invoice reminded…" },
};

const plan = {
  today: "2026-11-11",
  moves: [{ invoiceId: "I1", invoiceNumber: "TS-1", customer: "maya@x.co", currency: "USD", dueCents: 235000, daysOverdue: 48, pressure: 63, move: "firm", day: "2026-11-11", reason: "r", factors: [], rule: null, pPaid: 0.4, expectedDate: "2026-11-20" }],
  customers: [{ customer: "maya@x.co", history: { onTimeRatio: 0.5, avgDaysLate: 12 }, openCents: 235000, pressure: 63, move: "firm", day: "2026-11-11", reason: "r", invoices: [] }],
  forecast: { horizonDays: 14, expectedCents: 182875, targetCents: 150000, shortfallCents: 0, confidence: "medium", confidenceNote: "n",
    byInvoice: [{ invoiceId: "I1", invoiceNumber: "TS-1", customer: "maya@x.co", dueCents: 235000, pPaid: 0.4, expectedDate: "2026-11-20", expectedCents: 94000 }] },
  receivedAvailable: true,
} as unknown as DirectorPlan;

test("parseMoney is exact to the cent and rejects anything else", () => {
  assert.deepEqual(parseMoney("5127.50 USD"), { amount: 5127.5, currency: "USD" });
  assert.deepEqual(parseMoney("0.10 EUR"), { amount: 0.1, currency: "EUR" });
  assert.throws(() => parseMoney("$5,127.50"), /Unexpected money/);
});

test("customers table: per-customer totals are numbers, so 'owes more than $2,000' is a plain row filter", () => {
  const withBiz = invoices.map((i) => i.id === "I1" ? { ...i, primary_recipients: [{ billing_info: { email_address: "maya@x.co", business_name: "Okafor Family Dental", name: { full_name: "Maya" } } }] } : i) as typeof invoices;
  const d = buildReportsData({ invoices: withBiz, report, plan, names: { "maya@x.co": "Maya Okafor", "dan@x.co": null } });
  for (const c of d.customers) for (const k of ["owes", "overdue", "largestInvoiceAmount", "maxDaysOverdue"] as const) assert.equal(typeof c[k], "number", k);
  assert.deepEqual(d.customers.map((c) => [c.customer, c.company, c.owes, c.overdue, c.openInvoices, c.largestInvoice, c.maxDaysOverdue, c.pressure]), [
    ["Maya Okafor", "Okafor Family Dental", 2350, 2350, 1, "TS-1", 48, 63],
    ["dan@x.co", "", 100.1, 0, 1, "TS-2", 0, null],
  ]);
  assert.deepEqual(d.customers.filter((c) => c.owes > 2000).map((c) => c.company), ["Okafor Family Dental"]);
  // Totals agree with get_report's outstanding (cents-exact).
  assert.equal(Math.round(d.customers.reduce((s, c) => s + c.owes * 100, 0)), 245010);
});

test("reports reuse get_report's and the Director's numbers unchanged", () => {
  const d = buildReportsData({ invoices, report, plan, names: { "maya@x.co": "Maya Okafor", "dan@x.co": null } });
  assert.deepEqual(d.cash.map((c) => [c.metric, c.amount, c.count]), [["Invoiced this month", 5062.5, 4], ["Collected this month", 5127.5, 3], ["Outstanding now", 2450.1, 2]]);
  assert.deepEqual(d.aging.map((a) => [a.bucket, a.amount]), [["Not yet due", 100.1], ["1-30 days", 0], ["31-60 days", 2350], ["61+ days", 0]]);
  assert.deepEqual(d.forecast, { expected: 1828.75, target: 1500, shortfall: 0, confidence: "medium", note: "n", currency: "USD", horizonDays: 14 });
  assert.equal(d.forecastInvoices[0].expectedAmount, 940);
  assert.deepEqual(d.owing, [{ customer: "Maya Okafor", customerEmail: "maya@x.co", owes: 2350, currency: "USD", openInvoices: 1, oldestOverdueDays: 48 }]);
  assert.deepEqual(d.pressure.map((p) => [p.customer, p.pressure, p.nextMove, p.suggestedDay]), [["Maya Okafor", 63, "Firm reminder", "Wed 2026-11-11"]]);
  assert.deepEqual(d.reminders.map((r) => r.count), [1, 1, 0, 2, 2, 0]);
});

test("invoice rows: drafts left out, closed invoices owe 0, Director fields only where it planned a move, unnamed customers shown by email", () => {
  const d = buildReportsData({ invoices, report, plan, names: { "maya@x.co": "Maya Okafor", "dan@x.co": null } });
  assert.deepEqual(d.invoices.map((r) => r.number), ["TS-1", "TS-2", "TS-3"]);
  const [maya, open, paid] = d.invoices;
  assert.deepEqual([maya.daysOverdue, maya.agingBucket, maya.amountDue, maya.pressure, maya.nextMove], [48, "31-60 days", 2350, 63, "Firm reminder"]);
  assert.deepEqual([open.customer, open.agingBucket, open.amountDue, open.pressure, open.nextMove], ["dan@x.co", "Not yet due", 100.1, null, null]);
  assert.deepEqual([paid.agingBucket, paid.amountDue, paid.daysOverdue, paid.status, maya.status], ["closed", 0, 0, "Paid", "Sent"]);
  assert.deepEqual(d.openInvoices.map((r) => r.number), ["TS-2", "TS-1"], "open only, youngest bucket first");
  // The page's aging chart and the invoice rows agree with get_report's buckets.
  for (const a of report.aging) assert.equal(d.invoices.filter((r) => r.agingBucket === shortBucket(a.bucket)).length, a.invoices);
});
