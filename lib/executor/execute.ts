import "server-only";
import { getStore, hashDraft, type Approval, type Proposal } from "@/lib/db";
import { ensureAccessToken, paypalRequest, PayPalError } from "@/lib/paypal/client";
import { getInvoice, type Invoice } from "@/lib/paypal/invoices";
import { RULES_VERSION } from "@/lib/agent/rules-version";
import { formatAmount, formatDueDate } from "@/lib/agent/policy";
import { executorEnabled, evaluateLimits, killActive, type LimitCheck } from "./limits";
import { hashToken } from "./token";

/**
 * EXECUTOR: code, not a model. The only path by which an agent draft reaches a customer.
 *
 *   KILL? → claim token (atomic, single use) → proposal approved + hash intact + current rules
 *   → re-fetch invoice → still unpaid and facts unchanged → 7-day / daily cap / quiet hours
 *   → KILL again → (dry run stops here) → OAuth token → ONE remind call, no retry → burn token.
 *
 * Token rule: release a claimed token ONLY when the request definitely never left (a check
 * failed before sending, connection refused, PayPal rejected it with a 4xx). A timeout, a 5xx
 * or any other ambiguous error = outcome unknown: the token is NOT released, the proposal is
 * blocked for a human, and the customer may or may not have been emailed. Treat it like a
 * crash. (The Invoicing API doesn't dedupe on PayPal-Request-Id, so a retry could double-send.)
 */

export const SEND_TIMEOUT_MS = 20_000;
const CHASEABLE = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);

export type Outcome =
  | "sent"      // PayPal accepted; ledger written; token burned
  | "dry_run"   // every check passed; PayPal not called (KAIROS_EXECUTOR_ENABLED != 1)
  | "deferred"  // a send-time bound said "not now" (KILL, quiet hours, cap, cooldown); try later
  | "skipped"   // nothing to send any more (invoice paid/cancelled/changed)
  | "failed"    // definitely not sent (PayPal rejected it, or couldn't connect)
  | "unknown"   // may or may not have been sent: blocked for a human
  | "rejected"  // token invalid, expired or already used
  | "blocked";  // integrity problem (hash, rules, state): blocked for a human

export type Step = { name: string; ok: boolean; detail: string };

export type RemindRequest = { method: "POST"; path: string; body: { subject?: string; note?: string; send_to_recipient: true; send_to_invoicer: false } };

export type ExecutionResult = {
  outcome: Outcome;
  reason: string;
  proposalId: string | null;
  invoiceId: string | null;
  steps: Step[];
  request: RemindRequest | null;
  tokenReleased: boolean;
  ledgerId?: string;
  debugId?: string;
};

// ---- Dependencies (swappable in tests) ------------------------------------------

export type ExecutorDeps = {
  fetchInvoice(id: string): Promise<Invoice>;
  ensureToken(): Promise<void>;
  /** Exactly one HTTP attempt. Throws PayPalError for non-2xx, or the fetch/timeout error. */
  send(req: RemindRequest, requestId: string): Promise<void>;
  killActive(): boolean;
  enabled(): boolean;
};

const realDeps: ExecutorDeps = {
  fetchInvoice: getInvoice,
  ensureToken: ensureAccessToken,
  send: async (req, requestId) => {
    await paypalRequest(req.path, { method: "POST", body: req.body, requestId, noRetry: true, timeoutMs: SEND_TIMEOUT_MS });
  },
  killActive,
  enabled: executorEnabled,
};
let deps: ExecutorDeps = realDeps;

/** The live dependencies (shared with the manual Remind path). */
export function executorDeps(): ExecutorDeps {
  return deps;
}

/** Tests only. */
export function setExecutorDepsForTesting(d: Partial<ExecutorDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

// ---- Helpers ---------------------------------------------------------------------

export function remindRequestFor(p: Pick<Proposal, "invoiceId" | "subject" | "note">): RemindRequest {
  return {
    method: "POST",
    path: `/v2/invoicing/invoices/${encodeURIComponent(p.invoiceId)}/remind`,
    body: { subject: p.subject ?? undefined, note: p.note ?? undefined, send_to_recipient: true, send_to_invoicer: false },
  };
}

const NOT_SENT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
]);

/** Did the remind request definitely not reach PayPal (safe to release), or is it unknown? */
export function classifySendError(err: unknown): { sent: "no" | "unknown"; detail: string; debugId?: string } {
  if (err instanceof PayPalError) {
    // PayPal answered: 4xx (incl. 429) = rejected without processing; 5xx = may have processed.
    return err.status < 500
      ? { sent: "no", detail: `PayPal rejected the request: HTTP ${err.status} ${err.name}: ${err.message}`, debugId: err.debugId }
      : { sent: "unknown", detail: `PayPal returned HTTP ${err.status} ${err.name}; the reminder may or may not have gone out`, debugId: err.debugId };
  }
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return { sent: "unknown", detail: `no response within ${SEND_TIMEOUT_MS / 1000}s; the reminder may or may not have gone out` };
  }
  const code = e?.cause?.code ?? e?.code;
  if (code && NOT_SENT_CODES.has(code)) return { sent: "no", detail: `could not connect to PayPal (${code})` };
  return { sent: "unknown", detail: `connection failed mid-request (${code ?? e?.name ?? "unknown error"}: ${e?.message ?? ""}); the reminder may or may not have gone out` };
}

/** The facts the note states must still be true of the live invoice. */
function factsStillTrue(p: Proposal, inv: Invoice): Step {
  const due = inv.due_amount?.value ?? inv.amount?.value ?? "0";
  const dueDate = inv.detail.payment_term?.due_date ?? inv.detail.invoice_date ?? "";
  const facts = [inv.detail.invoice_number ?? inv.id, formatAmount(due, inv.detail.currency_code), dueDate ? formatDueDate(dueDate) : ""];
  const missing = facts.filter((f) => f && !(p.note ?? "").includes(f));
  return missing.length
    ? { name: "facts_unchanged", ok: false, detail: `the note no longer matches the invoice (now: ${facts.join(", ")})` }
    : { name: "facts_unchanged", ok: true, detail: `${facts.join(", ")} still correct` };
}

// ---- Checks shared by preview and execution (read-only) ----------------------------

type Precheck =
  | { ok: true; steps: Step[]; inv: Invoice }
  | { ok: false; steps: Step[]; outcome: Outcome; reason: string; terminal: "skipped" | "blocked" | "deferred" | "failed" };

async function precheck(p: Proposal, approval: Pick<Approval, "draftHash"> | null): Promise<Precheck> {
  const steps: Step[] = [];
  const stop = (outcome: Outcome, terminal: "skipped" | "blocked" | "deferred" | "failed", reason: string): Precheck => ({ ok: false, steps, outcome, reason, terminal });

  if (p.kind !== "reminder") { steps.push({ name: "proposal", ok: false, detail: "escalations are never sent" }); return stop("blocked", "blocked", "escalations are never sent"); }
  const intact = hashDraft(p) === p.draftHash && (!approval || approval.draftHash === p.draftHash);
  steps.push({ name: "draft_hash", ok: intact, detail: intact ? `content matches ${p.draftHash.slice(0, 12)}…${approval ? " and the approval" : ""}` : "draft content, stored hash and approval hash disagree" });
  if (!intact) return stop("blocked", "blocked", "draft hash mismatch");
  const current = p.rulesVersion === RULES_VERSION;
  steps.push({ name: "rules_version", ok: current, detail: current ? RULES_VERSION : `drafted under ${p.rulesVersion ?? "(unversioned)"}, current ${RULES_VERSION}` });
  if (!current) return stop("blocked", "blocked", "stale rules version");

  let inv: Invoice;
  try {
    inv = await deps.fetchInvoice(p.invoiceId);
  } catch (err) {
    steps.push({ name: "refetch_invoice", ok: false, detail: `couldn't fetch the invoice: ${(err as Error).message}` });
    return stop("failed", "failed", "couldn't re-fetch the invoice; nothing was sent");
  }
  const chaseable = CHASEABLE.has(inv.status);
  steps.push({ name: "refetch_invoice", ok: chaseable, detail: `status ${inv.status}, due ${inv.due_amount?.value ?? "?"} ${inv.detail.currency_code}` });
  if (!chaseable) return stop("skipped", "skipped", `invoice is ${inv.status}; no reminder needed`);
  const facts = factsStillTrue(p, inv);
  steps.push(facts);
  if (!facts.ok) return stop("skipped", "skipped", facts.detail);

  const limits: LimitCheck[] = await evaluateLimits(p.invoiceId);
  for (const l of limits) steps.push({ name: l.name, ok: l.ok, detail: l.detail });
  const blocked = limits.find((l) => !l.ok);
  if (blocked) return stop("deferred", "deferred", `${blocked.name.replace("_", " ")}: ${blocked.detail}`);
  return { ok: true, steps, inv };
}

/** What executing this proposal would do right now. Read-only: no token, no claim, no send. */
export async function previewExecution(proposalId: string): Promise<ExecutionResult> {
  const p = await getStore().getProposal(proposalId);
  if (!p) return { outcome: "rejected", reason: "proposal not found", proposalId, invoiceId: null, steps: [], request: null, tokenReleased: false };
  const pre = await precheck(p, null);
  const request = p.kind === "reminder" ? remindRequestFor(p) : null;
  if (!pre.ok) return { outcome: pre.outcome, reason: pre.reason, proposalId, invoiceId: p.invoiceId, steps: pre.steps, request, tokenReleased: false };
  return {
    outcome: deps.enabled() ? "sent" : "dry_run",
    reason: deps.enabled() ? "all checks pass; would send now" : "all checks pass; executor is in dry-run mode",
    proposalId, invoiceId: p.invoiceId, steps: pre.steps, request, tokenReleased: false,
  };
}

// ---- Execution -------------------------------------------------------------------------

export async function executeApproval(token: string): Promise<ExecutionResult> {
  const store = getStore();
  const tokenHash = hashToken(token);
  const steps: Step[] = [];
  let proposal: Proposal | null = null;
  let approval: Approval | null = null;

  const audit = (event: string, data: Record<string, unknown>) =>
    store.audit({ actor: "executor", event: `executor.${event}`, entityType: "proposal", entityId: proposal?.id ?? approval?.proposalId ?? null,
      data: { approvalId: approval?.id ?? null, invoiceId: proposal?.invoiceId ?? null, ...data } });

  const finish = async (outcome: Outcome, reason: string, opts: { release?: boolean; proposalTo?: "passed" | "skipped" | "blocked"; request?: RemindRequest | null; ledgerId?: string; debugId?: string } = {}): Promise<ExecutionResult> => {
    if (opts.release && approval) await store.releaseApproval(approval.id);
    if (opts.proposalTo && proposal) {
      await store.updateProposalStatus(proposal.id, {
        status: opts.proposalTo,
        reason: opts.proposalTo === "passed" ? null : `${outcome === "unknown" ? "Send outcome UNKNOWN" : "Executor"}: ${reason}`,
      }, ["approved"]);
    }
    await audit(outcome, { reason, steps, tokenReleased: !!opts.release, proposalTo: opts.proposalTo ?? null, debugId: opts.debugId ?? null, ledgerId: opts.ledgerId ?? null, request: opts.request ?? null });
    return { outcome, reason, proposalId: proposal?.id ?? approval?.proposalId ?? null, invoiceId: proposal?.invoiceId ?? null, steps,
      request: opts.request ?? null, tokenReleased: !!opts.release, ledgerId: opts.ledgerId, debugId: opts.debugId };
  };

  // 0. KILL halts everything, before the token is even claimed.
  approval = await store.getApprovalByTokenHash(tokenHash);
  if (deps.killActive()) {
    steps.push({ name: "kill", ok: false, detail: "KILL file present" });
    if (approval) proposal = await store.getProposal(approval.proposalId);
    return finish("deferred", "KILL file present: all sending is halted", { proposalTo: "passed" });
  }

  // 1. Claim: atomic, single use, unexpired.
  const claim = await store.claimApproval(tokenHash);
  steps.push({ name: "token", ok: claim.ok, detail: claim.ok ? `claimed approval ${claim.approval.id}` : claim.reason });
  if (!claim.ok) return finish("rejected", `token ${claim.reason.replace("_", " ")}`);
  approval = claim.approval;

  // 2. Proposal state.
  proposal = await store.getProposal(approval.proposalId);
  if (!proposal || proposal.status !== "approved") {
    steps.push({ name: "proposal", ok: false, detail: proposal ? `status is ${proposal.status}` : "not found" });
    return finish("blocked", "proposal is not in the approved state", { release: true });
  }
  steps.push({ name: "proposal", ok: true, detail: `${proposal.id} approved` });

  // 3-5. Integrity, rules, re-fetched invoice, facts, bounds.
  const pre = await precheck(proposal, approval);
  steps.push(...pre.steps);
  const request = remindRequestFor(proposal);
  if (!pre.ok) {
    const to = pre.terminal === "skipped" ? "skipped" : pre.terminal === "blocked" ? "blocked" : "passed";
    return finish(pre.outcome, pre.reason, { release: true, proposalTo: to, request });
  }

  // 6. KILL again, right before sending.
  if (deps.killActive()) {
    steps.push({ name: "kill_again", ok: false, detail: "KILL file appeared during checks" });
    return finish("deferred", "KILL file present: all sending is halted", { release: true, proposalTo: "passed", request });
  }

  // 7. Dry run stops here.
  if (!deps.enabled()) {
    steps.push({ name: "send", ok: false, detail: "dry run: KAIROS_EXECUTOR_ENABLED is not 1; PayPal was not called" });
    return finish("dry_run", "all checks passed; dry run, nothing sent", { release: true, proposalTo: "passed", request });
  }

  // 8. OAuth first: a failure here means the reminder definitely never left.
  try {
    await deps.ensureToken();
  } catch (err) {
    steps.push({ name: "paypal_auth", ok: false, detail: (err as Error).message });
    return finish("failed", "couldn't get a PayPal access token; nothing was sent", { release: true, proposalTo: "passed", request });
  }

  // 9. The send: exactly one attempt.
  try {
    await deps.send(request, approval.id);
  } catch (err) {
    const c = classifySendError(err);
    steps.push({ name: "send", ok: false, detail: c.detail });
    return c.sent === "no"
      ? finish("failed", c.detail, { release: true, proposalTo: "passed", request, debugId: c.debugId })
      : finish("unknown", `${c.detail}. Check the invoice's history in PayPal before doing anything else.`, { release: false, proposalTo: "blocked", request, debugId: c.debugId });
  }
  steps.push({ name: "send", ok: true, detail: "PayPal accepted the reminder" });

  // 10. Burn the token, write the ledger, mark sent, atomically.
  try {
    const entry = await store.recordAgentSend({ approvalId: approval.id, proposalId: proposal.id, invoiceId: proposal.invoiceId, subject: proposal.subject, note: proposal.note });
    return finish("sent", "reminder sent", { request, ledgerId: entry.id });
  } catch (err) {
    // PayPal sent it but we couldn't record it. Don't release; block for a human with a loud reason.
    steps.push({ name: "ledger", ok: false, detail: (err as Error).message });
    return finish("unknown", `PayPal accepted the reminder but recording it failed (${(err as Error).message}). It WAS sent; reconcile manually.`, { proposalTo: "blocked", request });
  }
}
