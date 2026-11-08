import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { nowIso } from "@/lib/clock";
import { getStore, hashDraft, type Approval, type Proposal, type ResolutionAction } from "@/lib/db";
import { RULES_VERSION } from "@/lib/agent/rules-version";

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

/** Made (and reviewed) under different rules than the ones running now. Never approvable. */
export function isStale(p: Pick<Proposal, "rulesVersion">): boolean {
  return p.rulesVersion !== RULES_VERSION;
}

/** sha256 of the bearer token. Only this is stored; the executor hashes what it receives the same way. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** An approval that can still be used (or is mid-use). Blocks minting a second one. */
export function liveApproval(approvals: Approval[], at = nowIso()): Approval | undefined {
  return approvals.find((a) => !a.usedAt && (a.claimedAt || a.expiresAt > at));
}

/**
 * Approve = mint a single-use token bound to the draft hash, valid APPROVAL_TTL_MS.
 * The raw token is returned exactly once and never stored.
 */
export async function approveProposal(proposalId: string, actor: string): Promise<{ token: string; approval: Approval }> {
  const store = getStore();
  const p = await store.getProposal(proposalId);
  if (!p) throw new QueueError(404, "NOT_FOUND", "Proposal not found");
  if (p.kind !== "reminder") throw new QueueError(409, "NOT_APPROVABLE", "Escalations can't be approved");
  if (isStale(p)) {
    throw new QueueError(409, "STALE_RULES", `Drafted under rules ${p.rulesVersion ?? "(unversioned)"}, current rules are ${RULES_VERSION}. Reject it and re-run the agent.`);
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
    // Re-approval is allowed only after the previous token expired unused.
    if (liveApproval(await store.listApprovals(p.id))) throw new QueueError(409, "ALREADY_APPROVED", "This draft already has a live approval");
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
    throw new QueueError(409, "LIVE_APPROVAL", "This draft has a live approval; wait for it to expire or be used");
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
