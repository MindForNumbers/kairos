import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { getInvoice, recordPayment, recordPaymentSchema } from "@/lib/paypal/invoices";
import { errorResponse, idempotencyKey } from "@/lib/http";

/** Record an offline payment (check, wire, cash…). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { id } = await params;
    const input = recordPaymentSchema.parse(await req.json());
    const invoice = await getInvoice(id);
    const result = await recordPayment(id, input, invoice.detail.currency_code, idempotencyKey(req));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
