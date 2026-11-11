// A demo-shaped account for the Director: the same four personas the demo reset seeds.
import type { DirectorInput, DirectorInvoice } from "../lib/director/model";
import { addDays } from "../lib/clock";

export const TODAY = "2026-11-10"; // a Tuesday
export const POLICY_ON = { enabled: true, minInvoiceAmount: 500, minDaysOverdue: 14, maxParts: 3, minPaymentAmount: 100 };

export const inv = (id: string, customer: string, status: string, total: number, dueDaysAgo: number, payments: [number, number][] = [], flagged = false): DirectorInvoice => {
  const paid = payments.reduce((a, [, c]) => a + c, 0);
  return {
    invoiceId: id, invoiceNumber: id, status, customer, currency: "USD", totalCents: total,
    dueCents: status === "PAID" ? 0 : total - paid,
    invoiceDate: addDays(TODAY, -dueDaysAgo - 30), dueDate: addDays(TODAY, -dueDaysAgo),
    payments: payments.map(([daysAgo, cents]) => ({ date: addDays(TODAY, -daysAgo), cents, method: "BANK_TRANSFER" })), flagged,
  };
};

/** Fridays before TODAY: 4, 11, 18, … days ago. Tuesdays: 7, 14, 21, … */
export function demoInput(over: Partial<DirectorInput> = {}): DirectorInput {
  return {
    today: TODAY, sends: [], received: [], paymentPlan: POLICY_ON, cashTarget14d: 0,
    invoices: [
      // Daniel Reyes: reliable. Paid on time, on Fridays.
      inv("D-H1", "daniel@x", "PAID", 48000, 92, [[95, 48000]]),
      inv("D-H2", "daniel@x", "PAID", 48000, 62, [[67, 48000]]),
      inv("D-H3", "daniel@x", "PAID", 48000, 31, [[32, 48000]]),
      inv("D-1043", "daniel@x", "SENT", 25000, 5),
      // Maya Okafor: silent, high value. Paid very late (Tuesdays), owes $2,350 48 days.
      inv("M-H1", "maya@x", "PAID", 60000, 130, [[84, 60000]]),
      inv("M-H2", "maya@x", "PAID", 60000, 90, [[49, 60000]]),
      inv("M-1046", "maya@x", "SENT", 235000, 48),
      // Priya Nair: new customer.
      inv("P-1044", "priya@x", "SENT", 9500, 5),
      inv("P-1047", "priya@x", "SENT", 38000, 75),
      // Tom Becker: a recent partial payment; and the injection invoice.
      inv("T-1045", "tom@x", "PARTIALLY_PAID", 64000, 6, [[2, 20000]]),
      inv("T-1048", "tom@x", "SENT", 31000, 12, [], true),
    ],
    ...over,
  };
}
