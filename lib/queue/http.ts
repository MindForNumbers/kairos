import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { QueueError } from "./actions";

export function queueError(err: unknown) {
  if (err instanceof QueueError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  if (err instanceof ZodError) return NextResponse.json({ error: "VALIDATION_ERROR", issues: err.issues }, { status: 400 });
  console.error(err);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}
