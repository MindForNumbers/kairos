"use client";
/**
 * The AG Studio assistant on /reports. Studio owns the loop and runs the tools in this browser;
 * each model turn goes to Kairos's own /api/reports/ai (session-gated, spend-capped), which calls
 * Claude with only the report tools. No key ever reaches the browser.
 *
 * Studio's own agents read the report and build widgets on this page; they have no tool that
 * can change invoices, reminders or anything else in Kairos.
 */
import { createAiHarness, type AgAiEvent, type AgAiHarnessSetup, type AgLlmAdapter, type AgLlmResponse, type AgStudioApi } from "ag-studio";

const ENDPOINT = "/api/reports/ai";

const failed = (code: string, message: string): AgLlmResponse => ({
  id: `err_${code}`, createdAt: Math.floor(Date.now() / 1000), status: "failed", output: [], error: { code, message },
});

export const kairosAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const complete: Promise<AgLlmResponse> = (async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: request.input, instructions: request.instructions, tools: request.tools, toolChoice: request.toolChoice, responseFormat: request.responseFormat }),
        signal: options?.signal,
      });
      const body = (await res.json().catch(() => null)) as (AgLlmResponse & { message?: string; error?: unknown }) | null;
      if (!res.ok || !body) return failed(String((body as { error?: string } | null)?.error ?? res.status), body?.message ?? "The assistant couldn't answer just now.");
      return { ...body, createdAt: Math.floor(Date.now() / 1000) };
    })();

    // The server answers in one piece; replay it as Studio's events.
    const stream = {
      async *[Symbol.asyncIterator](): AsyncIterator<AgAiEvent> {
        const r = await complete;
        if (r.status === "failed") { yield { type: "RUN_ERROR", message: r.error?.message ?? "Failed", code: r.error?.code }; return; }
        for (const item of r.output) {
          if (item.type === "message") {
            const text = item.content.map((c) => ("text" in c ? c.text : "")).join("");
            yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
            yield { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text };
            yield { type: "TEXT_MESSAGE_END", messageId: item.id };
          } else if (item.type === "function_call") {
            yield { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name };
            yield { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments };
            yield { type: "TOOL_CALL_END", toolCallId: item.callId };
          }
        }
      },
    };
    return { stream, complete };
  },
};

export const PROMPT_STARTERS = [
  { label: "Overdue by customer", prompt: "Show overdue amounts by customer." },
  { label: "Pressure by customer", prompt: "Add a chart of Director pressure by customer." },
  { label: "Who should I chase?", prompt: "Which customers should I focus on this week, and why? Use the Director's pressure and next move." },
];

// Studio's built-in agent team (lead, planning, data, page, widget) on Kairos's adapter. Every
// Studio tool only changes this report in the browser; the server still drops any tool name
// outside Studio's own report tools (lib/reports/ai.ts).
export const buildReportsAi = (): AgAiHarnessSetup => ({ api }) =>
  createAiHarness(api as AgStudioApi, { adapter: kairosAdapter, promptStarters: PROMPT_STARTERS });
