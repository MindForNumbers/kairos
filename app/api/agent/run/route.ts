import { NextResponse } from "next/server";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { queueError } from "@/lib/queue/http";
import { summarize, triggerRun } from "@/lib/queue/run";

// A run makes a few model calls (drafter, critic, up to 2 revisions); give it room.
export const maxDuration = 300;

/** "Run agent" on the Approvals page: sweep → draft → review → proposals. Never sends. */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    return NextResponse.json(summarize(await triggerRun(ADMIN_ACTOR)), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return queueError(err);
  }
}
