import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { sendManualReminder } from "@/lib/executor/manual";
import { errorResponse } from "@/lib/http";

const bodySchema = z.object({
  subject: z.string().max(4000).optional(),
  note: z.string().max(4000).optional(),
  /** Set after the user has seen and accepted the warnings (7-day rule, daily cap, quiet hours). */
  confirm: z.boolean().optional(),
});

/** Manual reminder: one attempt, no retry, recorded in the send ledger. KILL blocks it; other limits warn. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { confirm, ...msg } = bodySchema.parse(await req.json().catch(() => ({})));
    const r = await sendManualReminder((await params).id, msg, { actor: ADMIN_ACTOR, confirmed: confirm === true });
    switch (r.status) {
      case "sent": return NextResponse.json({ ok: true, ...r });
      case "needs_confirmation": return NextResponse.json({ error: "NEEDS_CONFIRMATION", warnings: r.warnings }, { status: 409 });
      case "halted": return NextResponse.json({ error: "HALTED", message: r.reason }, { status: 423 });
      case "failed": return NextResponse.json({ error: "SEND_FAILED", message: r.reason, debug_id: r.debugId }, { status: 502 });
      case "unknown": return NextResponse.json({ error: "SEND_OUTCOME_UNKNOWN", message: r.reason, debug_id: r.debugId }, { status: 502 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
