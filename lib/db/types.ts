/**
 * Storage contract for Kairos. Everything outside lib/db/ depends only on this file
 * (via "@/lib/db"), so the SQLite engine can be swapped for Postgres without touching callers.
 *
 * Rules every implementation must uphold:
 *  - audit_log and send_ledger are append-only (no UPDATE/DELETE).
 *  - A proposal's content (invoice, kind, tone, subject, note, draft hash) is immutable once written.
 *    A revision is a new proposal row pointing at its parent.
 *  - Approval tokens are stored only as hashes. Claim, burn and release are atomic.
 *  - Timestamps are ISO-8601 UTC strings.
 */

export type RunStatus = "running" | "completed" | "failed";

export type Run = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  /** Sweep output: the invoice records the run was given (already sanitized). */
  sweep: unknown;
  /** End-of-run summary: proposals made, deferred invoices, warnings. */
  report: unknown;
};

export type ProposalKind = "reminder" | "escalate";

export type ProposalStatus =
  | "pending_review" // waiting on the critic
  | "revised"        // superseded by a child revision
  | "passed"         // critic and code checks passed: in the approval queue
  | "blocked"        // failed (b) or (c), or out of revisions: becomes an escalation
  | "escalated"      // needs a human; never sendable
  | "approved"       // a token was minted
  | "sent"
  | "skipped"        // the executor declined (paid, cap, quiet hours, KILL…)
  | "rejected";      // a human rejected it

export type DraftContent = {
  invoiceId: string;
  kind: ProposalKind;
  tone: string | null;
  subject: string | null;
  note: string | null;
};

export type Proposal = DraftContent & {
  id: string;
  runId: string;
  parentId: string | null;
  revision: number;
  /** sha256 over the canonical draft content. Approval tokens are bound to it. */
  draftHash: string;
  status: ProposalStatus;
  /** Why it was escalated or blocked (from the drafter, critic or code checks). */
  reason: string | null;
  /** Critic verdict plus code-check results, stored as data. */
  review: unknown;
  createdAt: string;
  updatedAt: string;
  /** Rules fingerprint (lib/agent/rules-version.ts) the proposal was made and reviewed under. null = before stamping. */
  rulesVersion: string | null;
  /** Set when a human resolved or dismissed a blocked/escalated proposal. Frees the invoice for future runs. */
  resolution: Resolution | null;
};

export type ResolutionAction = "resolved" | "dismissed";
export type Resolution = { action: ResolutionAction; note: string | null; actor: string; at: string };

export type Approval = {
  id: string;
  proposalId: string;
  draftHash: string;
  approvedBy: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  usedAt: string | null;
};

export type SendSource = "agent" | "manual";

export type LedgerEntry = {
  id: string;
  invoiceId: string;
  source: SendSource;
  proposalId: string | null;
  approvalId: string | null;
  subject: string | null;
  note: string | null;
  actor: string;
  sentAt: string;
};

export type AuditEvent = {
  id: number;
  at: string;
  actor: string;          // "sweep", "drafter", "critic", "executor", "user:<name>", "system"
  event: string;          // dotted name, e.g. "critic.verdict", "executor.skip.quiet_hours"
  entityType: string | null;
  entityId: string | null;
  data: unknown;
};

export type ModelCall = {
  id: number;
  at: string;
  runId: string | null;
  purpose: string;
  model: string;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

export type ClaimResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "in_progress" };

export interface Store {
  // runs
  createRun(sweep: unknown): Promise<Run>;
  finishRun(id: string, status: Exclude<RunStatus, "running">, report: unknown): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  listRuns(limit?: number): Promise<Run[]>;

  // proposals
  createProposal(input: DraftContent & { runId: string; parentId?: string | null; status?: ProposalStatus; reason?: string | null; rulesVersion?: string | null }): Promise<Proposal>;
  /** Only status, reason and review can change. `expected` makes the transition a compare-and-set. */
  updateProposalStatus(id: string, patch: { status: ProposalStatus; reason?: string | null; review?: unknown }, expected?: ProposalStatus[]): Promise<boolean>;
  getProposal(id: string): Promise<Proposal | null>;
  listProposals(filter?: { status?: ProposalStatus[]; runId?: string; invoiceId?: string }): Promise<Proposal[]>;

  /** Human closes a blocked/escalated item (once). Throws if the proposal isn't blocked/escalated or is already resolved. */
  resolveProposal(input: { proposalId: string; action: ResolutionAction; note: string | null; actor: string }): Promise<Proposal>;

  // approvals (single-use tokens)
  listApprovals(proposalId: string): Promise<Approval[]>;
  createApproval(input: { proposalId: string; tokenHash: string; draftHash: string; approvedBy: string; ttlMs: number }): Promise<Approval>;
  /** Atomically lock an unexpired, unused token so two executors can't both act on it. */
  claimApproval(tokenHash: string, now?: Date): Promise<ClaimResult>;
  /** Give a claimed token back (send failed before PayPal accepted it). */
  releaseApproval(approvalId: string): Promise<void>;

  // send ledger
  /** Agent sends: atomically write the ledger row, burn the token, mark the proposal sent. */
  recordAgentSend(input: { approvalId: string; proposalId: string; invoiceId: string; subject: string | null; note: string | null }): Promise<LedgerEntry>;
  recordManualSend(input: { invoiceId: string; subject: string | null; note: string | null; actor: string }): Promise<LedgerEntry>;
  lastSendFor(invoiceId: string): Promise<LedgerEntry | null>;
  countSendsSince(since: Date): Promise<number>;
  listLedger(filter?: { invoiceId?: string; limit?: number }): Promise<LedgerEntry[]>;

  // model spend (append-only)
  recordModelCall(call: Omit<ModelCall, "id" | "at">): Promise<void>;
  modelSpendSince(since: Date): Promise<number>;
  modelSpendForRun(runId: string): Promise<{ totalUsd: number; byPurpose: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }> }>;

  // audit log
  audit(event: Omit<AuditEvent, "id" | "at">): Promise<void>;
  listAudit(filter?: { entityType?: string; entityId?: string; limit?: number }): Promise<AuditEvent[]>;

  close(): Promise<void>;
}
