/**
 * The /reports page's tables, as plain rows for AG Studio's data engine. PURE: it only reshapes
 * numbers the chat and briefing already computed (get_report, the Director plan and its 14-day
 * forecast, invoice-stats), so the page can never disagree with them. No I/O, no store, no clock.
 */
import type { DirectorPlan } from "@/lib/director/model";
import { MOVE_LABEL, WEEKDAYS, weekdayOf } from "@/lib/director/model";
import type { Invoice } from "@/lib/paypal/invoices";
import { amountDue, currencyOf, daysOverdue, isOpen, recipientEmail, toCents } from "@/lib/invoice-stats";
import { dueDateOf } from "@/lib/agent/sweep";
import { cleanUntrusted } from "@/lib/agent/untrusted";

/** The subset of get_report's data this page reads (money as "123.45 USD" strings). */
export type ReportData = {
  today: string;
  period: { name: string; from: string; to: string };
  aging: { bucket: string; invoices: number; due: { currency: string; value: string; count: number }[] }[];
  money: { collectedInPeriod: string[]; invoicedInPeriod: string[]; outstandingNow: { currency: string; value: string; count: number }[]; paymentsInPeriod: number; invoicesIssuedInPeriod: number; openInvoicesNow: number };
  topCustomersOwing: { customerEmail: string; owes: { currency: string; value: string; count: number }[]; openInvoices: number; oldestOverdueDays: number }[];
  reminders: { sentInPeriod: number; sentByAgent: number; sentManually: number; waitingForApproval: number; needingHuman: number; invoicesReminded: number; remindedInvoicesPaidSince: number; paidAfterReminderSummary: string };
  truncated?: boolean;
};

export type InvoiceRow = {
  id: string; number: string; customer: string; company: string; customerEmail: string; status: string;
  dueDate: string | null; daysOverdue: number; agingBucket: string; amountDue: number; currency: string;
  pressure: number | null; nextMove: string | null; suggestedDay: string | null; reason: string | null;
};
export type AgingRow = { bucket: string; order: number; invoices: number; amount: number; currency: string };
export type CashRow = { metric: string; order: number; amount: number; currency: string; count: number };
export type ForecastRow = { expected: number; target: number; shortfall: number; confidence: string; note: string; currency: string; horizonDays: number };
export type ForecastInvoiceRow = { invoice: string; customer: string; expectedDate: string; expectedAmount: number; amountDue: number; probability: number };
export type OwingRow = { customer: string; customerEmail: string; owes: number; currency: string; openInvoices: number; oldestOverdueDays: number };
export type PressureRow = { customer: string; customerEmail: string; pressure: number; nextMove: string; suggestedDay: string | null; owes: number; reason: string; onTimeRatio: number | null; avgDaysLate: number | null };
export type ReminderRow = { activity: string; order: number; count: number };
/** One row per customer with open invoices, totals computed in code (no aggregation needed to filter on them). */
export type CustomerRow = {
  customer: string; company: string; customerEmail: string; currency: string;
  owes: number; overdue: number; openInvoices: number; overdueInvoices: number;
  largestInvoice: string; largestInvoiceAmount: number; mostOverdueInvoice: string; maxDaysOverdue: number;
  pressure: number | null; nextMove: string | null;
};

export type ReportsData = {
  today: string;
  period: { from: string; to: string };
  currency: string;
  invoices: InvoiceRow[];
  openInvoices: InvoiceRow[];
  customers: CustomerRow[];
  aging: AgingRow[];
  cash: CashRow[];
  forecast: ForecastRow;
  forecastInvoices: ForecastInvoiceRow[];
  owing: OwingRow[];
  pressure: PressureRow[];
  reminders: ReminderRow[];
  paidAfterReminderSummary: string;
  truncated: boolean;
};

/** "1234.56 USD" → { amount: 1234.56, currency: "USD" }. Exact to the cent. */
export function parseMoney(s: string): { amount: number; currency: string } {
  const m = /^(-?\d+(?:\.\d{1,2})?) ([A-Z]{3})$/.exec(s.trim());
  if (!m) throw new Error(`Unexpected money string: ${JSON.stringify(s)}`);
  return { amount: toCents(m[1]) / 100, currency: m[2] };
}

const dollars = (cents: number) => cents / 100;
const pick = (totals: { currency: string; value: string }[], currency: string) => dollars(toCents(totals.find((t) => t.currency === currency)?.value));
const pickStr = (totals: string[], currency: string) => totals.map(parseMoney).find((t) => t.currency === currency)?.amount ?? 0;
const dayLabel = (d: string | null) => (d ? `${WEEKDAYS[weekdayOf(d)].slice(0, 3)} ${d}` : null);

/** Same buckets (and labels) as get_report's aging. */
export const agingBucketOf = (inv: Invoice, today: string) => {
  if (!isOpen(inv)) return "closed";
  const d = daysOverdue(inv, today);
  return d === 0 ? "Not yet due" : d <= 30 ? "1-30 days" : d <= 60 ? "31-60 days" : "61+ days";
};

export const STATUS_LABEL: Record<string, string> = {
  SENT: "Sent", UNPAID: "Unpaid", PARTIALLY_PAID: "Partly paid", PAID: "Paid", MARKED_AS_PAID: "Paid (recorded)",
  CANCELLED: "Cancelled", REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Partly refunded", MARKED_AS_REFUNDED: "Refunded (recorded)",
  SCHEDULED: "Scheduled", PAYMENT_PENDING: "Payment pending",
};
const BUCKET_ORDER = ["Not yet due", "1-30 days", "31-60 days", "61+ days"];

/** Chart-friendly labels for get_report's buckets ("1-30 days past due" → "1-30 days"). */
export const shortBucket = (b: string) => (b.startsWith("current") ? "Not yet due" : b.replace(" past due", ""));

/**
 * Per-customer totals over open invoices, summed in integer cents. Lets "who owes more than $X",
 * "who is most overdue" or "largest invoice per customer" be a plain row filter or sort, with no
 * aggregation (AG Studio's engine can't filter on an aggregated column it has aliased).
 */
export function customersFrom(open: InvoiceRow[], pressure: PressureRow[]): CustomerRow[] {
  const cents = (n: number) => Math.round(n * 100);
  const by = new Map<string, InvoiceRow[]>();
  for (const r of open) by.set(r.customerEmail, [...(by.get(r.customerEmail) ?? []), r]);
  const pressureBy = new Map(pressure.map((p) => [p.customerEmail, p]));
  return [...by].map(([email, rows]) => {
    const largest = rows.reduce((a, b) => (b.amountDue > a.amountDue ? b : a));
    const oldest = rows.reduce((a, b) => (b.daysOverdue > a.daysOverdue ? b : a));
    const overdueRows = rows.filter((r) => r.daysOverdue > 0);
    const p = pressureBy.get(email);
    return {
      customer: rows[0].customer, company: rows.find((r) => r.company)?.company ?? "", customerEmail: email, currency: rows[0].currency,
      owes: rows.reduce((s, r) => s + cents(r.amountDue), 0) / 100,
      overdue: overdueRows.reduce((s, r) => s + cents(r.amountDue), 0) / 100,
      openInvoices: rows.length, overdueInvoices: overdueRows.length,
      largestInvoice: largest.number, largestInvoiceAmount: largest.amountDue,
      mostOverdueInvoice: oldest.number, maxDaysOverdue: oldest.daysOverdue,
      pressure: p?.pressure ?? null, nextMove: p?.nextMove ?? null,
    };
  }).sort((a, b) => b.owes - a.owes);
}

export function buildReportsData(opts: {
  invoices: Invoice[];
  report: ReportData;
  plan: DirectorPlan;
  /** Display names by lower-cased email, already cleaned of untrusted markup. */
  names: Record<string, string | null>;
}): ReportsData {
  const { invoices, report, plan, names } = opts;
  const today = report.today;
  // The demo business bills in one currency; the Director and forecast are USD-only too.
  const currency = report.money.outstandingNow[0]?.currency ?? "USD";
  const nameFor = (email: string | null | undefined) => (email ? names[email.toLowerCase()] || email : "(no email)");
  const moveById = new Map(plan.moves.map((m) => [m.invoiceId, m]));

  const invoiceRows: InvoiceRow[] = invoices
    .filter((inv) => inv.status !== "DRAFT")
    .map((inv) => {
      const mv = moveById.get(inv.id);
      const email = recipientEmail(inv);
      return {
        id: inv.id,
        number: inv.detail.invoice_number ?? inv.id,
        customer: nameFor(email),
        // Customer-entered text, cleaned; rendered as text and described to the AI as data.
        company: cleanUntrusted(inv.primary_recipients?.[0]?.billing_info?.business_name, 80) ?? "",
        customerEmail: email?.toLowerCase() ?? "",
        status: STATUS_LABEL[inv.status] ?? inv.status,
        dueDate: dueDateOf(inv) ?? null,
        daysOverdue: daysOverdue(inv, today),
        agingBucket: agingBucketOf(inv, today),
        amountDue: isOpen(inv) ? dollars(toCents(amountDue(inv))) : 0,
        currency: currencyOf(inv),
        pressure: mv ? mv.pressure : null,
        nextMove: mv ? MOVE_LABEL[mv.move] : isOpen(inv) ? null : "—",
        suggestedDay: mv ? dayLabel(mv.day) : null,
        reason: mv ? mv.reason : null,
      };
    });

  // Open invoices only, oldest bucket last, so grouped views read left to right like the aging chart.
  const openInvoices = invoiceRows
    .filter((r) => r.agingBucket !== "closed")
    .sort((a, b) => BUCKET_ORDER.indexOf(a.agingBucket) - BUCKET_ORDER.indexOf(b.agingBucket) || b.daysOverdue - a.daysOverdue);

  const aging: AgingRow[] = report.aging.map((a, order) => ({ bucket: shortBucket(a.bucket), order, invoices: a.invoices, amount: pick(a.due, currency), currency }));

  const cash: CashRow[] = [
    { metric: "Invoiced this month", order: 0, amount: pickStr(report.money.invoicedInPeriod, currency), currency, count: report.money.invoicesIssuedInPeriod },
    { metric: "Collected this month", order: 1, amount: pickStr(report.money.collectedInPeriod, currency), currency, count: report.money.paymentsInPeriod },
    { metric: "Outstanding now", order: 2, amount: pick(report.money.outstandingNow, currency), currency, count: report.money.openInvoicesNow },
  ];

  const f = plan.forecast;
  const forecast: ForecastRow = {
    expected: dollars(f.expectedCents), target: dollars(f.targetCents), shortfall: dollars(f.shortfallCents),
    confidence: f.confidence, note: f.confidenceNote, currency: "USD", horizonDays: f.horizonDays,
  };
  const forecastInvoices: ForecastInvoiceRow[] = f.byInvoice.map((b) => ({
    invoice: b.invoiceNumber ?? b.invoiceId, customer: nameFor(b.customer), expectedDate: b.expectedDate,
    expectedAmount: dollars(b.expectedCents), amountDue: dollars(b.dueCents), probability: b.pPaid,
  }));

  const owing: OwingRow[] = report.topCustomersOwing.map((c) => ({
    customer: nameFor(c.customerEmail === "(no email)" ? null : c.customerEmail), customerEmail: c.customerEmail,
    owes: pick(c.owes, currency), currency, openInvoices: c.openInvoices, oldestOverdueDays: c.oldestOverdueDays,
  }));

  const pressure: PressureRow[] = plan.customers.map((c) => ({
    customer: nameFor(c.customer), customerEmail: c.customer, pressure: c.pressure, nextMove: MOVE_LABEL[c.move],
    suggestedDay: dayLabel(c.day), owes: dollars(c.openCents), reason: c.reason,
    onTimeRatio: c.history.onTimeRatio, avgDaysLate: c.history.avgDaysLate,
  }));

  const r = report.reminders;
  const reminders: ReminderRow[] = [
    { activity: "Sent this month", order: 0, count: r.sentInPeriod },
    { activity: "Sent by Kairos (approved)", order: 1, count: r.sentByAgent },
    { activity: "Sent by you", order: 2, count: r.sentManually },
    { activity: "Waiting for approval", order: 3, count: r.waitingForApproval },
    { activity: "Needs you", order: 4, count: r.needingHuman },
    { activity: "Reminded, paid since", order: 5, count: r.remindedInvoicesPaidSince },
  ];

  return {
    today, period: { from: report.period.from, to: report.period.to }, currency,
    invoices: invoiceRows, openInvoices, customers: customersFrom(openInvoices, pressure), aging, cash, forecast, forecastInvoices, owing, pressure, reminders,
    paidAfterReminderSummary: r.paidAfterReminderSummary, truncated: !!report.truncated,
  };
}
