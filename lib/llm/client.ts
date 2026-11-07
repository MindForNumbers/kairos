import "server-only";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/** Every model call in Kairos goes through this module. One model, pinned. */
export const MODEL = "claude-haiku-5-5";

let client: Anthropic | undefined;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (add it to .env)");
  // Retries 408/409/429/5xx and connection errors with backoff.
  client ??= new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  return client;
}

export type Effort = "low" | "medium" | "high";

export type StructuredCall<S extends z.ZodType> = {
  /** Short label for the audit log, e.g. "drafter" or "critic". */
  purpose: string;
  system: string;
  /** The single user turn. Every call is one-shot: fresh context, no history. */
  user: string;
  schema: S;
  effort?: Effort;
  maxTokens?: number;
};

export type CallMeta = {
  purpose: string;
  model: string;
  requestId: string | null;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  /** sha256 of system+user, so the audit log can prove what was sent without storing customer text twice. */
  promptHash: string;
  durationMs: number;
};

export type StructuredResult<T> =
  | { ok: true; data: T; meta: CallMeta }
  | { ok: false; reason: "refusal" | "max_tokens" | "invalid_output"; detail?: string; meta: CallMeta };

/**
 * One stateless call that returns schema-validated JSON (or a typed failure).
 * Never throws on a refusal or bad output. Callers decide what that means (usually "escalate").
 * API and network errors still throw as Anthropic.APIError subclasses.
 */
export async function structuredCall<S extends z.ZodType>(call: StructuredCall<S>): Promise<StructuredResult<z.infer<S>>> {
  const started = Date.now(); // real-clock: measures latency
  // create().withResponse() rather than parse(): parse() drops the request id, which the audit log needs.
  // zodOutputFormat still constrains the output; we validate the JSON ourselves below.
  const { data: response, request_id } = await getClient()
    .messages.create({
      model: MODEL,
      max_tokens: call.maxTokens ?? 16_000,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      output_config: { effort: call.effort ?? "medium", format: zodOutputFormat(call.schema) },
    })
    .withResponse();

  const meta: CallMeta = {
    purpose: call.purpose,
    model: response.model,
    requestId: request_id ?? null,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    promptHash: createHash("sha256").update(call.system).update("\0").update(call.user).digest("hex"),
    durationMs: Date.now() - started, // real-clock
  };

  // Haiku 5.5 has no server-side refusal fallback, so a refusal is a terminal result here.
  if (response.stop_reason === "refusal") {
    return { ok: false, reason: "refusal", detail: response.stop_details?.category ?? undefined, meta };
  }
  if (response.stop_reason === "max_tokens") {
    return { ok: false, reason: "max_tokens", meta };
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    return { ok: false, reason: "invalid_output", detail: "response was not JSON", meta };
  }
  // Zod refinements (regex, ranges) aren't expressible in JSON Schema, so this is the real gate.
  const checked = call.schema.safeParse(json);
  if (!checked.success) {
    return { ok: false, reason: "invalid_output", detail: checked.error.message, meta };
  }
  return { ok: true, data: checked.data, meta };
}
