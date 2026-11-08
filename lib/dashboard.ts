import "server-only";
import { daysBetween, localDate } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { listInvoices, type Invoice } from "@/lib/paypal/invoices";
import { CHASEABLE, dueDateOf } from "@/lib/agent/sweep";

/** Home-page numbers, computed from live PayPal data with the same overdue rule as the agent. */
export type Dashboard = {
  /** Amount still due on open invoices, per currency (exact cents, no float drift). */
  unpaid: { currency: string; value: string; count: number }[];
  overdue: { count: number; oldestDays: number | null };
  queue: { awaitingApproval: number; needsHuman: number };
  recent: Invoice[];
  truncated: boolean;
  today: string;
};

const RECENT = 8;
const MAX_PAGES = 10;

const toCents = (v: string | undefined) => {
  const [whole, frac = ""] = (v ?? "0").split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2)) * (whole.startsWith("-") ? -1 : 1);
};
const fromCents = (c: number) => `${Math.trunc(c / 100)}.${String(Math.abs(c % 100)).padStart(2, "0")}`;

export async function loadDashboard(): Promise<Dashboard> {
  const today = localDate();
  const all: Invoice[] = [];
  let truncated = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await listInvoices(page, 100);
    all.push(...(res.items ?? []));
    if (page >= (res.total_pages ?? 1)) { truncated = false; break; }
  }

  const unpaid = new Map<string, { cents: number; count: number }>();
  let overdue = 0;
  let oldest: number | null = null;
  for (const inv of all) {
    if (!CHASEABLE.has(inv.status)) continue;
    const cur = inv.due_amount?.currency_code ?? inv.detail.currency_code;
    const u = unpaid.get(cur) ?? { cents: 0, count: 0 };
    u.cents += toCents(inv.due_amount?.value ?? inv.amount?.value);
    u.count++;
    unpaid.set(cur, u);
    const due = dueDateOf(inv);
    if (due && daysBetween(due, today) > 0) {
      overdue++;
      oldest = Math.max(oldest ?? 0, daysBetween(due, today));
    }
  }

  const store = getStore();
  const [queued, human] = await Promise.all([
    store.listProposals({ status: ["passed", "approved"] }),
    store.listProposals({ status: ["blocked", "escalated"] }),
  ]);

  const created = (inv: Invoice) => inv.detail.metadata?.create_time ?? inv.detail.invoice_date ?? "";
  return {
    unpaid: [...unpaid].map(([currency, u]) => ({ currency, value: fromCents(u.cents), count: u.count })),
    overdue: { count: overdue, oldestDays: oldest },
    queue: { awaitingApproval: queued.length, needsHuman: human.filter((p) => !p.resolution).length },
    recent: [...all].sort((a, b) => created(b).localeCompare(created(a))).slice(0, RECENT),
    truncated,
    today,
  };
}

/** For the header badge: drafts waiting for a human decision. */
export async function approvalsBadge(): Promise<number> {
  const store = getStore();
  const [queued, human] = await Promise.all([
    store.listProposals({ status: ["passed", "approved"] }),
    store.listProposals({ status: ["blocked", "escalated"] }),
  ]);
  return queued.length + human.filter((p) => !p.resolution).length;
}
