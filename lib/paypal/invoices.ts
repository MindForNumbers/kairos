import "server-only";
import { z } from "zod";
import { PayPalError, paypalRequest } from "./client";

// ---- Types (subset of the Invoicing v2 resource we actually use) --------

export type Money = { currency_code: string; value: string };

export type InvoiceStatus =
  | "DRAFT" | "SENT" | "SCHEDULED" | "PAYMENT_PENDING" | "UNPAID"
  | "PARTIALLY_PAID" | "PAID" | "MARKED_AS_PAID"
  | "CANCELLED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "MARKED_AS_REFUNDED";

export type Invoice = {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number?: string;
    invoice_date?: string;
    currency_code: string;
    note?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { create_time?: string; recipient_view_url?: string; invoicer_view_url?: string };
  };
  primary_recipients?: { billing_info?: { email_address?: string; name?: { given_name?: string; surname?: string; full_name?: string } } }[];
  items?: { name: string; description?: string; quantity: string; unit_amount: Money; tax?: { name: string; percent: string } }[];
  amount?: Money;
  due_amount?: Money;
  payments?: { paid_amount?: Money; transactions?: { payment_id?: string; method?: string; payment_date?: string; amount?: Money; note?: string }[] };
};

export type InvoiceList = { items?: Invoice[]; total_items?: number; total_pages?: number };

// ---- Input validation ---------------------------------------------------

const moneyValue = z.string().regex(/^\d+(\.\d{1,2})?$/, "Use a positive amount like 120 or 120.50");

export const createInvoiceSchema = z.object({
  currency: z.string().length(3).toUpperCase().default("USD"),
  invoiceNumber: z.string().max(25).optional(),
  recipient: z.object({
    email: z.email(),
    givenName: z.string().max(140).optional(),
    surname: z.string().max(140).optional(),
  }),
  items: z.array(z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    quantity: z.string().regex(/^\d+(\.\d{1,5})?$/, "Invalid quantity"),
    unitAmount: moneyValue,
    taxPercent: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  })).min(1, "Add at least one line item").max(100),
  termType: z.enum(["DUE_ON_RECEIPT", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90"]).default("NET_30"),
  note: z.string().max(4000).optional(),
  allowPartialPayment: z.boolean().default(false),
  minimumAmountDue: moneyValue.optional(),
  allowTip: z.boolean().default(false),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const recordPaymentSchema = z.object({
  method: z.enum(["BANK_TRANSFER", "CASH", "CHECK", "CREDIT_CARD", "DEBIT_CARD", "PAYPAL", "WIRE_TRANSFER", "OTHER"]),
  amount: moneyValue,
  paymentDate: z.iso.date(),
  note: z.string().max(2000).optional(),
});

// ---- API operations -----------------------------------------------------

const BASE = "/v2/invoicing/invoices";

export async function nextInvoiceNumber(): Promise<string> {
  const res = await paypalRequest<{ invoice_number: string }>("/v2/invoicing/generate-next-invoice-number", { method: "POST" });
  return res.invoice_number;
}

/**
 * Creates a DRAFT. Nothing is emailed until `sendInvoice`.
 * Note: this endpoint does not replay on PayPal-Request-Id (verified in sandbox) —
 * dedupe by passing a fixed `invoiceNumber` and handling DUPLICATE_INVOICE_NUMBER.
 */
export async function createDraftInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const currency = input.currency;
  const body = {
    detail: {
      currency_code: currency,
      invoice_number: input.invoiceNumber || (await nextInvoiceNumber()),
      note: input.note,
      payment_term: { term_type: input.termType },
    },
    primary_recipients: [{
      billing_info: {
        email_address: input.recipient.email,
        name: input.recipient.givenName || input.recipient.surname
          ? { given_name: input.recipient.givenName, surname: input.recipient.surname }
          : undefined,
      },
    }],
    items: input.items.map((it) => ({
      name: it.name,
      description: it.description,
      quantity: it.quantity,
      unit_amount: { currency_code: currency, value: it.unitAmount },
      unit_of_measure: "QUANTITY",
      tax: it.taxPercent ? { name: "Tax", percent: it.taxPercent } : undefined,
    })),
    configuration: {
      allow_tip: input.allowTip,
      tax_inclusive: false,
      partial_payment: input.allowPartialPayment
        ? {
            allow_partial_payment: true,
            minimum_amount_due: input.minimumAmountDue ? { currency_code: currency, value: input.minimumAmountDue } : undefined,
          }
        : { allow_partial_payment: false },
    },
  };
  return paypalRequest<Invoice>(BASE, { method: "POST", body });
}

export async function findInvoiceByNumber(invoiceNumber: string): Promise<Invoice | undefined> {
  const res = await paypalRequest<InvoiceList>("/v2/invoicing/search-invoices", {
    method: "POST",
    query: { page: 1, page_size: 1 },
    body: { invoice_number: invoiceNumber },
  });
  return res.items?.[0];
}

export function isDuplicateInvoiceNumber(err: unknown) {
  return err instanceof PayPalError &&
    Array.isArray(err.details) &&
    err.details.some((d: { issue?: string }) => d.issue === "DUPLICATE_INVOICE_NUMBER");
}

export function listInvoices(page = 1, pageSize = 20) {
  return paypalRequest<InvoiceList>(BASE, { query: { page, page_size: pageSize, total_required: true } });
}

export function getInvoice(id: string) {
  return paypalRequest<Invoice>(`${BASE}/${encodeURIComponent(id)}`);
}

export function sendInvoice(id: string, opts: { subject?: string; note?: string } = {}, requestId?: string) {
  return paypalRequest(`${BASE}/${encodeURIComponent(id)}/send`, {
    method: "POST",
    requestId,
    body: { subject: opts.subject, note: opts.note, send_to_recipient: true, send_to_invoicer: false },
  });
}

export function remindInvoice(id: string, opts: { subject?: string; note?: string } = {}, requestId?: string) {
  return paypalRequest(`${BASE}/${encodeURIComponent(id)}/remind`, {
    method: "POST",
    requestId,
    body: { subject: opts.subject, note: opts.note, send_to_recipient: true, send_to_invoicer: false },
  });
}

export function cancelInvoice(id: string, opts: { subject?: string; note?: string } = {}, requestId?: string) {
  return paypalRequest(`${BASE}/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    requestId,
    body: { subject: opts.subject, note: opts.note, send_to_recipient: true, send_to_invoicer: false },
  });
}

/** Only DRAFT invoices can be deleted; sent ones must be cancelled. */
export function deleteDraftInvoice(id: string) {
  return paypalRequest(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Record an offline payment (check, wire, cash…) against an invoice. */
export function recordPayment(id: string, input: z.infer<typeof recordPaymentSchema>, currency: string, requestId?: string) {
  return paypalRequest<{ payment_id: string }>(`${BASE}/${encodeURIComponent(id)}/payments`, {
    method: "POST",
    requestId,
    body: {
      method: input.method,
      payment_date: input.paymentDate,
      amount: { currency_code: currency, value: input.amount },
      note: input.note,
    },
  });
}
