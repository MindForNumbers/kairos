import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron";
import { parseEmails, resetDemo } from "@/lib/demo/reset";
import { RunBusyError, withRunLock } from "@/lib/agent/run-guard";

export const maxDuration = 300;

/**
 * The nightly demo reset (Render Cron Job, before the agent run): seed today's date-stamped
 * set, then cancel older demo invoices and close their proposals. Sandbox only. Holds the run
 * lock so an agent run can't draft for invoices that are being retired.
 */
export async function POST(req: Request) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  let emails: string[];
  try {
    emails = parseEmails(process.env.KAIROS_SEED_EMAILS ?? "");
  } catch (err) {
    return NextResponse.json({ error: "DEMO_NOT_CONFIGURED", message: (err as Error).message }, { status: 503 });
  }
  // ?fresh=1: re-seed today's demo from scratch under a new suffix (TS-261111b-…) and cancel the
  // earlier set. The scheduled nightly call passes no query and is unchanged.
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  try {
    const summary = await withRunLock(() => resetDemo({ emails, actor: fresh ? "system:cron:fresh" : "system:cron", fresh }));
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof RunBusyError) return NextResponse.json({ error: "RUN_IN_PROGRESS", message: err.message }, { status: 409 });
    console.error("[demo-reset]", err);
    return NextResponse.json({ error: "DEMO_RESET_FAILED", message: (err as Error).message }, { status: 500 });
  }
}
