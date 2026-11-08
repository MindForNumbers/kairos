import { NextResponse } from "next/server";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { approveAndExecute } from "@/lib/queue/actions";
import { queueError } from "@/lib/queue/http";

/**
 * One click: mint a single-use token bound to this draft's hash and hand it straight to the
 * executor in this request. The token never leaves the server; the response reports what
 * the executor did (sent, dry run, deferred, skipped, failed, unknown).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { approval, execution } = await approveAndExecute((await params).id, ADMIN_ACTOR);
    return NextResponse.json(
      { approvalId: approval.id, draftHash: approval.draftHash, execution },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return queueError(err);
  }
}
