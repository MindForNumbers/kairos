import "server-only";
import { z } from "zod";
import { addDays, localDate, nowMs, startOfLocalDate, startOfLocalDay, startOfLocalWeek } from "@/lib/clock";
import { listPaymentsReceived, totalByCurrency } from "@/lib/payments/received";
import { getStore, type Proposal } from "@/lib/db";
import { loadDashboard, type Dashboard } from "@/lib/dashboard";
import { createBudget } from "@/lib/agent/budget";
import { cleanUntrusted } from "@/lib/agent/untrusted";
import { chatModel, structuredCall } from "@/lib/llm/client";
import { amountDue, currencyOf, daysOverdue, recipientEmail, type Totals } from "@/lib/invoice-stats";

/**
 * The briefing shown when the Kairos panel opens on an empty conversation.
 *
 * Numbers: computed in code from loadDashboard(), the same call the home tiles use, so
 * they match the tiles exactly. Wording: Haiku writes a TEMPLATE with {placeholders} and
 * no digits; code fills in the numbers on every load. The model never sees a number or
 * any customer text. A template is cached per "shape" (which counts are zero / one /
 * many, and what kind of urgent item there is) and regenerated at most once an hour.
 * Until then, or if the model call fails or a cap is hit, code's own wording is used.
 */

export type Urgent = {
  invoiceId: string;
  invoiceNumber: string;
  customer: string;
  amount: string; // "2,350.00 USD"
  daysOverdue: number;
  kind: "needs_human" | "awaiting_approval" | "overdue";
  why: string;
};

export type BriefingFacts = {
  today: string;
  unpaid: Totals;
  openCount: number;
  overdueCount: number;
  oldestOverdueDays: number | null;
  awaitingApproval: number;
  needsHuman: number;
  sentToday: number;
  urgent: Urgent | null;
  /** PayPal payments received this week (Transaction Search); null when it isn't available. */
  receivedThisWeek: { totals: Totals; count: number } | null;
  truncated: boolean;
};

export type Chip = { label: string; ask?: string; href?: string };
export type Briefing = { text: string; chips: Chip[]; facts: BriefingFacts; wording: "model" | "code" };

const fmtMoney = (value: string, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));

/** Pure: dashboard + queue + ledger count → facts. */
export function factsFrom(d: Dashboard, openProposals: Proposal[], sentToday: number, receivedThisWeek: BriefingFacts["receivedThisWeek"] = null): BriefingFacts {
  const byId = new Map(d.invoices.map((i) => [i.id, i]));
  const dueOf = (id: string) => { const inv = byId.get(id); return inv ? daysOverdue(inv, d.today) : 0; };
  const pick = (ps: Proposal[]) => [...ps].filter((p) => byId.has(p.invoiceId)).sort((a, b) => dueOf(b.invoiceId) - dueOf(a.invoiceId))[0];

  const human = openProposals.filter((p) => (p.status === "blocked" || p.status === "escalated") && !p.resolution);
  const waiting = openProposals.filter((p) => p.status === "passed" || p.status === "approved");
  const held = new Set(openProposals.map((p) => p.invoiceId));

  let urgent: Urgent | null = null;
  const make = (invoiceId: string, kind: Urgent["kind"], why: (days: number) => string): Urgent => {
    const inv = byId.get(invoiceId)!;
    const n = inv.primary_recipients?.[0]?.billing_info?.name;
    const days = daysOverdue(inv, d.today);
    return {
      invoiceId, invoiceNumber: inv.detail.invoice_number ?? inv.id, kind, daysOverdue: days, why: why(days),
      customer: cleanUntrusted(n?.full_name || [n?.given_name, n?.surname].filter(Boolean).join(" "), 80) ?? recipientEmail(inv) ?? "unknown customer",
      amount: fmtMoney(amountDue(inv), currencyOf(inv)),
    };
  };
  const h = pick(human);
  const w = pick(waiting);
  if (h) {
    urgent = make(h.invoiceId, "needs_human", (days) => h.status === "escalated"
      ? `${days} days overdue and escalated to you: contact the customer personally`
      : `its reminder draft was blocked by review and is waiting for you to resolve it`);
  } else if (w) {
    urgent = make(w.invoiceId, "awaiting_approval", (days) => `${days} days overdue; a reminder is drafted and waiting for your approval`);
  } else {
    const overdue = d.invoices.filter((i) => daysOverdue(i, d.today) > 0 && !held.has(i.id)).sort((a, b) => daysOverdue(b, d.today) - daysOverdue(a, d.today))[0];
    if (overdue) urgent = make(overdue.id, "overdue", (days) => `${days} days overdue with no reminder in the queue`);
  }

  return {
    today: d.today, unpaid: d.unpaid, openCount: d.unpaid.reduce((n, u) => n + u.count, 0),
    overdueCount: d.overdue.count, oldestOverdueDays: d.overdue.oldestDays,
    awaitingApproval: d.queue.awaitingApproval, needsHuman: d.queue.needsHuman, sentToday, urgent, receivedThisWeek, truncated: d.truncated,
  };
}

// ---- Rendering --------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Placeholder values, all computed in code. */
export function values(f: BriefingFacts): Record<string, string> {
  return {
    unpaid: f.unpaid.length ? f.unpaid.map((u) => fmtMoney(u.value, u.currency)).join(" + ") : "$0.00",
    openInvoices: plural(f.openCount, "open invoice", "open invoices"),
    overdueInvoices: plural(f.overdueCount, "invoice", "invoices"),
    oldestOverdueDays: f.oldestOverdueDays === null ? "" : plural(f.oldestOverdueDays, "day", "days"),
    remindersAwaiting: plural(f.awaitingApproval, "reminder", "reminders"),
    itemsNeedingYou: plural(f.needsHuman, "item", "items"),
    remindersSentToday: plural(f.sentToday, "reminder", "reminders"),
    receivedThisWeek: f.receivedThisWeek ? (f.receivedThisWeek.totals.length ? f.receivedThisWeek.totals.map((t) => fmtMoney(t.value, t.currency)).join(" + ") : "$0.00") : "",
    urgentInvoice: f.urgent?.invoiceNumber ?? "",
    urgentCustomer: f.urgent?.customer ?? "",
    urgentAmount: f.urgent?.amount ?? "",
    urgentWhy: f.urgent?.why ?? "",
  };
}

/** Which counts are zero / one / many, plus the urgent kind. Templates are cached per shape. */
export function shapeOf(f: BriefingFacts): string {
  const z = (n: number) => (n === 0 ? "0" : n === 1 ? "1" : "n");
  return [f.openCount, f.overdueCount, f.awaitingApproval, f.needsHuman, f.sentToday].map(z).join("") + `:${f.urgent?.kind ?? "none"}:${f.receivedThisWeek === null ? "x" : f.receivedThisWeek.count === 0 ? "0" : "p"}`;
}

/** The placeholders a template for this shape must use (everything that's non-empty). */
export function requiredPlaceholders(f: BriefingFacts): string[] {
  const req = ["unpaid", "overdueInvoices", "remindersAwaiting", "itemsNeedingYou", "remindersSentToday"];
  if (f.oldestOverdueDays !== null) req.push("oldestOverdueDays");
  if (f.urgent) req.push("urgentInvoice", "urgentCustomer", "urgentAmount", "urgentWhy");
  if (f.receivedThisWeek) req.push("receivedThisWeek");
  return req;
}

/** Code-only wording, always correct. */
export function codeTemplate(f: BriefingFacts): string {
  const lines = [
    `You have {unpaid} outstanding across {openInvoices}. {overdueInvoices} ${f.overdueCount === 1 ? "is" : "are"} overdue${f.oldestOverdueDays !== null ? ", the oldest by {oldestOverdueDays}" : ""}.`,
    `{remindersAwaiting} ${f.awaitingApproval === 1 ? "is" : "are"} waiting for your approval, {itemsNeedingYou} ${f.needsHuman === 1 ? "needs" : "need"} you, and {remindersSentToday} went out today.`,
  ];
  if (f.receivedThisWeek) lines.push(`{receivedThisWeek} came in through PayPal this week.`);
  if (f.urgent) lines.push(`Most urgent: {urgentInvoice} for {urgentCustomer} ({urgentAmount}), {urgentWhy}.`);
  return lines.join("\n");
}

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** A model template is accepted only if it has no digits, only known placeholders, and every required one. */
export function validTemplate(t: string, f: BriefingFacts): boolean {
  if (t.length > 700 || /\d/.test(t)) return false;
  const used = new Set([...t.matchAll(PLACEHOLDER)].map((m) => m[1]));
  const known = Object.keys(values(f));
  if ([...used].some((u) => !known.includes(u))) return false;
  if (/[{}]/.test(t.replace(PLACEHOLDER, ""))) return false;
  return requiredPlaceholders(f).every((r) => used.has(r));
}

export function render(template: string, f: BriefingFacts): string {
  const v = values(f);
  return template.replace(PLACEHOLDER, (_, k: string) => v[k] ?? "");
}

export function chipsFor(f: BriefingFacts): Chip[] {
  const chips: Chip[] = [];
  if (f.awaitingApproval > 0) chips.push({ label: `Review ${plural(f.awaitingApproval, "reminder", "reminders")}`, href: "/approvals" });
  if (f.urgent) chips.push({ label: `What should I do about ${f.urgent.invoiceNumber}?`, ask: `What should I do about ${f.urgent.invoiceNumber}?` });
  chips.push({ label: "Show my aging report", ask: "Show my aging report" });
  if (chips.length < 3) chips.push({ label: "Summarize this month", ask: "Give me a summary of this month" });
  return chips.slice(0, 3);
}

// ---- Template generation (Haiku) and cache ---------------------------------------------------

const TemplateSchema = z.object({ template: z.string() });
const REGEN_MS = 60 * 60 * 1000;

const SYSTEM = `You write the opening briefing for Kairos, an invoicing assistant for a small business owner. You write a TEMPLATE: code replaces each {placeholder} with a value, already formatted with its unit (e.g. {overdueInvoices} becomes "3 invoices", {unpaid} becomes "$3,975.00").

Rules:
- Use every placeholder in the required list exactly once. Don't invent placeholders.
- No digits anywhere: every number comes from a placeholder.
- Two or three short sentences, plain text, no markdown, friendly and direct, like a colleague catching the owner up. Lead with the money, then what needs them. If there is an urgent item, end with it.
- Grammar must work for the counts described (a count shown as "one" is singular).`;

type Cache = { templates: Map<string, string>; lastGenAt: number };
const g = globalThis as unknown as { __kairosBriefing?: Cache };
const cache = (g.__kairosBriefing ??= { templates: new Map(), lastGenAt: 0 });

/** Tests only. */
export function resetBriefingCacheForTesting() { cache.templates.clear(); cache.lastGenAt = 0; receivedCache = null; }

export async function templateFor(f: BriefingFacts): Promise<{ template: string; wording: "model" | "code" }> {
  const shape = shapeOf(f);
  const hit = cache.templates.get(shape);
  if (hit) return { template: hit, wording: "model" };
  if (nowMs() - cache.lastGenAt < REGEN_MS) return { template: codeTemplate(f), wording: "code" };
  cache.lastGenAt = nowMs(); // claim the hour before the call, so concurrent loads don't all generate
  const word = (n: number) => (n === 0 ? "zero" : n === 1 ? "one" : "several");
  const user = [
    `Required placeholders: ${requiredPlaceholders(f).map((p) => `{${p}}`).join(" ")}`,
    `Counts: open invoices ${word(f.openCount)}, overdue ${word(f.overdueCount)}, reminders awaiting approval ${word(f.awaitingApproval)}, items needing the owner ${word(f.needsHuman)}, reminders sent today ${word(f.sentToday)}.`,
    f.urgent ? `There is a most-urgent invoice; {urgentWhy} is a lowercase clause explaining why (kind: ${f.urgent.kind}).` : "There is no urgent item.",
    ...(f.receivedThisWeek ? ["{receivedThisWeek} is money received through PayPal this week only (not payments recorded by hand): always say \"through PayPal\" next to it."] : []),
    `Example of a valid template (rephrase it, keep it accurate): ${JSON.stringify(codeTemplate(f))}`,
  ].join("\n");
  try {
    const r = await structuredCall({ purpose: "briefing", model: chatModel(), system: SYSTEM, user, schema: TemplateSchema, effort: "low", maxTokens: 4000, budget: createBudget(null) });
    if (r.ok && validTemplate(r.data.template, f)) {
      cache.templates.set(shape, r.data.template);
      return { template: r.data.template, wording: "model" };
    }
  } catch (err) {
    console.warn("[briefing] template generation failed:", (err as Error).name, (err as Error).message);
  }
  return { template: codeTemplate(f), wording: "code" };
}

// PayPal's data lags up to 3 hours anyway, so a page load needn't query it every time.
const RECEIVED_TTL_MS = 10 * 60_000;
let receivedCache: { week: string; at: number; value: BriefingFacts["receivedThisWeek"] } | null = null;

async function receivedThisWeek(today: string): Promise<BriefingFacts["receivedThisWeek"]> {
  const week = startOfLocalWeek(today);
  if (receivedCache && receivedCache.week === week && nowMs() - receivedCache.at < RECEIVED_TTL_MS) return receivedCache.value;
  const r = await listPaymentsReceived(startOfLocalDate(week), startOfLocalDate(addDays(today, 1)));
  const value = r.state === "ok" ? { totals: totalByCurrency(r.payments), count: r.payments.length } : null;
  receivedCache = { week, at: nowMs(), value };
  return value;
}

export async function getBriefing(): Promise<Briefing> {
  const store = getStore();
  const [d, proposals, sentToday, received] = await Promise.all([
    loadDashboard(),
    store.listProposals({ status: ["passed", "approved", "blocked", "escalated"] }),
    store.countSendsSince(startOfLocalDay()),
    receivedThisWeek(localDate()),
  ]);
  const facts = factsFrom(d, proposals, sentToday, received);
  const { template, wording } = await templateFor(facts);
  return { text: render(template, facts), chips: chipsFor(facts), facts, wording };
}
