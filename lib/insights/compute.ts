/**
 * Proactive insights, computed in CODE from data Kairos already has: the invoices, the send
 * ledger, PayPal Transaction Search and the Director's plan. Pure and deterministic: no I/O,
 * no clock, no model. Ranked by money at stake. A model may later phrase them (phrasing.ts),
 * but every number and name is inserted by code.
 *
 *   a) payment_plan_candidate: a large stuck invoice the Director would offer a payment plan on
 *      → action "Offer payment plan" (drafts through the normal pipeline → Approvals)
 *   b) possible_outside_payment: a PayPal payment from a customer whose open invoice has the same
 *      amount, not linked to that invoice → action "Hold reminder" (Kairos-side hold; no PayPal write)
 *   c) cash_forecast: expected inflow over the next 14 days, from each customer's usual lateness
 *   d) slow_payer: customers who usually pay late
 */
import { daysBetween } from "../clock";
import { offerTerms, type Offer } from "../agent/policy";
import type { DirectorInput, DirectorPlan, Forecast } from "../director/model";

export type InsightAction =
  | { type: "offer_plan"; invoiceId: string; label: "Offer payment plan" }
  | { type: "hold"; invoiceId: string; reason: string; label: "Hold reminder" };

type Base = { id: string; moneyAtStakeCents: number; currency: string; customer: string | null; action: InsightAction | null };

export type Insight = Base & (
  | { kind: "payment_plan_candidate"; invoiceId: string; invoiceNumber: string | null; dueCents: number; daysOverdue: number; offer: Offer; pressure: number }
  | { kind: "possible_outside_payment"; invoiceId: string; invoiceNumber: string | null; paymentCents: number; paymentDate: string; linkedTo: string | null }
  | { kind: "cash_forecast"; expectedCents: number; targetCents: number; shortfallCents: number; horizonDays: number; confidence: Forecast["confidence"]; confidenceNote: string;
      top: { invoiceNumber: string | null; expectedCents: number; expectedDate: string }[] }
  | { kind: "slow_payer"; avgDaysLate: number; paidInvoices: number; onTimeRatio: number | null; openCents: number }
);
export type InsightKind = Insight["kind"];

/** How far back a PayPal payment can suggest an invoice was paid some other way. */
export const OUTSIDE_PAYMENT_DAYS = 30;
/** A "slow payer": at least this many paid invoices, this many days late on average. */
export const SLOW_MIN_PAID = 2;
export const SLOW_MIN_DAYS_LATE = 14;

export type InsightContext = {
  /** Invoices with a reminder already waiting on Approvals, or held there for a human. */
  inQueue: string[];
};

export function computeInsights(input: DirectorInput, plan: DirectorPlan, ctx: InsightContext): Insight[] {
  const out: Insight[] = [];
  const held = new Set((input.holds ?? []).map((h) => h.invoiceId));
  const queued = new Set(ctx.inQueue);
  const open = input.invoices.filter((i) => ["SENT", "UNPAID", "PARTIALLY_PAID"].includes(i.status) && i.dueCents > 0);

  // a) Large stuck invoice eligible for a payment plan: the Director's move is "offer payment plan".
  for (const m of plan.moves) {
    if (m.move !== "payment_plan" || held.has(m.invoiceId) || queued.has(m.invoiceId)) continue;
    const offer = offerTerms((m.dueCents / 100).toFixed(2), m.currency, input.paymentPlan);
    if (!offer) continue;
    out.push({ id: `plan:${m.invoiceId}`, kind: "payment_plan_candidate", moneyAtStakeCents: m.dueCents, currency: m.currency, customer: m.customer,
      invoiceId: m.invoiceId, invoiceNumber: m.invoiceNumber, dueCents: m.dueCents, daysOverdue: m.daysOverdue, offer, pressure: m.pressure,
      action: { type: "offer_plan", invoiceId: m.invoiceId, label: "Offer payment plan" } });
  }

  // b) Possible payment outside the invoice.
  for (const inv of open) {
    if (!inv.customer || held.has(inv.invoiceId)) continue;
    const match = (input.received ?? [])
      .filter((r) => r.payerEmail === inv.customer && r.cents === inv.dueCents
        && daysBetween(r.date, input.today) <= OUTSIDE_PAYMENT_DAYS && (!inv.invoiceDate || r.date >= inv.invoiceDate)
        && r.invoiceRef !== inv.invoiceId && r.invoiceRef !== inv.invoiceNumber)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!match) continue;
    const label = inv.invoiceNumber ?? inv.invoiceId;
    // Show the linked invoice by its number when we have it (PayPal often gives the INV2 id).
    const linked = match.invoiceRef ? (input.invoices.find((x) => x.invoiceId === match.invoiceRef)?.invoiceNumber ?? match.invoiceRef) : null;
    out.push({ id: `outside:${inv.invoiceId}`, kind: "possible_outside_payment", moneyAtStakeCents: inv.dueCents, currency: inv.currency, customer: inv.customer,
      invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, paymentCents: match.cents, paymentDate: match.date, linkedTo: linked,
      action: { type: "hold", invoiceId: inv.invoiceId, label: "Hold reminder",
        reason: `possible payment outside the invoice: a PayPal payment of the same amount on ${match.date}${linked ? ` (linked to ${linked})` : ""}; check before reminding about ${label}` } });
  }

  // c) Cash forecast (always, when anything is open). Money at stake: the shortfall against your target.
  if (open.length) {
    const f = plan.forecast;
    out.push({ id: "cash", kind: "cash_forecast", moneyAtStakeCents: f.shortfallCents, currency: open[0].currency, customer: null, action: null,
      expectedCents: f.expectedCents, targetCents: f.targetCents, shortfallCents: f.shortfallCents, horizonDays: f.horizonDays,
      confidence: f.confidence, confidenceNote: f.confidenceNote,
      top: f.byInvoice.filter((b) => b.expectedCents > 0).slice(0, 3).map((b) => ({ invoiceNumber: b.invoiceNumber, expectedCents: b.expectedCents, expectedDate: b.expectedDate })) });
  }

  // d) Slow payers with money still open.
  for (const c of plan.customers) {
    const h = c.history;
    if (h.paidInvoices < SLOW_MIN_PAID || h.avgDaysLate === null || h.avgDaysLate < SLOW_MIN_DAYS_LATE || c.openCents <= 0) continue;
    out.push({ id: `slow:${c.customer}`, kind: "slow_payer", moneyAtStakeCents: c.openCents, currency: c.invoices[0]?.currency ?? "USD", customer: c.customer, action: null,
      avgDaysLate: h.avgDaysLate, paidInvoices: h.paidInvoices, onTimeRatio: h.onTimeRatio, openCents: c.openCents });
  }

  const order: InsightKind[] = ["payment_plan_candidate", "possible_outside_payment", "cash_forecast", "slow_payer"];
  return out.sort((a, b) => b.moneyAtStakeCents - a.moneyAtStakeCents || order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id));
}

/** The briefing's cards: the top N, at most one per customer, so a single customer can't fill them all. */
export function topInsights(all: Insight[], n = 3): Insight[] {
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const i of all) {
    if (out.length >= n) break;
    if (i.customer && seen.has(i.customer)) continue;
    if (i.customer) seen.add(i.customer);
    out.push(i);
  }
  return out;
}
