import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import {
  createDraftInvoice, createInvoiceSchema, findInvoiceByNumber, isDuplicateInvoiceNumber,
  listInvoices, sendInvoice, type CreateInvoiceInput, type Invoice,
} from "@/lib/paypal/invoices";
import { errorResponse, idempotencyKey } from "@/lib/http";

export async function GET(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    return NextResponse.json(await listInvoices(page));
  } catch (err) {
    return errorResponse(err);
  }
}

const REPLAY_WINDOW_MS = 15 * 60 * 1000;

/**
 * PayPal's Invoicing API does NOT replay on PayPal-Request-Id, but it does enforce
 * unique invoice numbers. So a retried submit (same Idempotency-Key + same number)
 * hits DUPLICATE_INVOICE_NUMBER; if the existing invoice was created moments ago for
 * the same recipient, treat it as the original result instead of an error.
 */
async function findReplay(input: CreateInvoiceInput): Promise<Invoice | undefined> {
  if (!input.invoiceNumber) return;
  const existing = await findInvoiceByNumber(input.invoiceNumber);
  if (!existing) return;
  const created = Date.parse(existing.detail.metadata?.create_time ?? "");
  const sameRecipient =
    existing.primary_recipients?.[0]?.billing_info?.email_address?.toLowerCase() === input.recipient.email.toLowerCase();
  // real-clock: compared against PayPal's own (real) create_time
  return sameRecipient && Date.now() - created < REPLAY_WINDOW_MS ? existing : undefined;
}

/** Create a draft. Pass `?send=true` to send it immediately after creation. */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const input = createInvoiceSchema.parse(await req.json());
    const key = idempotencyKey(req);
    const send = new URL(req.url).searchParams.get("send") === "true";

    let invoice: Invoice;
    let status = 201;
    try {
      invoice = await createDraftInvoice(input);
    } catch (err) {
      const replay = key && isDuplicateInvoiceNumber(err) ? await findReplay(input) : undefined;
      if (!replay) throw err;
      invoice = replay;
      status = 200;
    }

    if (send && invoice.status === "DRAFT") {
      await sendInvoice(invoice.id, {}, key && `${key}-send`);
      invoice = { ...invoice, status: "SENT" };
    }
    return NextResponse.json(invoice, { status });
  } catch (err) {
    return errorResponse(err);
  }
}
