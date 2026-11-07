import "server-only";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { assertPriced, costOf, maxCostOf } from "./pricing";

/** Every model call in Kairos goes through this module. */
export const MODEL = "claude-haiku-5-5";
/** The drafter runs on MODEL. */
export const DRAFTER_MODEL = MODEL;
/** The critic runs on a different model so the drafter's blind spots aren't shared. */
export function criticModel(): string {
  return process.env.KAIROS_CRITIC_MODEL?.trim() || "claude-sonnet-5-5";
}

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
  /** Defaults to MODEL (the drafter's model). */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Spend guard: checked with a worst-case estimate BEFORE the call, recorded AFTER. */
  budget?: SpendGuard;
};

export type SpendGuard = {
  /** Throw to stop the call (e.g. a cost cap would be exceeded). */
  beforeCall(model: string, maxCostUsd: number, purpose: string): Promise<void>;
  afterCall(meta: CallMeta): Promise<void>;
};

export type CallMeta = {
  purpose: string;
  model: string;
  requestId: string | null;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Actual cost from token usage and lib/llm/pricing.ts. */
  costUsd: number;
  /** sha256 of system+user, so the audit log can prove what was sent without storing customer text twice. */
  promptHash: string;
  durationMs: number;
};

export type StructuredResult<T> =
  | { ok: true; data: T; meta: CallMeta }
  | { ok: false; reason: "refusal" | "max_tokens" | "invalid_output"; detail?: string; meta: CallMeta };

// ---- Transport: the only code that talks to the API. Tests replace it. ------------

export type TransportRequest = {
  purpose: string; model: string; system: string; user: string; maxTokens: number; effort: Effort; schema: z.ZodType;
};
export type TransportResponse = {
  model: string;
  requestId: string | null;
  stopReason: string | null;
  refusalCategory: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** The first text block, expected to be JSON. */
  text: string | null;
};
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

const anthropicTransport: Transport = async (req) => {
  // create().withResponse() rather than parse(): parse() drops the request id, which the audit log needs.
  // zodOutputFormat still constrains the output; the JSON is validated in structuredCall.
  const { data: response, request_id } = await getClient()
    .messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
    })
    .withResponse();
  return {
    model: response.model,
    requestId: request_id ?? null,
    stopReason: response.stop_reason,
    refusalCategory: response.stop_reason === "refusal" ? (response.stop_details?.category ?? null) : null,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    text: response.content.find((b) => b.type === "text")?.text ?? null,
  };
};

let transport: Transport = anthropicTransport;

/** Tests only: route model calls to a stub (null restores the real API). */
export function setTransportForTesting(t: Transport | null): void {
  transport = t ?? anthropicTransport;
}

/**
 * One stateless call that returns schema-validated JSON (or a typed failure).
 * Never throws on a refusal or bad output. Callers decide what that means (usually "escalate").
 * API and network errors still throw as Anthropic.APIError subclasses; a spend guard may throw too.
 */
export async function structuredCall<S extends z.ZodType>(call: StructuredCall<S>): Promise<StructuredResult<z.infer<S>>> {
  const model = call.model ?? MODEL;
  const maxTokens = call.maxTokens ?? 16_000;
  assertPriced(model);
  await call.budget?.beforeCall(model, maxCostOf(model, call.system.length + call.user.length, maxTokens), call.purpose);

  const started = Date.now(); // real-clock: measures latency
  const res = await transport({ purpose: call.purpose, model, system: call.system, user: call.user, maxTokens, effort: call.effort ?? "medium", schema: call.schema });

  const meta: CallMeta = {
    purpose: call.purpose,
    model: res.model,
    requestId: res.requestId,
    stopReason: res.stopReason,
    ...res.usage,
    costUsd: costOf(res.model, res.usage),
    promptHash: createHash("sha256").update(call.system).update("\0").update(call.user).digest("hex"),
    durationMs: Date.now() - started, // real-clock
  };
  await call.budget?.afterCall(meta);

  // No server-side refusal fallback is configured, so a refusal is a terminal result here.
  if (res.stopReason === "refusal") {
    return { ok: false, reason: "refusal", detail: res.refusalCategory ?? undefined, meta };
  }
  if (res.stopReason === "max_tokens") {
    return { ok: false, reason: "max_tokens", meta };
  }
  let json: unknown;
  try {
    json = JSON.parse(res.text ?? "");
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
