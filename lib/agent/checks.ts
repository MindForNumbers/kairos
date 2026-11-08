/**
 * Deterministic draft checks (code, not model). Run alongside the critic; a failure from
 * either counts.
 *   a: facts match the record exactly (+ format rules: no day counts, word limit, fixed closing)
 *   b: no discounts, waivers, extensions or status changes (pattern scan)
 *   c: no other customer's data (pattern scan against every invoice the run knows about)
 *   d: each draft traces to exactly one overdue invoice in this run's set
 *   e: every draftable invoice in the set has a draft or an escalation
 */
import type { Draft } from "./drafter";
import {
  CLOSING_LINE, GRACE_DAYS, NOTE_MAX_WORDS, SIGN_OFF, formatAmount, wordCount, type DraftPlan,
} from "./policy";

export type CheckId = "a" | "b" | "c" | "d" | "e";
export type Issue = { check: CheckId; problem: string; source: "code" | "critic" };

/** What code knows about every invoice in the account, so (c) can spot leaks. */
export type KnownInvoice = { invoiceId: string; invoiceNumber: string | null; amountDue: string | null; currency: string; recipientEmail: string | null; recipientName: string | null };

const MONEY = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|CAD|AUD|dollars?)\b|\b(?:USD|EUR|GBP|CAD|AUD)\s?\d[\d,]*(?:\.\d+)?)/gi;
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|several|a few|few|many|multiple|some";
const DURATION = new RegExp(`\\b(?:\\d+|${NUMBER_WORDS})\\s+(?:business\\s+|calendar\\s+|full\\s+)?(?:days?|weeks?|months?|years?)\\b|\\bfor\\s+(?:some|quite\\s+some|a\\s+(?:long|while))\\s*(?:time|while)?\\b|\\b(?:a|one)\\s+(?:day|week|month)\\b`, "i");
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE = new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b|\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b(?:by|before|until)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next\\s+\\w+|end\\s+of\\s+\\w+)\\b`, "gi");
const EMAIL_DESCRIPTION = /\b(?:button|click|link|below|attached|this email|the email)\b/i;
const THREAT = /\b(?:late fees?|penalt(?:y|ies)|interest charges?|collections?|legal action|lawyer|attorney|court|suspend(?:ed)?|terminat(?:e|ed|ion)|credit (?:report|score))\b/i;
const CONCESSION = /\b(?:discount(?:ed|s)?|\d{1,3}\s?(?:%|percent)(?:\s+off)?|percent\s+off|waive[ds]?|waiver|forgiv(?:e|en|eness)|write[- ]?off|written off|extension|extend(?:ed|ing)?|payment plan|instal(?:l)?ments?|split (?:the |your )?payment|partial payment|refund(?:ed)?|credit(?:ed)?|reduc(?:e|ed|tion)|lower(?:ed)? (?:amount|price|balance)|no (?:rush|hurry)|take your time|whenever you (?:can|like|want)|no longer (?:owe|due)|grace period|when(?:ever)?\s+(?:it(?:'|’)?s\s+|it\s+is\s+)?convenient|at\s+your\s+(?:earliest\s+)?convenience|when(?:ever)?\s+(?:you\s+)?(?:can|are able)\b|when\s+you\s+(?:have|get)\s+(?:a\s+)?(?:moment|chance|minute)|if\s+you\s+have\s+a\s+(?:moment|chance|minute)|work\s+(?:something|this|it|things)\s+out|work\s+with\s+you|figure\s+(?:something|this|it)\s+out|(?:come\s+to|make|set\s+up)\s+(?:an?\s+)?(?:arrangement|agreement)|arrangement|flexib(?:le|ility)|if\s+(?:the\s+full\s+amount|paying|payment|it)\s+is\s+(?:difficult|hard|a\s+problem|tough|an?\s+issue)|(?:need|want)\s+(?:more|extra|additional)\s+time)\b/i;
const STATUS_CLAIM = /\b(?:has been|have been|is|was|been|now|marked|mark(?:ed)?|consider(?:ed)?)\s+(?:as\s+)?(?:fully\s+)?(?:paid|settled|cancel+ed|voided?|closed|resolved)\b|\bmark(?:ed|ing)?\b.{0,30}\b(?:paid|settled|closed)\b/i;

/** Every pattern the checks use, for the rules version fingerprint. */
export const CHECK_PATTERNS = { MONEY, EMAIL, DURATION, DATE, EMAIL_DESCRIPTION, THREAT, CONCESSION, STATUS_CLAIM };

const norm = (s: string) => s.replace(/[\s,]/g, "").toLowerCase();

export function checkDraft(draft: Draft, plan: Extract<DraftPlan, { action: "draft" }>, known: KnownInvoice[]): Issue[] {
  const issues: Issue[] = [];
  const add = (check: CheckId, problem: string) => issues.push({ check, problem, source: "code" });
  const { note, subject } = draft;
  const text = `${subject}\n${note}`;
  const f = plan.facts;
  const others = known.filter((k) => k.invoiceId !== plan.invoiceId);

  // ---- (c) other customers' data: checked first so a leaked amount counts as (c), not (a)
  const email = text.match(EMAIL);
  if (email) add("c", `contains an email address (${email[0]})`);
  for (const o of others) {
    if (o.invoiceNumber && new RegExp(`\\b${o.invoiceNumber.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text)) add("c", `mentions another invoice number (${o.invoiceNumber})`);
    if (text.includes(o.invoiceId)) add("c", `mentions another invoice ID (${o.invoiceId})`);
    const name = o.recipientName?.trim();
    if (name && name.length >= 4 && name !== plan.record.untrusted.recipientName && new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text)) add("c", `contains another customer's name`);
  }
  const ownAmount = norm(f.amountDue);
  const otherAmounts = new Set(others.filter((o) => o.amountDue).map((o) => norm(formatAmount(o.amountDue!, o.currency))));

  // ---- (a) exact facts and format
  if (!note.includes(f.invoiceNumber)) add("a", `note does not contain the invoice number "${f.invoiceNumber}" exactly`);
  if (!note.includes(f.amountDue)) add("a", `note does not contain the amount due "${f.amountDue}" exactly`);
  if (!note.includes(f.dueDate)) add("a", `note does not contain the due date "${f.dueDate}" exactly`);
  for (const m of text.match(MONEY) ?? []) {
    const n = norm(m);
    if (n === ownAmount) continue;
    if (otherAmounts.has(n)) add("c", `states another invoice's amount (${m.trim()})`);
    else add("a", `states an amount that is not the amount due (${m.trim()})`);
  }
  const dur = text.match(DURATION);
  if (dur) add("a", `states a duration or day count ("${dur[0]}"); these go stale while awaiting approval`);
  if (wordCount(note) > NOTE_MAX_WORDS) add("a", `note is ${wordCount(note)} words (max ${NOTE_MAX_WORDS})`);
  if (!note.endsWith(`${CLOSING_LINE}\n\n${SIGN_OFF}`)) add("a", "note does not end with the fixed closing line and sign-off");
  const body = note.slice(0, Math.max(0, note.length - CLOSING_LINE.length - SIGN_OFF.length - 4));
  const desc = body.match(EMAIL_DESCRIPTION);
  if (desc) add("a", `describes the email or how to pay ("${desc[0]}")`);
  const threat = text.match(THREAT);
  if (threat) add("a", `contains a threat or consequence ("${threat[0]}")`);

  // ---- (b) concessions and status changes
  const conc = text.match(CONCESSION);
  if (conc) add("b", `concession language ("${conc[0]}")`);
  const status = text.match(STATUS_CLAIM);
  if (status) add("b", `claims or requests a status change ("${status[0]}")`);
  for (const m of text.match(DATE) ?? []) {
    if (norm(m) !== norm(f.dueDate)) add("b", `uses a date other than the due date ("${m}"), which reads as a new deadline`);
  }

  // ---- (d) traces to one overdue invoice in the set
  if (draft.invoiceId !== plan.invoiceId) add("d", "draft is attached to a different invoice than its plan");
  if (plan.record.daysOverdue < GRACE_DAYS) add("d", `invoice is not past the ${GRACE_DAYS}-day grace period`);
  if (draft.tone !== plan.tone) add("d", "tone does not match policy");
  return dedupe(issues);
}

/** (e): draftable invoices in the set with neither a draft nor an escalation. */
export function checkCoverage(plans: DraftPlan[], covered: Set<string>): { invoiceId: string; issue: Issue }[] {
  return plans
    .filter((p) => p.action === "draft" && !covered.has(p.invoiceId))
    .map((p) => ({ invoiceId: p.invoiceId, issue: { check: "e" as const, problem: `no draft or escalation for ${p.record.invoiceNumber ?? p.invoiceId}`, source: "code" as const } }));
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.check + i.problem) ? false : (seen.add(i.check + i.problem), true)));
}

export type CriticVerdict = Issue[] | "no verdict" | "critic failed";
export type Decision = { decision: "passed" | "revise" | "blocked"; reason: string | null };

/**
 * The rule, in one place: a failure from code OR critic counts.
 *   critic failed / no verdict → blocked (a human decides)
 *   any (b) or (c)             → blocked
 *   any (a) or (d)             → revise
 *   otherwise                  → passed
 */
export function decide(code: Issue[], critic: CriticVerdict, criticFailure: string | null = null): Decision {
  if (!Array.isArray(critic)) {
    return { decision: "blocked", reason: critic === "critic failed" ? `Critic failed (${criticFailure ?? "not run"}); needs a human` : "Critic returned no verdict; needs a human" };
  }
  const issues = [...code, ...critic];
  const hard = issues.filter((i) => i.check === "b" || i.check === "c");
  if (hard.length) return { decision: "blocked", reason: hard.map((i) => `(${i.check}, ${i.source}) ${i.problem}`).join("; ") };
  if (issues.length) return { decision: "revise", reason: null };
  return { decision: "passed", reason: null };
}

/** Kept for reference in prompts and the UI. */
export const CHECK_LABELS: Record<CheckId, string> = {
  a: "amount, due date and invoice number match the record",
  b: "no discounts, waivers, extensions or status changes",
  c: "no other customer's data",
  d: "traces to exactly one overdue invoice in this run",
  e: "no overdue invoice in this run left out",
};

