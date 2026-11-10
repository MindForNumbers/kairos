import { NextResponse } from "next/server";
import { ADMIN_ACTOR, authorize } from "@/lib/auth";
import { CostCapError } from "@/lib/agent/budget";
import { IntakeInputError, MAX_IMAGE_BYTES, runIntake } from "@/lib/intake/intake";

export const maxDuration = 120;

/**
 * Photo or voice transcript → New Invoice form values. Returns field values and findings only;
 * creating the invoice is the owner's click on the form (POST /api/invoices). The photo is read
 * into memory for the model calls and never written anywhere.
 *   multipart/form-data: photo=<image>
 *   application/json:    { "transcript": "..." }
 */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const actor = ADMIN_ACTOR;
  try {
    const type = req.headers.get("content-type") ?? "";
    let result;
    if (type.startsWith("multipart/form-data")) {
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > MAX_IMAGE_BYTES + 64 * 1024) throw new IntakeInputError("The photo is over 5 MB. Try a smaller one.");
      const photo = (await req.formData()).get("photo");
      if (!(photo instanceof Blob)) throw new IntakeInputError("No photo was attached.");
      result = await runIntake({ kind: "photo", bytes: new Uint8Array(await photo.arrayBuffer()) }, actor);
    } else {
      const body = await req.json().catch(() => null) as { transcript?: unknown } | null;
      if (typeof body?.transcript !== "string") throw new IntakeInputError("Send a photo or a transcript.");
      result = await runIntake({ kind: "voice", transcript: body.transcript }, actor);
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof IntakeInputError) return NextResponse.json({ error: "BAD_INPUT", message: err.message }, { status: 400 });
    if (err instanceof CostCapError) return NextResponse.json({ error: "COST_CAP", message: `${err.message}. Fill the form by hand, or try again tomorrow.` }, { status: 429 });
    console.error("[intake]", (err as Error).name, (err as Error).message);
    return NextResponse.json({ error: "INTAKE_FAILED", message: "Couldn't read that just now. Try again, or fill the form by hand." }, { status: 502 });
  }
}
