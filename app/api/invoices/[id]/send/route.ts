import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { z } from "zod";
import { sendInvoice } from "@/lib/paypal/invoices";
import { errorResponse, idempotencyKey } from "@/lib/http";

const bodySchema = z.object({ subject: z.string().max(4000).optional(), note: z.string().max(4000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    await sendInvoice((await params).id, body, idempotencyKey(req));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
