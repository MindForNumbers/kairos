import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { nextInvoiceNumber } from "@/lib/paypal/invoices";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Next unused invoice number from PayPal. The form fetches it on load so a resubmit carries the same number. */
export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ invoiceNumber: await nextInvoiceNumber() });
  } catch (err) {
    return errorResponse(err);
  }
}
