import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { getBriefing } from "@/lib/chat/briefing";

/** The opening briefing for an empty Kairos panel. Read-only; numbers computed in code. */
export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const b = await getBriefing();
    return NextResponse.json({ text: b.text, chips: b.chips, wording: b.wording, asOf: b.facts.today }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[briefing]", (err as Error).name, (err as Error).message);
    return NextResponse.json({ error: "BRIEFING_FAILED" }, { status: 502 });
  }
}
