import { createHash } from "node:crypto";
import { CHECK_PATTERNS, decide, type CheckId, type Issue } from "./checks";
import { CRITIC_SYSTEM } from "./critic";
import { DRAFTER_SYSTEM, TONE_GUIDE } from "./drafter";
import { currentPolicy } from "./incentives";
import { DIRECTOR_PARAMS, direct } from "../director/model";
import {
  BODY_MAX_WORDS, CLOSING_LINE, ESCALATE_AFTER_DAYS, GRACE_DAYS, NOTE_MAX_WORDS, SIGN_OFF, SUBJECT_MAX_CHARS,
  DIRECTOR_DEFAULT, assembleNote, offerTerms, toneFor, type DirectorSettings, type PaymentPlanPolicy,
} from "./policy";

/**
 * Fingerprint of everything that decides what a draft may say and whether it passes:
 * drafter prompt + tone guide, policy constants and tone thresholds, check patterns,
 * the decision rule, and the critic prompt. Every proposal is stamped with it; the queue
 * refuses to approve a proposal made under a different version ("stale: re-run").
 *
 * Built from strings, regex sources and BEHAVIOUR (outputs over fixed inputs), never
 * function source, so it is identical in tsx scripts and the minified Next.js build.
 */

/** Bump when check or pipeline logic changes in a way the inputs below don't capture. */
export const RULES_LOGIC_REVISION = 3;

function directorSample() {
  const inv = (id: string, customer: string, status: string, due: number, dueDate: string, payments: { date: string; cents: number; method: string | null }[] = []) =>
    ({ invoiceId: id, invoiceNumber: id, status, customer, currency: "USD", totalCents: due, dueCents: status.includes("PAID") && status !== "PARTIALLY_PAID" ? 0 : due, invoiceDate: null, dueDate, payments, flagged: false });
  const plan = direct({
    today: "2026-11-10", cashTarget14d: 1000, received: [],
    paymentPlan: { enabled: true, minInvoiceAmount: 500, minDaysOverdue: 7, maxParts: 3, minPaymentAmount: 100 },
    sends: [{ invoiceId: "c", date: "2026-11-01", offer: false }],
    invoices: [
      inv("a", "x@e", "PAID", 50000, "2026-09-01", [{ date: "2026-08-28", cents: 50000, method: null }]),
      inv("b", "x@e", "SENT", 25000, "2026-11-05"),
      inv("c", "y@e", "SENT", 235000, "2026-09-23"),
      inv("d", "z@e", "PARTIALLY_PAID", 44000, "2026-11-04", [{ date: "2026-11-08", cents: 20000, method: null }]),
    ],
  });
  return plan.moves.map((m) => [m.invoiceId, m.pressure, m.move, m.day]);
}

function fingerprint(): string {
  const tones = Array.from({ length: 120 - GRACE_DAYS + 1 }, (_, i) => toneFor(GRACE_DAYS + i));
  const checks: CheckId[] = ["a", "b", "c", "d"];
  const issue = (check: CheckId, source: "code" | "critic"): Issue => ({ check, source, problem: "x" });
  const decisions = [
    ...checks.flatMap((k) => [decide([issue(k, "code")], []).decision, decide([], [issue(k, "critic")]).decision]),
    decide([], []).decision, decide([], "critic failed").decision, decide([], "no verdict").decision,
  ];
  const material = {
    logic: RULES_LOGIC_REVISION,
    drafter: DRAFTER_SYSTEM,
    toneGuide: TONE_GUIDE,
    critic: CRITIC_SYSTEM,
    policy: { NOTE_MAX_WORDS, SUBJECT_MAX_CHARS, BODY_MAX_WORDS, GRACE_DAYS, ESCALATE_AFTER_DAYS, CLOSING_LINE, SIGN_OFF, tones },
    patterns: Object.fromEntries(Object.entries(CHECK_PATTERNS).map(([k, re]) => [k, `${re.source}/${re.flags}`])),
    decisions,
    // Offer rendering and terms, as behaviour over fixed inputs.
    offers: [
      assembleNote("B", { kind: "payment_plan", parts: 3, minimumAmount: "783.34", currency: "USD" }),
      ...["95.00", "640.00", "2350.00", "10000.00"].map((a) => offerTerms(a, "USD", { enabled: true, minInvoiceAmount: 0, minDaysOverdue: GRACE_DAYS, maxParts: 4, minPaymentAmount: 250 })),
    ],
    // The Director: its parameters, and its behaviour over a fixed input.
    director: { params: DIRECTOR_PARAMS, sample: directorSample() },
  };
  return `r-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12)}`;
}

/** The CODE part of the rules version (prompts, patterns, policy constants). */
export const RULES_VERSION = fingerprint();

/**
 * The full rules version: code fingerprint + the owner's incentive policy values. Saving a
 * different policy makes every existing draft stale (it can't be approved or sent).
 */
export function rulesVersionFor(policy: PaymentPlanPolicy, director: DirectorSettings = DIRECTOR_DEFAULT): string {
  const values = [policy.enabled, policy.minInvoiceAmount, policy.minDaysOverdue, policy.maxParts, policy.minPaymentAmount, director.cashTarget14d];
  return `${RULES_VERSION}.p-${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 8)}`;
}

export async function currentRulesVersion(): Promise<string> {
  const c = await currentPolicy();
  return rulesVersionFor(c.policy, c.director);
}
