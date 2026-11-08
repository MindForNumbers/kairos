import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { rejectProposal } from "@/lib/queue/actions";
import { queueError } from "@/lib/queue/http";

const Body = z.object({ note: z.string().trim().max(1000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { note } = Body.parse(await req.json().catch(() => ({})));
    await rejectProposal((await params).id, ADMIN_ACTOR, note || null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return queueError(err);
  }
}
