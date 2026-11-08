import { NextResponse } from "next/server";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { approveProposal } from "@/lib/queue/actions";
import { queueError } from "@/lib/queue/http";

/** Mint a single-use, 15-minute token bound to this draft's hash. The token is in this response only. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { token, approval } = await approveProposal((await params).id, ADMIN_ACTOR);
    return NextResponse.json(
      { approvalId: approval.id, token, draftHash: approval.draftHash, expiresAt: approval.expiresAt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return queueError(err);
  }
}
