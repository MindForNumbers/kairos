import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { PayPalError } from "./paypal/client";

/** Maps thrown errors to JSON responses. Surfaces PayPal's debug_id so it can be quoted to support. */
export function errorResponse(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "VALIDATION_ERROR", issues: err.issues }, { status: 400 });
  }
  if (err instanceof PayPalError) {
    const status = err.status >= 500 ? 502 : err.status;
    return NextResponse.json(
      { error: err.name, message: err.message, debug_id: err.debugId, details: err.details },
      { status },
    );
  }
  console.error(err);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

/** Client-supplied idempotency key (e.g. generated once per form render) so double-submits dedupe. */
export function idempotencyKey(req: Request) {
  const key = req.headers.get("idempotency-key");
  return key && /^[\w-]{8,108}$/.test(key) ? key : undefined;
}
