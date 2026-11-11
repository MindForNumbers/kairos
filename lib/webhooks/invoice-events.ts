import { daysBetween, localDate } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { getInvoice, type Invoice } from "@/lib/paypal/invoices";
import { closeProposalsForInvoice } from "@/lib/queue/close";

/**
 * Handles a PayPal INVOICING.INVOICE.* webhook that the route has already VERIFIED with
 * PayPal. Deduped on the event id (PayPal delivers at least once).
 *
 *   PAID / CANCELLED / REFUNDED → close the invoice's open proposals (no reminder should go out),
 *                                 and for PAID record days-to-payment.
 *   UPDATED / anything else     → recorded only.
 *
 * Every step is idempotent, and the event is recorded only after it was handled, so a
 * failure (→ 500 → PayPal redelivers) is simply retried.
 */

export type WebhookEvent = {
  id: string;
  event_type: string;
  resource?: { invoice?: { id?: string; status?: string }; id?: string; status?: string };
};

const CLOSING: Record<string, string> = {
  "INVOICING.INVOICE.PAID": "paid",
  "INVOICING.INVOICE.CANCELLED": "cancelled",
  "INVOICING.INVOICE.REFUNDED": "refunded",
};

let fetchInvoice: (id: string) => Promise<Invoice> = getInvoice;
/** Tests only. */
export function setWebhookInvoiceFetchForTesting(f: ((id: string) => Promise<Invoice>) | null) {
  fetchInvoice = f ?? getInvoice;
}

export type DaysToPayment = { invoiceNumber: string | null; paidOn: string; invoiceDate: string | null; dueDate: string | null; daysToPayment: number | null; daysAfterDue: number | null };

/** Pure: when the invoice was (last) paid, relative to its issue and due dates. */
export function daysToPayment(inv: Invoice): DaysToPayment | null {
  const dates = (inv.payments?.transactions ?? []).map((t) => t.payment_date).filter((d): d is string => !!d).sort();
  const paidOn = dates.at(-1) ?? null;
  if (!paidOn) return null;
  const invoiceDate = inv.detail.invoice_date ?? null;
  const dueDate = inv.detail.payment_term?.due_date ?? null;
  return {
    invoiceNumber: inv.detail.invoice_number ?? null, paidOn, invoiceDate, dueDate,
    daysToPayment: invoiceDate ? daysBetween(invoiceDate, paidOn) : null,
    daysAfterDue: dueDate ? daysBetween(dueDate, paidOn) : null,
  };
}

export async function handleInvoiceEvent(event: WebhookEvent): Promise<{ duplicate: boolean; closed: number; days?: DaysToPayment | null }> {
  const store = getStore();
  if (await store.hasWebhookEvent(event.id)) return { duplicate: true, closed: 0 };
  const invoiceId = event.resource?.invoice?.id ?? event.resource?.id ?? null;
  const outcome = CLOSING[event.event_type];
  let closed = 0;
  let days: DaysToPayment | null | undefined;

  if (outcome && invoiceId) {
    closed = (await closeProposalsForInvoice(invoiceId, `Invoice ${outcome} (PayPal webhook ${event.id})`, "system:webhook")).length;
    if (outcome === "paid") {
      days = daysToPayment(await fetchInvoice(invoiceId));
      await store.audit({ actor: "system:webhook", event: "invoice.paid", entityType: "invoice", entityId: invoiceId,
        data: { webhookEventId: event.id, receivedOn: localDate(), ...(days ?? {}) } });
    }
  }
  await store.recordWebhookEvent({ id: event.id, eventType: event.event_type, resourceId: invoiceId, data: { closed, ...(days ? { days } : {}) } });
  console.info(`[webhook] ${event.event_type} invoice=${invoiceId} closed=${closed}${days ? ` daysToPayment=${days.daysToPayment} daysAfterDue=${days.daysAfterDue}` : ""}`);
  return { duplicate: false, closed, days };
}
