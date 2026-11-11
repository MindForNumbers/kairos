import "server-only";
import { z } from "zod";
import { nowMs } from "@/lib/clock";
import { createBudget } from "@/lib/agent/budget";
import { formatAmount, offerLabel } from "@/lib/agent/policy";
import { chatModel, structuredCall } from "@/lib/llm/client";
import type { Insight } from "./compute";

/**
 * Insight cards: code computes every number; Haiku only phrases. Same scheme as the briefing:
 * the model writes a TEMPLATE per card shape with {placeholders} and no digits, never seeing a
 * number or any customer text; code fills the values in. Templates are cached per shape and
 * generated at most once an hour (shared spend caps apply); code's own wording is the fallback.
 */

export type Card = {
  id: string;
  kind: Insight["kind"];
  title: string;
  text: string;
  action: Insight["action"];
  /** A follow-up question for the chat, when there is no one-click action. */
  ask: string | null;
  moneyAtStake: string;
};

const m = (cents: number, cur: string) => formatAmount((cents / 100).toFixed(2), cur);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const TITLES: Record<Insight["kind"], string> = {
  payment_plan_candidate: "Large invoice stuck: offer to let them pay in parts?",
  possible_outside_payment: "Possible payment outside the invoice",
  cash_forecast: "Cash over the next 14 days",
  slow_payer: "Slow payer",
};

export function shapeOf(i: Insight): string {
  if (i.kind === "possible_outside_payment") return `${i.kind}:${i.linkedTo ? "linked" : "unlinked"}`;
  if (i.kind === "cash_forecast") return `${i.kind}:${!i.targetCents ? "notarget" : i.shortfallCents ? "short" : "covered"}`;
  return i.kind;
}

/** Placeholder values, all computed in code. Customer names are cleaned, untrusted text. */
export function values(i: Insight, name: string): Record<string, string> {
  switch (i.kind) {
    case "payment_plan_candidate":
      return { invoice: i.invoiceNumber ?? i.invoiceId, customer: name, amount: m(i.dueCents, i.currency), days: plural(i.daysOverdue, "day", "days"), offer: offerLabel(i.offer) };
    case "possible_outside_payment":
      return { invoice: i.invoiceNumber ?? i.invoiceId, customer: name, paymentAmount: m(i.paymentCents, i.currency), paymentDate: i.paymentDate, linkedTo: i.linkedTo ?? "" };
    case "cash_forecast":
      return { expected: m(i.expectedCents, i.currency), horizon: plural(i.horizonDays, "day", "days"), confidence: i.confidence,
        target: i.targetCents ? m(i.targetCents, i.currency) : "", shortfall: i.shortfallCents ? m(i.shortfallCents, i.currency) : "" };
    case "slow_payer":
      return { customer: name, avgLate: plural(Math.round(i.avgDaysLate), "day", "days"), paidCount: plural(i.paidInvoices, "invoice", "invoices"), owes: m(i.openCents, i.currency) };
  }
}

export function codeTemplate(shape: string): string {
  switch (shape) {
    case "payment_plan_candidate": return "{invoice} for {customer} ({amount}) is {days} overdue. Your policy allows offering to let them {offer}; Kairos can draft that reminder for your approval.";
    case "possible_outside_payment:linked": return "{customer} sent a PayPal payment of {paymentAmount} on {paymentDate}, the same as what's due on {invoice}. PayPal links it to {linkedTo}, so check it wasn't meant for {invoice} before reminding them.";
    case "possible_outside_payment:unlinked": return "{customer} sent a PayPal payment of {paymentAmount} on {paymentDate}, the same as what's due on {invoice}, but it isn't linked to the invoice. It may already be paid: check before reminding them.";
    case "cash_forecast:notarget": return "About {expected} is likely to come in over the next {horizon}, based on how each customer usually pays (confidence: {confidence}).";
    case "cash_forecast:short": return "About {expected} is likely to come in over the next {horizon}, {shortfall} short of the {target} you need (confidence: {confidence}). The Director is pushing the likeliest large payers.";
    case "cash_forecast:covered": return "About {expected} is likely to come in over the next {horizon}, covering the {target} you need (confidence: {confidence}).";
    case "slow_payer": return "{customer} usually pays {avgLate} late (across {paidCount}) and owes {owes}. Expect to follow up, and plan cash around it.";
    default: return "";
  }
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

export function requiredFor(shape: string): string[] {
  return [...new Set([...codeTemplate(shape).matchAll(PLACEHOLDER)].map((x) => x[1]))];
}

export function validTemplate(t: string, shape: string): boolean {
  if (t.length > 400 || /\d/.test(t)) return false;
  const used = new Set([...t.matchAll(PLACEHOLDER)].map((x) => x[1]));
  const req = requiredFor(shape);
  if ([...used].some((u) => !req.includes(u))) return false;
  if (/[{}]/.test(t.replace(PLACEHOLDER, ""))) return false;
  return req.every((r) => used.has(r));
}

export function render(template: string, v: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, k: string) => v[k] ?? "");
}

// ---- Haiku templates, cached per shape ------------------------------------------------------

const SYSTEM = `You phrase short insight cards for Kairos, an invoicing assistant for a small business owner. You write TEMPLATES: code replaces each {placeholder} with a value already formatted with its unit (e.g. {amount} becomes "$2,350.00", {days} becomes "48 days").

Rules:
- For each shape, use every listed placeholder at least once, and no others.
- No digits anywhere: every number comes from a placeholder.
- One or two short sentences, plain text, friendly and direct. State the fact, then why it matters to the owner. Never promise an outcome, never mention discounts.`;

const Schema = z.object({ templates: z.array(z.object({ shape: z.string(), template: z.string() })) });
const REGEN_MS = 60 * 60 * 1000;
type Cache = { templates: Map<string, string>; lastGenAt: number };
const g = globalThis as unknown as { __kairosInsightPhrasing?: Cache };
const cache = (g.__kairosInsightPhrasing ??= { templates: new Map(), lastGenAt: 0 });

/** Tests only. */
export function resetInsightPhrasingForTesting() { cache.templates.clear(); cache.lastGenAt = 0; }

export async function templatesFor(shapes: string[]): Promise<Map<string, { template: string; wording: "model" | "code" }>> {
  const out = new Map<string, { template: string; wording: "model" | "code" }>();
  const missing = shapes.filter((s) => !cache.templates.has(s));
  if (missing.length && nowMs() - cache.lastGenAt >= REGEN_MS) {
    cache.lastGenAt = nowMs(); // claim the hour first, so concurrent loads don't all generate
    const user = missing.map((s) => `shape ${s}: placeholders ${requiredFor(s).map((p) => `{${p}}`).join(" ")}\n  example (rephrase it, keep it accurate): ${JSON.stringify(codeTemplate(s))}`).join("\n");
    try {
      const r = await structuredCall({ purpose: "insights", model: chatModel(), system: SYSTEM, user, schema: Schema, effort: "low", maxTokens: 3000, budget: createBudget(null) });
      if (r.ok) for (const t of r.data.templates) if (missing.includes(t.shape) && validTemplate(t.template, t.shape)) cache.templates.set(t.shape, t.template);
    } catch (err) {
      console.warn("[insights] template generation failed:", (err as Error).name, (err as Error).message);
    }
  }
  for (const s of shapes) {
    const hit = cache.templates.get(s);
    out.set(s, hit ? { template: hit, wording: "model" } : { template: codeTemplate(s), wording: "code" });
  }
  return out;
}

export async function toCards(insights: Insight[], names: Record<string, string | null>, opts: { phrase?: boolean } = {}): Promise<Card[]> {
  const shapes = [...new Set(insights.map(shapeOf))];
  const templates = opts.phrase === false
    ? new Map(shapes.map((s) => [s, { template: codeTemplate(s), wording: "code" as const }]))
    : await templatesFor(shapes);
  return insights.map((i) => {
    const name = (i.customer && names[i.customer]) || i.customer || "";
    // The follow-up question uses the email the owner invoiced, never the customer-entered name:
    // a chip click sends it as the user's own message.
    const ask = i.kind === "slow_payer" ? `How does ${i.customer} usually pay?` : i.kind === "cash_forecast" ? "What's my cash looking like?" : null;
    return { id: i.id, kind: i.kind, title: TITLES[i.kind], text: render(templates.get(shapeOf(i))!.template, values(i, name)), action: i.action, ask, moneyAtStake: m(i.moneyAtStakeCents, i.currency) };
  });
}
