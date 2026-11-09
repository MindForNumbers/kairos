/**
 * Collections policy, decided in CODE. The model never chooses tone or whether
 * an invoice is too old to chase.
 */
import type { InvoiceRecord } from "./sweep";

export type Tone = "friendly" | "firm" | "final_notice";

export const NOTE_MAX_WORDS = 80;
export const SUBJECT_MAX_CHARS = 120;

/** No reminder until an invoice is at least this many days overdue. */
export const GRACE_DAYS = 3;

/** Appended by code to every note. The model never describes the email, buttons or links. */
export const CLOSING_LINE = "You can view and pay this invoice online through PayPal.";
export const SIGN_OFF = "Thank you.";

/** The note PayPal will send: model-written body + fixed closing + sign-off. */
export function assembleNote(body: string): string {
  return `${body.trim()}\n\n${CLOSING_LINE}\n\n${SIGN_OFF}`;
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

/** Plan for one invoice in the run set: code decides draft-or-escalate before any model call. */
export type DraftPlan =
  | { invoiceId: string; action: "draft"; tone: Tone; facts: RequiredFacts; record: InvoiceRecord }
  | { invoiceId: string; action: "escalate"; reason: string; record: InvoiceRecord };

export function planFor(r: InvoiceRecord): DraftPlan {
  const tone = toneFor(r.daysOverdue);
  if (!tone) {
    // No day count in the stored reason: it would go stale. Displays add the current count.
    return { invoiceId: r.invoiceId, action: "escalate", record: r,
      reason: `More than ${ESCALATE_AFTER_DAYS} days overdue: policy routes it to a human, no automated reminder` };
  }
  return { invoiceId: r.invoiceId, action: "draft", tone, facts: requiredFacts(r), record: r };
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
