import { getStore, type PolicyVersion } from "@/lib/db";
import { OFFERS_OFF, paymentPlanPolicySchema, type PaymentPlanPolicy } from "./policy";

/**
 * The owner's incentive policy as stored (append-only versions, latest wins). Before the
 * owner saves one, or if the stored row doesn't parse, offers are OFF.
 */
export type CurrentPolicy = { policy: PaymentPlanPolicy; version: number | null; savedAt: string | null; savedBy: string | null };

export function parsePolicy(row: PolicyVersion | null): CurrentPolicy {
  if (!row) return { policy: OFFERS_OFF, version: null, savedAt: null, savedBy: null };
  const parsed = paymentPlanPolicySchema.safeParse((row.policy as { paymentPlan?: unknown } | null)?.paymentPlan);
  if (!parsed.success) return { policy: OFFERS_OFF, version: row.version, savedAt: row.createdAt, savedBy: row.actor };
  return { policy: parsed.data, version: row.version, savedAt: row.createdAt, savedBy: row.actor };
}

export async function currentPolicy(): Promise<CurrentPolicy> {
  return parsePolicy(await getStore().latestIncentivePolicy());
}
