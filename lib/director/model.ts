/**
 * The Kairos Director: an adaptive collections-pacing algorithm, inspired by the AI Director
 * in Left 4 Dead, which reads how the players are doing and paces the game. Here it reads each
 * customer's history and recent signals and paces the reminders. "Getting paid is a timing problem."
 *
 * Deterministic code; no model decides anything here. Same inputs → same plan. Pure: no I/O,
 * no clock. Everything comes in through DirectorInput (lib/director/gather.ts builds it).
 *
 * The Director decides only WHAT to propose and WHEN. The hard rules always win and are applied
 * before any scoring: the grace period, the 7-day cooldown, the 60-day escalation, the owner's
 * incentive policy and the flagged-text rule. Drafts still go drafter → critic → Approvals.
 */
import { addDays, daysBetween } from "../clock";
import {
  ESCALATE_AFTER_DAYS, GRACE_DAYS, OFFERS_OFF, formatAmount, offerFor, type PaymentPlanPolicy, type Tone,
} from "../agent/policy";

// ---- Parameters (fingerprinted into the rules version) ----------------------------------------

export const DIRECTOR_PARAMS = {
  /** Points every invoice past the grace period starts with. */
  base: 20,
  /** Age: up to this many points, reached at ageFullDays overdue. */
  agePts: 25, ageFullDays: 60,
  /** Money: up to moneyPts at moneyFull (in the invoice currency), plus sharePts × its share of the open balance. */
  moneyPts: 20, moneyFull: 2500, sharePts: 10,
  /** History: up to latePts for a customer who pays latenessFullDays late on average. */
  latePts: 10, latenessFullDays: 30,
  /** Past reminders not followed by a payment within responseDays: up to unresponsivePts. */
  unresponsivePts: 10, responseDays: 7,
  /** Each reminder on THIS invoice with no payment since: unansweredPts, capped. */
  unansweredPts: 7, unansweredCap: 14,
  /** Relationship (gentler): on-time ratio (needs minPaidForRatio paid invoices) and lifetime paid. */
  onTimePts: 15, minPaidForRatio: 2, lifetimePts: 10, lifetimeFull: 5000,
  /** Cash: when the 14-day forecast falls short of the owner's target, the top cashTopN likely payers get up to cashPts. */
  cashPts: 10, cashTopN: 3, horizonDays: 14,
  /** Relief: a payment on the invoice (or a PayPal payment from the customer) within reliefDays pauses it. */
  reliefDays: 7, reliefFactor: 0.3,
  /** The ladder. */
  waitBelow: 20, friendlyBelow: 45, firmBelow: 60, finalNoticeFrom: 80, finalNoticeMinDays: 21,
  /** At or above this, don't wait for the customer's usual payment weekday. */
  urgentFrom: 60,
  cooldownDays: 7,
  /** Forecast: assumed days late with no history; probabilities. */
  defaultLateDays: 10, pDefault: 0.7, pMin: 0.1, pMax: 0.95,
} as const;
export type DirectorParams = typeof DIRECTOR_PARAMS;

// ---- Input --------------------------------------------------------------------------------------

export type DirectorInvoice = {
  invoiceId: string;
  invoiceNumber: string | null;
  status: string;
  /** Lower-cased recipient email: the customer key. */
  customer: string | null;
  currency: string;
  /** Cents. */
  totalCents: number;
  dueCents: number;
  invoiceDate: string | null;
  dueDate: string | null;
  /** Recorded payments with dates (full records only; summaries carry none). */
  payments: { date: string; cents: number; method: string | null }[];
  /** Invoice text was flagged as suspicious (no offers). */
  flagged: boolean;
};

export type DirectorInput = {
  today: string;
  invoices: DirectorInvoice[];
  /** Kairos's send ledger: reminders actually sent (local dates). `offer`: the note carried a pay-in-parts offer. */
  sends: { invoiceId: string; date: string; offer: boolean }[];
  /** PayPal Transaction Search, last ~14 days. null = unavailable (not enabled, or no data). */
  received: { payerEmail: string | null; date: string; cents: number; invoiceRef: string | null }[] | null;
  paymentPlan: PaymentPlanPolicy;
  /** Owner: cash needed in the next 14 days (0 = no target). */
  cashTarget14d: number;
  /** Active Kairos-side holds: the invoice waits until the owner clears it. */
  holds?: { invoiceId: string; reason: string }[];
};

// ---- Output -------------------------------------------------------------------------------------

export type Move = "wait" | "friendly" | "firm" | "payment_plan" | "final_notice" | "escalate";
export const MOVE_LABEL: Record<Move, string> = {
  wait: "Wait", friendly: "Friendly reminder", firm: "Firm reminder", payment_plan: "Offer payment plan", final_notice: "Final notice", escalate: "Escalate to you",
};
/** Tone the drafter writes in for a move (code-decided). */
export const MOVE_TONE: Partial<Record<Move, Tone>> = { friendly: "friendly", firm: "firm", payment_plan: "firm", final_notice: "final_notice" };

export type Factor = { key: string; points: number; text: string };

export type CustomerHistory = {
  customer: string;
  paidInvoices: number;
  avgDaysLate: number | null;
  onTimeRatio: number | null;
  lifetimePaidCents: number;
  /** 0 = Sunday … 6 = Saturday; the weekday most of their payments land on. */
  paymentWeekday: number | null;
  remindersSent: number;
  /** Share of reminders followed by a payment within responseDays. null = never reminded. */
  reminderResponse: number | null;
};

export type InvoiceMove = {
  invoiceId: string;
  invoiceNumber: string | null;
  customer: string | null;
  currency: string;
  dueCents: number;
  daysOverdue: number;
  pressure: number;
  move: Move;
  /** Suggested day for the move (null for wait). Never inside the cooldown. */
  day: string | null;
  /** One line, plain English, naming the top factors. */
  reason: string;
  factors: Factor[];
  /** Which hard rule decided, if one did. */
  rule: "grace" | "cooldown" | "escalation" | "relief" | "hold" | null;
  /** Forecast: probability of being paid and expected date. */
  pPaid: number;
  expectedDate: string;
};

export type CustomerPlan = {
  customer: string;
  history: CustomerHistory;
  openCents: number;
  /** The customer's highest-pressure invoice decides their row. */
  pressure: number;
  move: Move;
  day: string | null;
  reason: string;
  invoices: InvoiceMove[];
};

export type Forecast = {
  horizonDays: number;
  /** Expected inflow (cents), probability-weighted, from open invoices expected within the horizon. */
  expectedCents: number;
  targetCents: number;
  shortfallCents: number;
  confidence: "high" | "medium" | "low";
  confidenceNote: string;
  byInvoice: { invoiceId: string; invoiceNumber: string | null; customer: string | null; dueCents: number; pPaid: number; expectedDate: string; expectedCents: number }[];
};

export type DirectorPlan = {
  today: string;
  moves: InvoiceMove[];
  customers: CustomerPlan[];
  forecast: Forecast;
  receivedAvailable: boolean;
};

// ---- Helpers ------------------------------------------------------------------------------------

const P = DIRECTOR_PARAMS;
const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
const PAID = new Set(["PAID", "MARKED_AS_PAID"]);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const money = (cents: number, cur: string) => formatAmount((cents / 100).toFixed(2), cur);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** First date ≥ from that falls on weekday (0-6). */
export function nextWeekday(from: string, weekday: number): string {
  return addDays(from, (weekday - weekdayOf(from) + 7) % 7);
}

// ---- Customer history -----------------------------------------------------------------------------

export function customerHistory(customer: string, input: DirectorInput): CustomerHistory {
  const invs = input.invoices.filter((i) => i.customer === customer);
  const paid = invs.filter((i) => PAID.has(i.status) && i.dueDate && i.payments.length);
  const lates = paid.map((i) => {
    const last = i.payments.map((p) => p.date).sort().at(-1)!;
    return daysBetween(i.dueDate!, last);
  });
  const allPayments = invs.flatMap((i) => i.payments);
  const counts = new Array(7).fill(0) as number[];
  for (const p of allPayments) counts[weekdayOf(p.date)]++;
  const maxCount = Math.max(...counts);
  const ids = new Set(invs.map((i) => i.invoiceId));
  const sends = input.sends.filter((s) => ids.has(s.invoiceId));
  const responded = sends.filter((s) => {
    const inv = invs.find((i) => i.invoiceId === s.invoiceId)!;
    return inv.payments.some((p) => p.date >= s.date && daysBetween(s.date, p.date) <= P.responseDays);
  }).length;
  return {
    customer,
    paidInvoices: paid.length,
    avgDaysLate: lates.length ? round1(lates.reduce((a, b) => a + Math.max(0, b), 0) / lates.length) : null,
    onTimeRatio: lates.length ? round1(lates.filter((d) => d <= 0).length / lates.length * 100) / 100 : null,
    lifetimePaidCents: allPayments.reduce((a, p) => a + p.cents, 0),
    // A habit needs at least two payments on the same weekday.
    paymentWeekday: maxCount >= 2 ? counts.indexOf(maxCount) : null,
    remindersSent: sends.length,
    reminderResponse: sends.length ? round1(responded / sends.length * 100) / 100 : null,
  };
}

// ---- Forecast pieces ------------------------------------------------------------------------------

function unansweredOn(inv: DirectorInvoice, input: DirectorInput): number {
  const lastPay = inv.payments.map((p) => p.date).sort().at(-1) ?? "";
  return input.sends.filter((s) => s.invoiceId === inv.invoiceId && s.date > lastPay).length;
}

function reliefFor(inv: DirectorInvoice, input: DirectorInput): string | null {
  const since = addDays(input.today, -P.reliefDays);
  const onInvoice = inv.payments.filter((p) => p.date >= since && p.date <= input.today).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (onInvoice) return `part paid ${money(onInvoice.cents, inv.currency)} on ${onInvoice.date}`;
  const viaPayPal = (input.received ?? []).filter((r) => r.date >= since && r.payerEmail && inv.customer && r.payerEmail.toLowerCase() === inv.customer)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (viaPayPal) return `sent a PayPal payment of ${money(viaPayPal.cents, inv.currency)} on ${viaPayPal.date}`;
  return null;
}

/** Probability the invoice gets paid, and when, from the customer's history. Deterministic. */
export function expectPayment(inv: DirectorInvoice, h: CustomerHistory | null, input: DirectorInput): { pPaid: number; expectedDate: string } {
  const due = inv.dueDate ?? input.today;
  const late = h?.avgDaysLate ?? P.defaultLateDays;
  let expected = addDays(due, Math.round(late));
  const overdue = daysBetween(due, input.today);
  let p = h && h.onTimeRatio !== null ? 0.5 + 0.45 * h.onTimeRatio : P.pDefault;
  if (expected < input.today) {
    // Already later than they usually pay: less likely, and not before next week.
    expected = addDays(input.today, 7);
    if (overdue > late + 14) p -= 0.2;
  }
  p -= Math.min(0.3, 0.1 * unansweredOn(inv, input));
  if (reliefFor(inv, input)) p += 0.1;
  if (overdue > ESCALATE_AFTER_DAYS) p = Math.min(p, 0.2);
  return { pPaid: round1(clamp(p, P.pMin, P.pMax) * 100) / 100, expectedDate: expected };
}

export function forecast(input: DirectorInput, histories: Map<string, CustomerHistory>): Forecast {
  const horizon = addDays(input.today, P.horizonDays);
  const byInvoice = input.invoices
    .filter((i) => OPEN.has(i.status) && i.dueCents > 0)
    .map((i) => {
      const h = i.customer ? histories.get(i.customer) ?? null : null;
      const e = expectPayment(i, h, input);
      return { invoiceId: i.invoiceId, invoiceNumber: i.invoiceNumber, customer: i.customer, dueCents: i.dueCents, ...e,
        expectedCents: e.expectedDate <= horizon ? Math.round(i.dueCents * e.pPaid) : 0 };
    })
    .sort((a, b) => b.expectedCents - a.expectedCents || a.invoiceId.localeCompare(b.invoiceId));
  const expectedCents = byInvoice.reduce((a, b) => a + b.expectedCents, 0);
  const targetCents = Math.round(input.cashTarget14d * 100);
  const contributing = byInvoice.filter((b) => b.expectedCents > 0);
  const known = contributing.filter((b) => (b.customer ? histories.get(b.customer)?.paidInvoices ?? 0 : 0) >= 3).reduce((a, b) => a + b.expectedCents, 0);
  const some = contributing.filter((b) => (b.customer ? histories.get(b.customer)?.paidInvoices ?? 0 : 0) >= 1).reduce((a, b) => a + b.expectedCents, 0);
  const share = (x: number) => (expectedCents ? x / expectedCents : 0);
  const confidence = share(known) >= 0.7 ? "high" : share(some) >= 0.5 ? "medium" : "low";
  const confidenceNote = !contributing.length
    ? "No open invoice is expected to be paid in the next 14 days."
    : `${Math.round(share(some) * 100)}% of the expected amount comes from customers with a payment history here; ${confidence === "high" ? "most have 3+ paid invoices" : confidence === "medium" ? "estimates use their usual lateness" : "most of it is a default guess (no history)"}. Payments are never certain: this is a weighted estimate, not a promise.`;
  return { horizonDays: P.horizonDays, expectedCents, targetCents, shortfallCents: Math.max(0, targetCents - expectedCents), confidence, confidenceNote, byInvoice };
}

// ---- The plan --------------------------------------------------------------------------------------

export function direct(input: DirectorInput): DirectorPlan {
  const customers = [...new Set(input.invoices.map((i) => i.customer).filter((c): c is string => !!c))].sort();
  const histories = new Map(customers.map((c) => [c, customerHistory(c, input)]));
  const fc = forecast(input, histories);
  const open = input.invoices.filter((i) => OPEN.has(i.status) && i.dueCents > 0 && i.dueDate);
  const openTotal = open.reduce((a, i) => a + i.dueCents, 0);
  // Cash need: the largest, most likely payers within the horizon get the push.
  const cashBoost = new Map<string, number>();
  if (fc.shortfallCents > 0 && fc.targetCents > 0) {
    const pts = P.cashPts * Math.min(1, fc.shortfallCents / fc.targetCents);
    const likely = [...fc.byInvoice].filter((b) => open.some((o) => o.invoiceId === b.invoiceId && daysBetween(o.dueDate!, input.today) >= GRACE_DAYS))
      .sort((a, b) => b.dueCents * b.pPaid - a.dueCents * a.pPaid || a.invoiceId.localeCompare(b.invoiceId)).slice(0, P.cashTopN);
    for (const b of likely) cashBoost.set(b.invoiceId, pts);
  }

  const moves: InvoiceMove[] = open
    .filter((i) => daysBetween(i.dueDate!, input.today) > 0)
    .map((inv) => scoreInvoice(inv, input, inv.customer ? histories.get(inv.customer) ?? null : null, openTotal, cashBoost.get(inv.invoiceId) ?? 0, fc))
    .sort((a, b) => b.pressure - a.pressure || b.dueCents - a.dueCents || a.invoiceId.localeCompare(b.invoiceId));

  const plans: CustomerPlan[] = customers
    .map((c) => {
      const mine = moves.filter((m) => m.customer === c);
      if (!mine.length) return null;
      const top = mine[0];
      return { customer: c, history: histories.get(c)!, openCents: open.filter((o) => o.customer === c).reduce((a, o) => a + o.dueCents, 0),
        pressure: top.pressure, move: top.move, day: top.day, reason: top.reason, invoices: mine };
    })
    .filter((x): x is CustomerPlan => !!x)
    .sort((a, b) => b.pressure - a.pressure || b.openCents - a.openCents || a.customer.localeCompare(b.customer));

  return { today: input.today, moves, customers: plans, forecast: fc, receivedAvailable: input.received !== null };
}

function scoreInvoice(inv: DirectorInvoice, input: DirectorInput, h: CustomerHistory | null, openTotal: number, cash: number, fc: Forecast): InvoiceMove {
  const today = input.today;
  const days = daysBetween(inv.dueDate!, today);
  const cur = inv.currency;
  const factors: Factor[] = [];
  const add = (key: string, points: number, text: string) => { if (Math.abs(points) >= 0.05) factors.push({ key, points: round1(points), text }); };

  add("base", P.base, "overdue");
  add("age", P.agePts * Math.min(1, days / P.ageFullDays), `${plural(days, "day")} overdue`);
  const share = openTotal ? inv.dueCents / openTotal : 0;
  add("money", P.moneyPts * Math.min(1, inv.dueCents / 100 / P.moneyFull), `${money(inv.dueCents, cur)} due`);
  add("share", P.sharePts * share, `${Math.round(share * 100)}% of everything you're owed`);
  if (h?.avgDaysLate != null) add("lateness", P.latePts * Math.min(1, h.avgDaysLate / P.latenessFullDays), `usually pays ${h.avgDaysLate} days late`);
  if (h?.reminderResponse != null) add("unresponsive", P.unresponsivePts * (1 - h.reminderResponse), `${Math.round(h.reminderResponse * 100)}% of past reminders got a payment within ${P.responseDays} days`);
  const unanswered = unansweredOn(inv, input);
  if (unanswered) add("unanswered", Math.min(P.unansweredCap, P.unansweredPts * unanswered), `${plural(unanswered, "reminder")} on this invoice with no payment since`);
  if (h && h.onTimeRatio !== null && h.paidInvoices >= P.minPaidForRatio) add("on_time", -P.onTimePts * h.onTimeRatio, `pays on time ${Math.round(h.onTimeRatio * 100)}% of the time`);
  if (h && h.lifetimePaidCents > 0) add("lifetime", -P.lifetimePts * Math.min(1, h.lifetimePaidCents / 100 / P.lifetimeFull), `has paid you ${money(h.lifetimePaidCents, cur)} in total`);
  if (cash) add("cash", cash, `you need ${money(fc.shortfallCents, cur)} more in the next ${P.horizonDays} days and they're a likely payer`);

  let pressure = factors.reduce((a, f) => a + f.points, 0);
  const relief = reliefFor(inv, input);
  if (relief) pressure *= P.reliefFactor;
  pressure = Math.round(clamp(pressure, 0, 100));

  const { pPaid, expectedDate } = expectPayment(inv, h, input);
  const lastSend = input.sends.filter((s) => s.invoiceId === inv.invoiceId).map((s) => s.date).sort().at(-1) ?? null;
  const earliest = lastSend && addDays(lastSend, P.cooldownDays) > today ? addDays(lastSend, P.cooldownDays) : today;
  const top = [...factors].filter((f) => f.key !== "base").sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.key.localeCompare(b.key)).slice(0, 3).map((f) => f.text);
  const base = { invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, customer: inv.customer, currency: cur, dueCents: inv.dueCents, daysOverdue: days, pressure, factors, pPaid, expectedDate };

  // Hard rules first: they always win.
  if (days < GRACE_DAYS) return { ...base, move: "wait", day: addDays(inv.dueDate!, GRACE_DAYS), rule: "grace", reason: `In the ${GRACE_DAYS}-day grace period; no reminder before ${addDays(inv.dueDate!, GRACE_DAYS)}.` };
  const hold = input.holds?.find((x) => x.invoiceId === inv.invoiceId);
  if (hold) return { ...base, move: "wait", day: null, rule: "hold", reason: `On hold until you clear it: ${hold.reason}` };
  if (days > ESCALATE_AFTER_DAYS) return { ...base, move: "escalate", day: today, rule: "escalation", reason: `${days} days overdue (over ${ESCALATE_AFTER_DAYS}): policy sends it to you, no automated reminder.` };
  if (relief) return { ...base, move: "wait", day: null, rule: "relief", reason: `Pause: the customer ${relief}. Pressure dropped to ${pressure}; no reminder for now.` };

  // Then the ladder.
  const prevOffer = input.sends.some((s) => s.invoiceId === inv.invoiceId && s.offer);
  const offerOk = offerFor({ invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, status: inv.status, currency: cur, amountTotal: null, amountDue: (inv.dueCents / 100).toFixed(2),
    amountPaid: null, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate!, daysOverdue: days, recipientEmail: inv.customer, lastReminderAt: null, severity: 1,
    untrusted: { recipientName: null, note: null, items: [] }, flags: inv.flagged ? ["flagged"] : [] }, input.paymentPlan ?? OFFERS_OFF);
  let move: Move;
  let note = "";
  if (pressure < P.waitBelow) move = "wait";
  else if (pressure < P.friendlyBelow) move = "friendly";
  else if (pressure < P.firmBelow) move = "firm";
  else if (offerOk.offer && !prevOffer) move = "payment_plan";
  else {
    move = pressure >= P.finalNoticeFrom && days >= P.finalNoticeMinDays ? "final_notice" : "firm";
    note = prevOffer ? " A payment plan was already offered." : inv.flagged ? " No offer: the invoice text is flagged." : ` No payment plan (${offerOk.why}).`;
  }

  let day: string | null = null;
  if (move !== "wait") {
    const wd = h?.paymentWeekday ?? null;
    day = pressure < P.urgentFrom && wd !== null ? nextWeekday(earliest, wd) : earliest;
  }
  const when = !day ? "" : day === today ? " Today." : ` On ${WEEKDAYS[weekdayOf(day)]} ${day}${h?.paymentWeekday === weekdayOf(day) && pressure < P.urgentFrom ? " (the day they usually pay)" : ""}${earliest > today ? `, after the ${P.cooldownDays}-day cooldown` : ""}.`;
  const lead = move === "wait" ? `Wait: pressure ${pressure}` : `${MOVE_LABEL[move]}: pressure ${pressure}`;
  return { ...base, move, day, rule: earliest > today ? "cooldown" : null, reason: `${lead}; ${top.join("; ")}.${note}${when}` };
}
