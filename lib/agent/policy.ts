/**
 * Collections policy, decided in CODE. The model never chooses tone or whether
 * an invoice is too old to chase.
 */
import { z } from "zod";
import type { InvoiceRecord } from "./sweep";

export type Tone = "friendly" | "firm" | "final_notice";

export const NOTE_MAX_WORDS = 80;
export const SUBJECT_MAX_CHARS = 120;

/** No reminder until an invoice is at least this many days overdue. */
export const GRACE_DAYS = 3;

/** Appended by code to every note. The model never describes the email, buttons or links. */
export const CLOSING_LINE = "You can view and pay this invoice online through PayPal.";
export const SIGN_OFF = "Thank you.";

/**
 * The note PayPal will send: model-written body, then (only when code attached an offer) the
 * code-rendered offer sentence, then the fixed closing and sign-off.
 */
export function assembleNote(body: string, offer: Offer | null = null): string {
  return `${body.trim()}\n\n${offer ? `${offerSentence(offer)}\n\n` : ""}${CLOSING_LINE}\n\n${SIGN_OFF}`;
}

/** Words the model may use in the body, leaving room for the fixed closing and sign-off. */
export const BODY_MAX_WORDS = NOTE_MAX_WORDS - (CLOSING_LINE.split(/\s+/).length + SIGN_OFF.split(/\s+/).length);

/** 3–7 days friendly (after the grace period), 8–30 firm, 31–60 final notice, 61+ escalate (null). */
export function toneFor(daysOverdue: number): Tone | null {
  if (daysOverdue < GRACE_DAYS) throw new Error(`toneFor() called inside the ${GRACE_DAYS}-day grace period`);
  if (daysOverdue <= 7) return "friendly";
  if (daysOverdue <= 30) return "firm";
  if (daysOverdue <= 60) return "final_notice";
  return null;
}

export const ESCALATE_AFTER_DAYS = 60;

/** "$2,350.00". The note must contain this string verbatim. */
export function formatAmount(value: string, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));
}

/** "September 19, 2026" (calendar date, no timezone shift). The note must contain this verbatim. */
export function formatDueDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })
    .format(new Date(`${isoDate}T00:00:00Z`));
}

/** The facts a draft must state exactly, derived from the PayPal record by code. */
export type RequiredFacts = { invoiceNumber: string; amountDue: string; dueDate: string };

export function requiredFacts(r: InvoiceRecord): RequiredFacts {
  return {
    invoiceNumber: r.invoiceNumber ?? r.invoiceId,
    amountDue: formatAmount(r.amountDue ?? "0", r.currency),
    dueDate: formatDueDate(r.dueDate),
  };
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ---- Owner-defined payment plans ("pay in parts", PayPal partial payments) ----------------
//
// The owner sets the policy on /settings/incentives. Code decides whether an invoice is
// eligible and computes the terms; the drafter may only choose "payment_plan" or "none" and
// never writes a number. Code inserts the one offer sentence, the checks accept exactly that
// sentence and nothing else, and on approval the executor turns on PayPal's partial payments
// with the same minimum before sending the reminder. Not auto-charged installments: the
// customer chooses to pay part of the invoice through PayPal.

export const paymentPlanPolicySchema = z.object({
  enabled: z.boolean(),
  /** Only invoices with at least this much due (in the invoice's currency). */
  minInvoiceAmount: z.number().min(0).max(1_000_000),
  /** Only invoices at least this many days overdue. */
  minDaysOverdue: z.number().int().min(GRACE_DAYS).max(ESCALATE_AFTER_DAYS),
  /** At most this many parts. */
  maxParts: z.number().int().min(2).max(12),
  /** Every part is at least this much. */
  minPaymentAmount: z.number().min(1).max(1_000_000),
}).strict();
export type PaymentPlanPolicy = z.infer<typeof paymentPlanPolicySchema>;

/** Used until the owner saves a policy: offers are off. */
export const OFFERS_OFF: PaymentPlanPolicy = { enabled: false, minInvoiceAmount: 500, minDaysOverdue: 14, maxParts: 3, minPaymentAmount: 100 };

/** Concrete terms for one invoice. `minimumAmount` is what PayPal's minimum_amount_due is set to. */
export type Offer = { kind: "payment_plan"; parts: number; minimumAmount: string; currency: string };

/** The ONLY offer wording a note may contain. Rendered by code from the terms. */
export function offerSentence(o: Offer): string {
  return `You can pay this invoice in up to ${o.parts} parts of at least ${formatAmount(o.minimumAmount, o.currency)} each.`;
}

/** Card / UI wording. */
export function offerLabel(o: Offer): string {
  return `pay in up to ${o.parts} parts of at least ${formatAmount(o.minimumAmount, o.currency)}`;
}

/**
 * Terms for an amount under a policy (ignores eligibility). The minimum per part is the
 * policy's minimum payment, raised so the balance never needs more than maxParts parts.
 * Cents arithmetic, rounded up. null if that leaves fewer than 2 parts.
 */
export function offerTerms(amountDue: string, currency: string, policy: PaymentPlanPolicy): Offer | null {
  const due = Math.round(Number(amountDue) * 100);
  if (!Number.isFinite(due) || due <= 0) return null;
  const min = Math.max(Math.round(policy.minPaymentAmount * 100), Math.ceil(due / policy.maxParts));
  const parts = Math.ceil(due / min);
  if (parts < 2) return null;
  return { kind: "payment_plan", parts, minimumAmount: (min / 100).toFixed(2), currency };
}

export function sameOffer(a: Offer | null | undefined, b: Offer | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.parts === b.parts && a.minimumAmount === b.minimumAmount && a.currency === b.currency;
}

/** Eligibility, decided by code. `offer` null means no offer may be made; `why` says why (or what). */
export function offerFor(r: InvoiceRecord, policy: PaymentPlanPolicy): { offer: Offer | null; why: string } {
  const minAmount = formatAmount(String(policy.minInvoiceAmount), r.currency);
  if (!policy.enabled) return { offer: null, why: "payment plans are off" };
  if (r.flags.length) return { offer: null, why: `invoice text is flagged (${r.flags.join(", ")}): no offers` };
  if (Number(r.amountDue ?? 0) < policy.minInvoiceAmount) return { offer: null, why: `amount due is under ${minAmount}` };
  if (r.daysOverdue < policy.minDaysOverdue) return { offer: null, why: `less than ${policy.minDaysOverdue} days overdue` };
  const offer = offerTerms(r.amountDue ?? "0", r.currency, policy);
  if (!offer) return { offer: null, why: "the balance can't be split into parts of the minimum payment" };
  return { offer, why: `eligible: ${offerLabel(offer)}` };
}

/** Plan for one invoice in the run set: code decides draft-or-escalate before any model call. */
export type DraftPlan =
  | { invoiceId: string; action: "draft"; tone: Tone; facts: RequiredFacts; record: InvoiceRecord;
      /** The offer code allows for this invoice under the owner's policy (null: none allowed), and why. */
      offer: Offer | null; offerWhy: string }
  | { invoiceId: string; action: "escalate"; reason: string; record: InvoiceRecord };

/** `policy` defaults to offers off, so a caller that forgets it can never enable an offer. */
export function planFor(r: InvoiceRecord, policy: PaymentPlanPolicy = OFFERS_OFF): DraftPlan {
  const tone = toneFor(r.daysOverdue);
  if (!tone) {
    // No day count in the stored reason: it would go stale. Displays add the current count.
    return { invoiceId: r.invoiceId, action: "escalate", record: r,
      reason: `More than ${ESCALATE_AFTER_DAYS} days overdue: policy routes it to a human, no automated reminder` };
  }
  const { offer, why } = offerFor(r, policy);
  return { invoiceId: r.invoiceId, action: "draft", tone, facts: requiredFacts(r), record: r, offer, offerWhy: why };
}

/**
 * A held item's reason with today's day count. Policy reasons we wrote ("Policy: 75 days
 * overdue (over 60): ...", older format) get their number refreshed; newer ones get it added.
 * Only rewrites our own "Policy:" text, never critic or drafter reasons.
 */
export function currentReason(reason: string | null, daysOverdueNow: number | null): string | null {
  if (!reason || daysOverdueNow === null || !reason.startsWith("Policy:")) return reason;
  // Older format: the stale count sits right after "Policy: ". Don't touch "More than 60 days overdue".
  const old = /^(Policy: )\d+( days overdue\b)/;
  if (old.test(reason)) return reason.replace(old, `$1${daysOverdueNow}$2`);
  return `${reason} (now ${daysOverdueNow} days overdue)`;
}
