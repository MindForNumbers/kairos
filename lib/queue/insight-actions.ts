import "server-only";
import { getStore, type Hold } from "@/lib/db";
import { runAgent } from "@/lib/agent/pipeline";
import { RunBusyError, withRunLock } from "@/lib/agent/run-guard";
import { CostCapError } from "@/lib/agent/budget";
import { invalidateInsights, loadInsights } from "@/lib/insights/load";
import { QueueError } from "./actions";

/**
 * The one-click actions on insight cards. Human decisions, so they live with the queue.
 * Neither sends anything or writes to PayPal:
 *   - offer_plan: drafts a reminder for ONE invoice through the normal pipeline (sweep rules,
 *     Director, drafter, critic + code checks) → Approvals. The pay-in-parts offer is still
 *     decided by code under the owner's policy.
 *   - hold: a Kairos-side hold that blocks drafting (and approving) until the owner clears it.
 * Each action re-checks that the insight still exists right now.
 */

export type OfferPlanResult = { invoiceId: string; outcome: string; proposalId: string | null; detail: string; offerIncluded: boolean };

export async function offerPlanFromInsight(invoiceId: string, actor: string): Promise<OfferPlanResult> {
  const { insights } = await loadInsights({ fresh: true });
  const insight = insights.find((i) => i.kind === "payment_plan_candidate" && i.invoiceId === invoiceId);
  if (!insight) throw new QueueError(409, "INSIGHT_GONE", "This invoice no longer qualifies for a payment-plan offer (it may be paid, held, already in Approvals, or the policy changed).");
  await getStore().audit({ actor, event: "insight.action", entityType: "invoice", entityId: invoiceId, data: { action: "offer_plan", insightId: insight.id } });
  try {
    const report = await withRunLock(() => runAgent({ only: [invoiceId] }));
    invalidateInsights();
    const o = report.outcomes.find((x) => x.invoiceId === invoiceId);
    const ex = report.sweep.excluded.find((e) => e.invoiceId === invoiceId);
    const proposal = o ? await getStore().getProposal(o.proposalId) : null;
    return {
      invoiceId, outcome: o?.outcome ?? `not_drafted:${ex?.reason ?? "not_eligible"}`, proposalId: o?.proposalId ?? null, offerIncluded: !!proposal?.offer,
      detail: !o ? (ex?.detail ?? "not drafted") : o.outcome === "passed" ? "Drafted and checked: it's waiting on the Approvals page." : o.outcome === "blocked" ? "The draft was blocked by review; see the Approvals page." : "Escalated to you on the Approvals page.",
    };
  } catch (err) {
    if (err instanceof RunBusyError) throw new QueueError(409, "RUN_IN_PROGRESS", "Another Kairos run is in progress; try again in a minute.");
    if (err instanceof CostCapError) throw new QueueError(429, "COST_CAP", err.message);
    throw err;
  }
}

export async function holdFromInsight(invoiceId: string, actor: string): Promise<Hold> {
  const { insights } = await loadInsights({ fresh: true });
  const insight = insights.find((i) => i.action?.type === "hold" && i.action.invoiceId === invoiceId);
  if (!insight || insight.action?.type !== "hold") throw new QueueError(409, "INSIGHT_GONE", "This insight no longer applies (the invoice may be paid or already on hold).");
  try {
    const hold = await getStore().createHold({ invoiceId, reason: insight.action.reason, source: `insight:${insight.kind}`, actor });
    invalidateInsights();
    return hold;
  } catch (err) {
    throw new QueueError(409, "ALREADY_ON_HOLD", (err as Error).message);
  }
}

export async function clearHold(holdId: string, actor: string): Promise<Hold> {
  try {
    const hold = await getStore().clearHold({ holdId, actor });
    invalidateInsights();
    return hold;
  } catch (err) {
    throw new QueueError(409, "NOT_CLEARABLE", (err as Error).message);
  }
}
