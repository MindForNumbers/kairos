import { getStore, type ProposalStatus } from "@/lib/db";

const OPEN: ProposalStatus[] = ["pending_review", "passed", "approved"];
const NEEDS_HUMAN: ProposalStatus[] = ["blocked", "escalated"];

export type Closed = { proposalId: string; from: ProposalStatus };

/**
 * Close every open proposal for an invoice that no longer needs chasing (paid, cancelled,
 * refunded, or reset away). Drafts waiting for approval become "skipped"; unresolved
 * blocked/escalated items are dismissed. Each change is audited. Idempotent: an
 * already-closed proposal is left alone. Never sends anything.
 *
 * An "approved" proposal may be mid-send; the executor re-fetches the invoice and checks the
 * proposal status before its one send, so closing it here makes that check stop the send.
 */
export async function closeProposalsForInvoice(invoiceId: string, reason: string, actor: string, dryRun = false): Promise<Closed[]> {
  const store = getStore();
  const closed: Closed[] = [];
  for (const p of await store.listProposals({ invoiceId, status: [...OPEN, ...NEEDS_HUMAN] })) {
    if (NEEDS_HUMAN.includes(p.status) && p.resolution) continue;
    if (dryRun) { closed.push({ proposalId: p.id, from: p.status }); continue; }
    const ok = NEEDS_HUMAN.includes(p.status)
      ? Boolean(await store.resolveProposal({ proposalId: p.id, action: "dismissed", note: reason, actor }))
      : await store.updateProposalStatus(p.id, { status: "skipped", reason }, [p.status]);
    if (!ok) continue;
    closed.push({ proposalId: p.id, from: p.status });
    await store.audit({ actor, event: "proposal.closed", entityType: "proposal", entityId: p.id, data: { invoiceId, from: p.status, reason } });
  }
  return closed;
}
