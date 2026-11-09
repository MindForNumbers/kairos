import { NextResponse } from "next/server";
import { z } from "zod";
import { authorize } from "@/lib/auth";
import { chatTurn, transcript } from "@/lib/chat/engine";

export const maxDuration = 300;

const SESSION = /^chat_[a-f0-9]{32}$/;
const Body = z.object({
  message: z.string().trim().min(1).max(2000),
  sessionId: z.string().regex(SESSION).nullish(),
  /** The invoice page the user is on. Only an ID: the server looks the invoice up itself. */
  invoiceId: z.string().regex(/^INV2-[A-Z0-9-]{4,40}$/).nullish(),
});

/** One chat message → Kairos's reply. Read-only tools; drafts go to Approvals; never sends. */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues }, { status: 400 });
  try {
    const r = await chatTurn({ sessionId: parsed.data.sessionId, text: parsed.data.message, invoiceId: parsed.data.invoiceId });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[chat]", err);
    return NextResponse.json({ error: "CHAT_FAILED", message: "Kairos couldn't answer just now. Please try again." }, { status: 502 });
  }
}

/** The conversation so far, for the panel. */
export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  if (!SESSION.test(sessionId)) return NextResponse.json({ messages: [] });
  return NextResponse.json({ sessionId, messages: await transcript(sessionId) }, { headers: { "Cache-Control": "no-store" } });
}
