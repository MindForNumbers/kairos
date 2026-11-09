import "server-only";
/**
 * The agent's (and the chat's) ONLY door to PayPal: read operations, nothing else.
 * scripts/check-boundaries.mjs fails the build if anything else in lib/agent/ or lib/chat/
 * imports lib/paypal, or if this file imports anything beyond the reads below.
 */
import { getInvoice, listInvoices } from "@/lib/paypal/invoices";
import type { Invoice } from "@/lib/paypal/invoices";

export type { Invoice };

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

type Reads = {
  listAllInvoices(): Promise<{ invoices: Invoice[]; truncated: boolean }>;
  fetchInvoice(id: string): Promise<Invoice>;
};

const real: Reads = {
  async listAllInvoices() {
    const invoices: Invoice[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await listInvoices(page, PAGE_SIZE);
      invoices.push(...(res.items ?? []));
      if (page >= (res.total_pages ?? 1)) return { invoices, truncated: false };
    }
    return { invoices, truncated: true };
  },
  fetchInvoice: (id) => getInvoice(id),
};
let reads: Reads = real;

/** Tests only: serve invoices from a fixture (null restores PayPal). */
export function setPaypalReadsForTesting(r: Reads | null): void {
  reads = r ?? real;
}

/** Every invoice summary in the account (up to MAX_PAGES × PAGE_SIZE). */
export function listAllInvoices(): Promise<{ invoices: Invoice[]; truncated: boolean }> {
  return reads.listAllInvoices();
}

/** Full invoice record (summaries omit notes and line items). */
export function fetchInvoice(id: string): Promise<Invoice> {
  return reads.fetchInvoice(id);
}
