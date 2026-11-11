import { createHash } from "node:crypto";
import { CHECK_PATTERNS, decide, type CheckId, type Issue } from "./checks";
import { CRITIC_SYSTEM } from "./critic";
import { DRAFTER_SYSTEM, TONE_GUIDE } from "./drafter";
import { currentPolicy } from "./incentives";
import {
  BODY_MAX_WORDS, CLOSING_LINE, ESCALATE_AFTER_DAYS, GRACE_DAYS, NOTE_MAX_WORDS, SIGN_OFF, SUBJECT_MAX_CHARS,
  assembleNote, offerTerms, toneFor, type PaymentPlanPolicy,
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
export const RULES_LOGIC_REVISION = 2;

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
  };
  return `r-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12)}`;
}

/** The CODE part of the rules version (prompts, patterns, policy constants). */
export const RULES_VERSION = fingerprint();

/**
 * The full rules version: code fingerprint + the owner's incentive policy values. Saving a
 * different policy makes every existing draft stale (it can't be approved or sent).
 */
export function rulesVersionFor(policy: PaymentPlanPolicy): string {
  const values = [policy.enabled, policy.minInvoiceAmount, policy.minDaysOverdue, policy.maxParts, policy.minPaymentAmount];
  return `${RULES_VERSION}.p-${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 8)}`;
}

export async function currentRulesVersion(): Promise<string> {
  return rulesVersionFor((await currentPolicy()).policy);
}
