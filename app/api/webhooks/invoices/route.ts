/**
 * Alias of /api/webhooks/paypal: PayPal's webhook form rejected a URL containing "paypal", so the
 * registered webhook points here. Same handler, not a copy: signature verification, dedupe and
 * event handling all live in ../paypal/route.ts and lib/webhooks/invoice-events.ts.
 */
export { POST } from "../paypal/route";
