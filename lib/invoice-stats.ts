/**
 * Pure invoice arithmetic shared by the home page and the Kairos chat, so both always
 * give the same numbers. Money is summed in integer cents (no float drift).
 */
import { daysBetween } from "./clock";
import { CHASEABLE, dueDateOf } from "./agent/sweep";
import type { Invoice } from "./paypal/invoices";

export const toCents = (v: string | undefined) => {
  const s = (v ?? "0").trim();
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const c = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -c : c;
};
export const fromCents = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

export const isOpen = (inv: Invoice) => CHASEABLE.has(inv.status);
export const amountDue = (inv: Invoice) => inv.due_amount?.value ?? inv.amount?.value ?? "0";
export const currencyOf = (inv: Invoice) => inv.due_amount?.currency_code ?? inv.detail.currency_code;
export const recipientEmail = (inv: Invoice) => inv.primary_recipients?.[0]?.billing_info?.email_address ?? null;

/** Days past due for an open invoice (0 if not yet due or not open). */
export function daysOverdue(inv: Invoice, today: string): number {
  const due = dueDateOf(inv);
  return isOpen(inv) && due ? Math.max(0, daysBetween(due, today)) : 0;
}

export type Totals = { currency: string; value: string; count: number }[];

export function sumDue(invoices: Invoice[]): Totals {
  const m = new Map<string, { cents: number; count: number }>();
  for (const inv of invoices) {
    const cur = currencyOf(inv);
    const t = m.get(cur) ?? { cents: 0, count: 0 };
    t.cents += toCents(amountDue(inv));
    t.count++;
    m.set(cur, t);
  }
  return [...m].map(([currency, t]) => ({ currency, value: fromCents(t.cents), count: t.count }));
}

export function stats(invoices: Invoice[], today: string) {
  const open = invoices.filter(isOpen);
  const overdue = open.filter((i) => daysOverdue(i, today) > 0);
  return {
    unpaid: sumDue(open),
    overdueTotals: sumDue(overdue),
    openCount: open.length,
    overdueCount: overdue.length,
    oldestOverdueDays: overdue.length ? Math.max(...overdue.map((i) => daysOverdue(i, today))) : null,
  };
}

export const createdAt = (inv: Invoice) => inv.detail.metadata?.create_time ?? inv.detail.invoice_date ?? "";
