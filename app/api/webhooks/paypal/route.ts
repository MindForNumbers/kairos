import { NextResponse } from "next/server";
import { paypalRequest } from "@/lib/paypal/client";
import { handleInvoiceEvent, type WebhookEvent } from "@/lib/webhooks/invoice-events";

/**
 * Receives INVOICING.INVOICE.* events. Every event is verified with PayPal
 * before it is trusted; unverified payloads get a 400 response. Verified events go to
 * lib/webhooks/invoice-events.ts (dedupe on event id; close proposals on PAID/CANCELLED/
 * REFUNDED; record days-to-payment on PAID).
 *
 * Subscribe in the Developer Dashboard (app → Webhooks) to at least:
 *   INVOICING.INVOICE.PAID, INVOICING.INVOICE.CANCELLED,
 *   INVOICING.INVOICE.REFUNDED, INVOICING.INVOICE.UPDATED
 * then put the webhook's ID in PAYPAL_WEBHOOK_ID.
 */
export async function POST(req: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error("[webhook] PAYPAL_WEBHOOK_ID is not set; rejecting event");
    return NextResponse.json({ error: "WEBHOOK_NOT_CONFIGURED" }, { status: 500 });
  }

  const h = req.headers;
  const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
  if (required.some((name) => !h.get(name))) {
    return NextResponse.json({ error: "MISSING_SIGNATURE_HEADERS" }, { status: 400 });
  }

  const event = (await req.json().catch(() => null)) as WebhookEvent | null;
  if (!event?.event_type) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const verification = await paypalRequest<{ verification_status: "SUCCESS" | "FAILURE" }>(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: {
        auth_algo: h.get("paypal-auth-algo"),
        cert_url: h.get("paypal-cert-url"),
        transmission_id: h.get("paypal-transmission-id"),
        transmission_sig: h.get("paypal-transmission-sig"),
        transmission_time: h.get("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      },
    },
  ).catch((err) => {
    console.error("[webhook] verification call failed", err);
    return null;
  });

  if (!verification) {
    // Non-2xx makes PayPal redeliver later, which is what we want for a transient failure.
    return NextResponse.json({ error: "VERIFICATION_UNAVAILABLE" }, { status: 503 });
  }
  if (verification.verification_status !== "SUCCESS") {
    console.warn(`[webhook] rejected unverified event ${event.id}`);
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 400 });
  }

  try {
    const r = await handleInvoiceEvent(event);
    return NextResponse.json({ received: true, ...r });
  } catch (err) {
    // Non-2xx makes PayPal redeliver; handling is idempotent and the event isn't recorded yet.
    console.error("[webhook] handling failed", event.id, err);
    return NextResponse.json({ error: "HANDLER_FAILED" }, { status: 500 });
  }
}
