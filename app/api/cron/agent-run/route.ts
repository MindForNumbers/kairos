import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron";
import { queueError } from "@/lib/queue/http";
import { summarize, triggerRun } from "@/lib/queue/run";

export const maxDuration = 300;

/** The daily scheduled agent run (Render Cron Job). Drafts only: every send still needs an approval. */
export async function POST(req: Request) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  try {
    return NextResponse.json(summarize(await triggerRun("system:cron", undefined, "cron")), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return queueError(err);
  }
}
