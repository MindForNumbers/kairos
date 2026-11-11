import { NextResponse } from "next/server";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { getStore } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { currentPolicy } from "@/lib/agent/incentives";
import { paymentPlanPolicySchema } from "@/lib/agent/policy";
import { currentRulesVersion } from "@/lib/agent/rules-version";

/** The owner's incentive policy. GET = current; POST = save a new version (append-only). */
export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  return NextResponse.json({ ...(await currentPolicy()), rulesVersion: await currentRulesVersion() });
}

export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { paymentPlan?: unknown };
    const paymentPlan = paymentPlanPolicySchema.parse(body.paymentPlan);
    const before = await currentRulesVersion();
    const saved = await getStore().appendIncentivePolicy({ policy: { paymentPlan }, actor: ADMIN_ACTOR });
    const after = await currentRulesVersion();
    return NextResponse.json({ version: saved.version, policy: paymentPlan, rulesVersion: after, draftsMadeStale: before !== after });
  } catch (err) {
    return errorResponse(err);
  }
}
