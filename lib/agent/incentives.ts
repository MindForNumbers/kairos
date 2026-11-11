import { getStore, type PolicyVersion } from "@/lib/db";
import { DIRECTOR_DEFAULT, OFFERS_OFF, directorSettingsSchema, paymentPlanPolicySchema, type DirectorSettings, type PaymentPlanPolicy } from "./policy";

/**
 * The owner's incentive policy as stored (append-only versions, latest wins). Before the
 * owner saves one, or if the stored row doesn't parse, offers are OFF.
 */
export type CurrentPolicy = { policy: PaymentPlanPolicy; director: DirectorSettings; version: number | null; savedAt: string | null; savedBy: string | null };

export function parsePolicy(row: PolicyVersion | null): CurrentPolicy {
  if (!row) return { policy: OFFERS_OFF, director: DIRECTOR_DEFAULT, version: null, savedAt: null, savedBy: null };
  const raw = row.policy as { paymentPlan?: unknown; director?: unknown } | null;
  const parsed = paymentPlanPolicySchema.safeParse(raw?.paymentPlan);
  const director = directorSettingsSchema.safeParse(raw?.director ?? DIRECTOR_DEFAULT);
  return { policy: parsed.success ? parsed.data : OFFERS_OFF, director: director.success ? director.data : DIRECTOR_DEFAULT,
    version: row.version, savedAt: row.createdAt, savedBy: row.actor };
}

export async function currentPolicy(): Promise<CurrentPolicy> {
  return parsePolicy(await getStore().latestIncentivePolicy());
}
