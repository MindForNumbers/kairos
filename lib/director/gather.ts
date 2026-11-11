import "server-only";
import { addDays, localDate, startOfLocalDate } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { fetchInvoice, listAllInvoices, type Invoice } from "@/lib/agent/paypal-read";
import { currentPolicy } from "@/lib/agent/incentives";
import { cleanUntrusted, flagUntrusted } from "@/lib/agent/untrusted";
import { listPaymentsReceived } from "@/lib/payments/received";
import { direct, type DirectorInput, type DirectorInvoice, type DirectorPlan } from "./model";

/**
 * Builds the Director's input from live data. READ-ONLY: PayPal reads go through
 * lib/agent/paypal-read.ts, plus Transaction Search (read-only) and the store's ledger.
 * scripts/check-boundaries.mjs enforces that lib/director/ writes nothing.
 */

const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
/** Full records (with payment dates) fetched per plan: open invoices plus the newest with payments. */
const MAX_FULL = 120;
/** The offer sentence's fixed start (lib/agent/policy.ts offerSentence): marks a send that carried an offer. */
const OFFER_MARK = "You can pay this invoice in up to ";

const cents = (v: string | undefined) => Math.round(Number(v ?? 0) * 100) || 0;

export function toDirectorInvoice(inv: Invoice): DirectorInvoice {
  const b = inv.primary_recipients?.[0]?.billing_info;
  const name = b?.name?.full_name || [b?.name?.given_name, b?.name?.surname].filter(Boolean).join(" ");
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.detail.invoice_number ?? null,
    status: inv.status,
    customer: b?.email_address?.trim().toLowerCase() || null,
    currency: inv.detail.currency_code,
    totalCents: cents(inv.amount?.value),
    dueCents: cents(inv.due_amount?.value ?? inv.amount?.value),
    invoiceDate: inv.detail.invoice_date ?? null,
    dueDate: inv.detail.payment_term?.due_date ?? inv.detail.invoice_date ?? null,
    payments: (inv.payments?.transactions ?? []).filter((t) => t.payment_date && t.amount)
      .map((t) => ({ date: t.payment_date!, cents: cents(t.amount!.value), method: t.method ?? null })),
    flagged: flagUntrusted(cleanUntrusted(inv.detail.note), cleanUntrusted(name), ...(inv.items ?? []).flatMap((i) => [cleanUntrusted(i.name), cleanUntrusted(i.description)])).length > 0,
  };
}

/** Summaries omit payment dates and notes: fetch full records where they matter. */
async function withDetail(summaries: Invoice[]): Promise<Invoice[]> {
  const needs = summaries
    .filter((i) => OPEN.has(i.status) || cents(i.payments?.paid_amount?.value) > 0)
    .sort((a, b) => (b.detail.invoice_date ?? "").localeCompare(a.detail.invoice_date ?? "") || a.id.localeCompare(b.id))
    .slice(0, MAX_FULL);
  const full = new Map<string, Invoice>();
  for (let i = 0; i < needs.length; i += 10) {
    const batch = await Promise.all(needs.slice(i, i + 10).map((s) => fetchInvoice(s.id).catch(() => s)));
    for (const f of batch) full.set(f.id, f);
  }
  return summaries.map((s) => full.get(s.id) ?? s);
}

export async function gatherDirectorInput(opts: { invoices?: Invoice[]; today?: string } = {}): Promise<DirectorInput> {
  const today = opts.today ?? localDate();
  const store = getStore();
  const [summaries, ledger, holds, policy, received] = await Promise.all([
    opts.invoices ? Promise.resolve(opts.invoices) : listAllInvoices().then((r) => r.invoices),
    store.listLedger({ limit: 2000 }),
    store.listHolds({ active: true }),
    currentPolicy(),
    // 30 days: the Director's relief window is 7, the "payment outside the invoice" insight looks back 30.
    listPaymentsReceived(startOfLocalDate(addDays(today, -30)), startOfLocalDate(addDays(today, 1))),
  ]);
  const invoices = (await withDetail(summaries)).filter((i) => i.status !== "DRAFT" && i.status !== "CANCELLED").map(toDirectorInvoice);
  return {
    today,
    invoices,
    sends: ledger.map((l) => ({ invoiceId: l.invoiceId, date: localDate(new Date(l.sentAt)), offer: (l.note ?? "").includes(OFFER_MARK) })),
    received: received.state === "ok"
      ? received.payments.map((p) => ({ payerEmail: p.payerEmail?.toLowerCase() ?? null, date: p.localDate, cents: cents(p.amount.value), invoiceRef: p.invoiceRef }))
      : null,
    paymentPlan: policy.policy,
    cashTarget14d: policy.director.cashTarget14d,
    holds: holds.map((h) => ({ invoiceId: h.invoiceId, reason: h.reason })),
  };
}

export async function loadDirectorPlan(opts: { invoices?: Invoice[]; today?: string } = {}): Promise<DirectorPlan> {
  return direct(await gatherDirectorInput(opts));
}
