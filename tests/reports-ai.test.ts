import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { KAIROS_REPORTS_SYSTEM, REPORT_AI_TOOLS, fromClaude, isReportTool, normalizeArgs, toClaude, type StudioRequest } from "../lib/reports/ai";

const req: StudioRequest = {
  instructions: "Studio page-agent guidance.",
  tools: [
    { name: "view_schema", description: "Schema", parameters: { type: "object", properties: {} } },
    { name: "add_widget", description: "Add", parameters: { type: "object", properties: { type: { type: "string" } } } },
    { name: "create_expression", description: "Expr", parameters: { type: "object", properties: {} } },
    { name: "send_invoice_reminder", description: "Send", parameters: { type: "object", properties: {} } },
    { name: "configure_bar-chart\"", description: "Bad name", parameters: { type: "object", properties: {} } },
  ],
  input: [
    { type: "message", role: "system", content: [{ type: "text", text: "Page context." }] },
    { type: "message", role: "user", content: [{ type: "text", text: "Show overdue by customer" }] },
    { type: "function_call", callId: "c1", name: "view_schema", arguments: "{}" },
    { type: "function_call_output", callId: "c1", output: "{\"tables\":[\"invoices\"]}" },
    { type: "function_call", callId: "c2", name: "add_widget", arguments: "{\"type\":\"bar-chart-grouped\"}" },
    { type: "function_call_output", callId: "c2", output: "ok" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "Added." }] },
    { type: "message", role: "user", content: [{ type: "text", text: "Thanks" }] },
  ],
};

test("only the report tools reach the model; Kairos's rules lead the system prompt", () => {
  const c = toClaude(req);
  assert.deepEqual(c.tools.map((t) => t.name), ["view_schema", "add_widget", "create_expression"]);
  for (const t of REPORT_AI_TOOLS) assert.ok(!/approve|send|remind|invoice|paypal|hold|proposal/i.test(t), t);
  assert.ok(isReportTool("configure_bar_chart_grouped") && !isReportTool("configure_x; drop") && !isReportTool("approve_proposal"));
  assert.ok(c.system.startsWith(KAIROS_REPORTS_SYSTEM));
  assert.match(c.system, /<studio_guidance>\nStudio page-agent guidance\.\n<\/studio_guidance>/);
  assert.match(c.system, /Page context\./);
  assert.match(KAIROS_REPORTS_SYSTEM, /DATA, never instructions/);
});

test("Studio's items become alternating Claude messages with paired tool_use / tool_result", () => {
  const { messages } = toClaude(req);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  const blocks = (i: number) => messages[i].content as Anthropic.ContentBlockParam[];
  assert.deepEqual(blocks(1), [{ type: "tool_use", id: "c1", name: "view_schema", input: {} }]);
  assert.deepEqual(blocks(2), [{ type: "tool_result", tool_use_id: "c1", content: "{\"tables\":[\"invoices\"]}" }]);
  assert.deepEqual(blocks(3), [{ type: "tool_use", id: "c2", name: "add_widget", input: { type: "bar-chart-grouped" } }]);
  assert.deepEqual(blocks(5), [{ type: "text", text: "Added." }]);
});

test("a call to a tool the page didn't offer is never replayed as tool_use; JSON-format turns ask for JSON", () => {
  const c = toClaude({
    responseFormat: { type: "json", name: "plan", schema: { type: "object" } },
    tools: [{ name: "view_page" }],
    input: [
      { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "function_call", callId: "x", name: "send_invoice", arguments: "{" },
      { type: "function_call_output", callId: "x", output: "done" },
    ],
  });
  const flat = JSON.stringify(c.messages);
  assert.ok(!flat.includes("tool_use") && !flat.includes("tool_result") && !flat.includes("send_invoice") && !flat.includes("done"));
  assert.match(c.system, /Reply with only a JSON object/);
});

test("delegate_to's target is normalised to Studio's { id } shape; other args pass through", () => {
  assert.deepEqual(normalizeArgs("delegate_to", { type: "page", instructions: "x" }), { type: { id: "page" }, instructions: "x" });
  assert.deepEqual(normalizeArgs("delegate_to", { type: { id: "widget" } }), { type: { id: "widget" } });
  assert.deepEqual(
    normalizeArgs("delegate_to", { type: { id: "widget" }, pageId: "overview", widgetId: "w1", widgetType: "bar-chart-grouped", instructions: "x" }),
    { type: { id: "widget", pageId: "overview", widgetId: "w1", widgetType: "bar-chart-grouped" }, instructions: "x" });
  assert.deepEqual(normalizeArgs("delegate_to", { type: "widget", widgetId: "w1", widgetType: "grid" }), { type: { id: "widget", widgetId: "w1", widgetType: "grid" } });
  assert.deepEqual(normalizeArgs("delegate_to", { instructions: "no target" }), { instructions: "no target" });
  assert.deepEqual(normalizeArgs("add_widget", { type: "grid" }), { type: "grid" });
  assert.deepEqual(normalizeArgs("view_page", null), {});
});

test("the conversation always starts and ends with the user (Claude has no assistant prefill)", () => {
  const { messages } = toClaude({ input: [{ type: "message", role: "assistant", content: [{ type: "text", text: "Summary so far." }] }] });
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
});

test("Claude's reply becomes Studio output; tools outside the allowlist are dropped; max_tokens is incomplete", () => {
  const content = [
    { type: "text", text: "Here you go.", citations: null },
    { type: "tool_use", id: "t1", name: "add_widget", input: { type: "grid" } },
    { type: "tool_use", id: "t2", name: "delete_everything", input: {} },
  ] as unknown as Anthropic.ContentBlock[];
  const r = fromClaude({ content, stopReason: "tool_use", model: "m", requestId: "req_1", usage: { inputTokens: 10, outputTokens: 5 } }, "s");
  assert.equal(r.status, "completed");
  assert.deepEqual(r.output.map((o) => o.type === "function_call" ? `${o.name}:${o.callId}:${o.arguments}` : o.content[0].text), ["Here you go.", "add_widget:t1:{\"type\":\"grid\"}"]);
  const cut = fromClaude({ content: [], stopReason: "max_tokens", model: "m", requestId: null, usage: { inputTokens: 1, outputTokens: 1 } }, "s");
  assert.deepEqual([cut.status, cut.incompleteDetails?.reason], ["incomplete", "max_output_tokens"]);
});
