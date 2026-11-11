import "server-only";
import { randomBytes } from "node:crypto";
import { getStore, hashDraft, type Approval, type Proposal, type ResolutionAction } from "@/lib/db";
import { currentRulesVersion } from "@/lib/agent/rules-version";
import { executeApproval, type ExecutionResult } from "@/lib/executor/execute";
import { hashToken } from "@/lib/executor/token";

/**
 * Human decisions on proposals. This is NOT agent code: lib/agent/ may never import it
 * (enforced by scripts/check-boundaries.mjs).
 */

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export class QueueError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * Made (and reviewed) under different rules than the ones running now, including a different
 * incentive policy. Never approvable. `current` comes from currentRulesVersion().
 */
export function isStale(p: Pick<Proposal, "rulesVersion">, current: string): boolean {
  return p.rulesVersion !== current;
}

export { hashToken };

/**
 * An approval the executor is holding: claimed and not burned. That is either a send in
 * progress or one whose outcome is unknown. Blocks a second approval and a reject.
 * (With one-click approve the raw token never leaves the server, so an unclaimed approval
 * has no holder and doesn't count.)
 */
export function liveApproval(approvals: Approval[]): Approval | undefined {
  return approvals.find((a) => !a.usedAt && a.claimedAt);
}

/**
 * One click: mint a single-use token bound to the draft hash and hand it straight to the
 * executor in the same request. The raw token exists only in this function's memory.
 */
export async function approveAndExecute(proposalId: string, actor: string): Promise<{ approval: Approval; execution: ExecutionResult }> {
  const { token, approval } = await approveProposal(proposalId, actor);
  const execution = await executeApproval(token);
  return { approval, execution };
}

/**
 * Mint a single-use token bound to the draft hash, valid APPROVAL_TTL_MS. Only its hash is
 * stored. Callers outside this module should use approveAndExecute().
 */
export async function approveProposal(proposalId: string, actor: string): Promise<{ token: string; approval: Approval }> {
  const store = getStore();
  const p = await store.getProposal(proposalId);
  if (!p) throw new QueueError(404, "NOT_FOUND", "Proposal not found");
  if (p.kind !== "reminder") throw new QueueError(409, "NOT_APPROVABLE", "Escalations can't be approved");
  const rules = await currentRulesVersion();
  if (isStale(p, rules)) {
    throw new QueueError(409, "STALE_RULES", `Drafted under rules ${p.rulesVersion ?? "(unversioned)"}, current rules are ${rules} (code or incentive policy changed). Reject it and re-run the agent.`);
  }

  // Integrity: the stored hash must still describe the stored content.
  if (hashDraft(p) !== p.draftHash) {
    await store.audit({ actor, event: "approval.hash_mismatch", entityType: "proposal", entityId: p.id, data: { stored: p.draftHash } });
    throw new QueueError(500, "HASH_MISMATCH", "Draft content doesn't match its hash; refusing to approve");
  }

  if (p.status === "passed") {
    // Compare-and-set: two concurrent approvals can't both win.
    if (!(await store.updateProposalStatus(p.id, { status: "approved" }, ["passed"]))) {
      throw new QueueError(409, "CONFLICT", "Proposal changed while approving; reload");
    }
  } else if (p.status === "approved") {
    // Only reachable after an interrupted request; refused while the executor holds a token.
    if (liveApproval(await store.listApprovals(p.id))) throw new QueueError(409, "ALREADY_APPROVED", "A send for this draft is in progress or its outcome is unknown");
  } else {
    throw new QueueError(409, "NOT_APPROVABLE", `Proposal is ${p.status}`);
  }

  const token = randomBytes(32).toString("base64url");
  const approval = await store.createApproval({ proposalId: p.id, tokenHash: hashToken(token), draftHash: p.draftHash, approvedBy: actor, ttlMs: APPROVAL_TTL_MS });
  await store.audit({ actor, event: "approval.minted", entityType: "proposal", entityId: p.id,
    data: { approvalId: approval.id, invoiceId: p.invoiceId, draftHash: p.draftHash, expiresAt: approval.expiresAt } });
  return { token, approval };
}

/** Reject a queued draft. The invoice becomes eligible for a fresh draft on the next run. */
export async function rejectProposal(proposalId: string, actor: string, note: string | null): Promise<void> {
  const store = getStore();
  const p = await store.getProposal(proposalId);
  if (!p) throw new QueueError(404, "NOT_FOUND", "Proposal not found");
  if (p.status === "approved" && liveApproval(await store.listApprovals(p.id))) {
    throw new QueueError(409, "LIVE_APPROVAL", "A send for this draft is in progress or its outcome is unknown");
  }
  if (!(await store.updateProposalStatus(p.id, { status: "rejected", reason: note ? `Rejected: ${note}` : "Rejected by reviewer" }, ["passed", "approved"]))) {
    throw new QueueError(409, "NOT_REJECTABLE", `Proposal is ${p.status}`);
  }
  await store.audit({ actor, event: "proposal.rejected", entityType: "proposal", entityId: p.id, data: { invoiceId: p.invoiceId, note } });
}

/** Close a "Needs a human" item. Frees the invoice for future runs. */
export async function resolveProposal(proposalId: string, action: ResolutionAction, actor: string, note: string | null) {
  try {
    return await getStore().resolveProposal({ proposalId, action, note, actor });
  } catch (err) {
    throw new QueueError(409, "NOT_RESOLVABLE", (err as Error).message);
  }
}
