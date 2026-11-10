import "server-only";
import { localDate } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { listInvoices, type Invoice } from "@/lib/paypal/invoices";
import { createdAt, stats, type Totals } from "@/lib/invoice-stats";

/** Home-page numbers, computed from live PayPal data with the same overdue rule as the agent. */
export type Dashboard = {
  unpaid: Totals;
  overdue: { count: number; oldestDays: number | null };
  queue: { awaitingApproval: number; needsHuman: number };
  recent: Invoice[];
  /** Every invoice listed (for the Kairos briefing's most-urgent pick). */
  invoices: Invoice[];
  truncated: boolean;
  today: string;
};

const RECENT = 8;
const MAX_PAGES = 10;

export async function loadDashboard(): Promise<Dashboard> {
  const today = localDate();
  const all: Invoice[] = [];
  let truncated = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await listInvoices(page, 100);
    all.push(...(res.items ?? []));
    if (page >= (res.total_pages ?? 1)) { truncated = false; break; }
  }
  const s = stats(all, today);
  const { awaitingApproval, needsHuman } = await queueCounts();
  return {
    unpaid: s.unpaid,
    overdue: { count: s.overdueCount, oldestDays: s.oldestOverdueDays },
    queue: { awaitingApproval, needsHuman },
    recent: [...all].sort((a, b) => createdAt(b).localeCompare(createdAt(a))).slice(0, RECENT),
    invoices: all,
    truncated,
    today,
  };
}

async function queueCounts() {
  const store = getStore();
  const [queued, human] = await Promise.all([
    store.listProposals({ status: ["passed", "approved"] }),
    store.listProposals({ status: ["blocked", "escalated"] }),
  ]);
  return { awaitingApproval: queued.length, needsHuman: human.filter((p) => !p.resolution).length };
}

/** For the header badge: drafts waiting for a human decision. */
export async function approvalsBadge(): Promise<number> {
  const q = await queueCounts();
  return q.awaitingApproval + q.needsHuman;
}
