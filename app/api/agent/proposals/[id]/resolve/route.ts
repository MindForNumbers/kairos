import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { resolveProposal } from "@/lib/queue/actions";
import { queueError } from "@/lib/queue/http";

const Body = z.object({ action: z.enum(["resolved", "dismissed"]), note: z.string().trim().max(1000).optional() });

/** Close a "Needs a human" item (blocked or escalated). The invoice can be drafted again on the next run. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { action, note } = Body.parse(await req.json());
    const p = await resolveProposal((await params).id, action, ADMIN_ACTOR, note || null);
    return NextResponse.json({ ok: true, resolution: p.resolution });
  } catch (err) {
    return queueError(err);
  }
}
