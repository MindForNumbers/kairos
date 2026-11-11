import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { queueError } from "@/lib/queue/http";
import { holdFromInsight, offerPlanFromInsight } from "@/lib/queue/insight-actions";

export const maxDuration = 300;

const Body = z.object({ type: z.enum(["offer_plan", "hold"]), invoiceId: z.string().min(1).max(64) });

/** One-click insight actions: draft a payment-plan reminder for approval, or put a Kairos-side hold. Never sends. */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { type, invoiceId } = Body.parse(await req.json());
    if (type === "offer_plan") return NextResponse.json({ type, result: await offerPlanFromInsight(invoiceId, ADMIN_ACTOR) });
    return NextResponse.json({ type, hold: await holdFromInsight(invoiceId, ADMIN_ACTOR) });
  } catch (err) {
    return queueError(err);
  }
}
