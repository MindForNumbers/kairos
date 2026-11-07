import "server-only";
/**
 * The agent's ONLY door to PayPal: read operations, nothing else.
 * scripts/check-boundaries.mjs fails the build if anything else in lib/agent/ imports
 * lib/paypal, or if this file imports anything beyond the reads below.
 */
import { getInvoice, listInvoices } from "@/lib/paypal/invoices";
import type { Invoice } from "@/lib/paypal/invoices";

export type { Invoice };

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** Every invoice summary in the account (up to MAX_PAGES × PAGE_SIZE). */
export async function listAllInvoices(): Promise<{ invoices: Invoice[]; truncated: boolean }> {
  const invoices: Invoice[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await listInvoices(page, PAGE_SIZE);
    invoices.push(...(res.items ?? []));
    if (page >= (res.total_pages ?? 1)) return { invoices, truncated: false };
  }
  return { invoices, truncated: true };
}

/** Full invoice record (summaries omit notes and line items). */
export function fetchInvoice(id: string): Promise<Invoice> {
  return getInvoice(id);
}
