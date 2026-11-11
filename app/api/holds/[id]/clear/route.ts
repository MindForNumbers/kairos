import { NextResponse } from "next/server";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { queueError } from "@/lib/queue/http";
import { clearHold } from "@/lib/queue/insight-actions";

/** Clear a Kairos-side hold: the invoice becomes eligible for reminders again. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    return NextResponse.json({ hold: await clearHold(id, ADMIN_ACTOR) });
  } catch (err) {
    return queueError(err);
  }
}
