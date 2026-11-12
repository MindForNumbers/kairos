import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorize } from "@/lib/auth";
import { chatCall, chatModel } from "@/lib/llm/client";
import { CostCapError, createChatTurnBudget } from "@/lib/agent/budget";
import { fromClaude, toClaude, type StudioRequest } from "@/lib/reports/ai";

export const maxDuration = 120;

const MAX_BODY = 600_000;
const Body = z.object({
  input: z.array(z.object({ type: z.string() }).passthrough()).max(400),
  instructions: z.string().max(100_000).optional(),
  tools: z.array(z.object({ name: z.string().max(64), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() }).passthrough()).max(64).optional(),
  toolChoice: z.unknown().optional(),
  responseFormat: z.object({ type: z.enum(["text", "json"]) }).passthrough().optional(),
});

/**
 * One AG Studio assistant turn on /reports → one Claude call. Session-gated and same-origin
 * (authorize), under the chat's per-message cap and the shared daily cap (recorded in model_calls
 * as "reports_ai"). The model only gets the report tools in lib/reports/ai.ts; Studio runs them in
 * the owner's browser. Nothing here reads or writes invoices.
 */
export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "VALIDATION_ERROR", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });

  const turnId = randomUUID().replace(/-/g, "").slice(0, 16);
  const { system, messages, tools } = toClaude(parsed.data as unknown as StudioRequest);
  try {
    const { response } = await chatCall({
      purpose: "reports_ai", model: chatModel(), system, messages, tools,
      maxTokens: 2048, effort: "low", budget: createChatTurnBudget(`reports_${turnId}`),
    });
    return NextResponse.json(fromClaude(response, turnId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof CostCapError) {
      return NextResponse.json({ error: "COST_CAP", message: err.cap === "daily" ? "Today's AI spend cap is reached." : "This request is larger than one assistant turn may cost." }, { status: 429 });
    }
    console.error("[reports-ai]", err);
    return NextResponse.json({ error: "AI_FAILED", message: "The assistant couldn't answer just now." }, { status: 502 });
  }
}
