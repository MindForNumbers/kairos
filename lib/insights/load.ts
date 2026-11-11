import "server-only";
import { nowMs } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { listAllInvoices, type Invoice } from "@/lib/agent/paypal-read";
import { cleanUntrusted } from "@/lib/agent/untrusted";
import { gatherDirectorInput } from "@/lib/director/gather";
import { direct, type DirectorPlan } from "@/lib/director/model";
import { computeInsights, type Insight } from "./compute";

/**
 * Live insights: Director input (invoices, ledger, Transaction Search, holds, policy) → plan →
 * insights. READ-ONLY. Cached briefly so opening the panel doesn't refetch every invoice.
 */

const TTL_MS = 2 * 60_000;
type Loaded = { insights: Insight[]; plan: DirectorPlan; names: Record<string, string | null>; at: number };
let cached: Loaded | null = null;

/** Tests, and after an action changes the picture (a hold, a new draft). */
export function invalidateInsights() { cached = null; }

function namesOf(invoices: Invoice[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const inv of invoices) {
    const b = inv.primary_recipients?.[0]?.billing_info;
    const email = b?.email_address?.trim().toLowerCase();
    if (!email || out[email]) continue;
    out[email] = cleanUntrusted(b?.name?.full_name || [b?.name?.given_name, b?.name?.surname].filter(Boolean).join(" "), 80);
  }
  return out;
}

export async function loadInsights(opts: { invoices?: Invoice[]; today?: string; fresh?: boolean } = {}): Promise<Loaded> {
  if (!opts.fresh && !opts.invoices && cached && nowMs() - cached.at < TTL_MS) return cached;
  const store = getStore();
  const invoices = opts.invoices ?? (await listAllInvoices()).invoices;
  const [input, queue] = await Promise.all([
    gatherDirectorInput({ invoices, today: opts.today }),
    store.listProposals({ status: ["pending_review", "passed", "approved", "blocked", "escalated"] }),
  ]);
  const plan = direct(input);
  const inQueue = queue.filter((p) => !(["blocked", "escalated"].includes(p.status) && p.resolution)).map((p) => p.invoiceId);
  // Names only for display: customer-entered text, cleaned; never shown to a model outside <untrusted_data>.
  const loaded: Loaded = { insights: computeInsights(input, plan, { inQueue }), plan, names: namesOf(invoices), at: nowMs() };
  if (!opts.invoices) cached = loaded;
  return loaded;
}
