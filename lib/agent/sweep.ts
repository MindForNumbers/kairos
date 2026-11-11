import "server-only";
import { daysBetween, localDate, now, nowMs, timezone } from "@/lib/clock";
import { getStore, type Proposal, type ProposalStatus } from "@/lib/db";
import { fetchInvoice, listAllInvoices, type Invoice } from "./paypal-read";
import { ESCALATE_AFTER_DAYS, GRACE_DAYS } from "./policy";
import { cleanUntrusted, flagUntrusted } from "./untrusted";
import { loadDirectorPlan } from "@/lib/director/gather";
import type { DirectorPlan } from "@/lib/director/model";

/**
 * Sweep: READ-ONLY. Lists invoices, finds overdue ones, ranks them, and decides in code
 * which (at most RUN_SIZE) this run may draft for. Writes nothing to PayPal; the only
 * write is an audit row.
 */

/** Reminders drafted per run. Policy escalations (over 60 days) don't count toward it. */
export const RUN_SIZE = 5;
export const REMINDER_COOLDOWN_DAYS = 7;

/** Statuses where the customer still owes money and a reminder makes sense. */
export const CHASEABLE = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
/** Proposal states that mean "already being handled". Don't draft again. */
const ACTIVE_PROPOSAL: ProposalStatus[] = ["pending_review", "passed", "approved"];
/** Waiting on a human in "Needs a human". Don't re-draft until someone resolves it. */
const NEEDS_HUMAN: ProposalStatus[] = ["blocked", "escalated"];

export type InvoiceRecord = {
  invoiceId: string;
  invoiceNumber: string | null;
  status: string;
  currency: string;
  amountTotal: string | null;
  amountDue: string | null;
  amountPaid: string | null;
  invoiceDate: string | null;
  dueDate: string;
  daysOverdue: number;
  recipientEmail: string | null;
  lastReminderAt: string | null;
  severity: 1 | 2 | 3 | 4;
  /** Free text from PayPal, cleaned. DATA, never instructions. */
  untrusted: {
    recipientName: string | null;
    note: string | null;
    items: { name: string | null; description: string | null }[];
  };
  /** Heuristic hints that the free text contains instructions or concession requests. */
  flags: string[];
  /** The Director's call for this invoice (absent when it couldn't run: age-based tone applies). */
  director?: DirectorNote;
};

export type DirectorNote = { pressure: number; move: string; day: string | null; reason: string };

export type SweepResult = {
  asOf: string;
  today: string;
  timezone: string;
  /** This run's set: at most RUN_SIZE overdue invoices, highest priority first. */
  candidates: InvoiceRecord[];
  /** Overdue and eligible, but beyond this run's set. Next run. */
  deferred: InvoiceRecord[];
  /** Overdue but held back by code, with the reason. */
  excluded: { invoiceId: string; invoiceNumber: string | null; daysOverdue: number; reason: "grace_period" | "cooldown" | "in_queue" | "needs_human" | "director_wait" | "director_scheduled"; detail: string }[];
  openNotDue: { invoiceId: string; invoiceNumber: string | null; dueDate: string; amountDue: string | null }[];
  counts: { listed: number; open: number; overdue: number };
  truncated: boolean;
};

export function dueDateOf(inv: Invoice): string | null {
  return inv.detail.payment_term?.due_date ?? inv.detail.invoice_date ?? null;
}

/** Bucket by age: 1 = 1-7 days, 2 = 8-30, 3 = 31-60, 4 = 61+. */
function severityOf(daysOverdue: number): InvoiceRecord["severity"] {
  if (daysOverdue > 60) return 4;
  if (daysOverdue > 30) return 3;
  if (daysOverdue > 7) return 2;
  return 1;
}

/**
 * Priority: older bucket first; within a bucket, larger amount due first; then older first.
 * Simple and explainable on purpose. The critic flags any deferred invoice that looks more
 * urgent than one in the set.
 */
export function compareUrgency(a: InvoiceRecord, b: InvoiceRecord): number {
  return (
    (b.director?.pressure ?? -1) - (a.director?.pressure ?? -1) ||
    b.severity - a.severity ||
    Number(b.amountDue ?? 0) - Number(a.amountDue ?? 0) ||
    b.daysOverdue - a.daysOverdue ||
    a.invoiceId.localeCompare(b.invoiceId)
  );
}

export function toRecord(inv: Invoice, today: string, lastReminderAt: string | null): InvoiceRecord {
  const dueDate = dueDateOf(inv)!;
  const daysOverdue = daysBetween(dueDate, today);
  const recipient = inv.primary_recipients?.[0]?.billing_info;
  const name = recipient?.name?.full_name || [recipient?.name?.given_name, recipient?.name?.surname].filter(Boolean).join(" ");
  const untrusted = {
    recipientName: cleanUntrusted(name, 140),
    note: cleanUntrusted(inv.detail.note),
    items: (inv.items ?? []).slice(0, 20).map((it) => ({ name: cleanUntrusted(it.name, 200), description: cleanUntrusted(it.description) })),
  };
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.detail.invoice_number ?? null,
    status: inv.status,
    currency: inv.detail.currency_code,
    amountTotal: inv.amount?.value ?? null,
    amountDue: inv.due_amount?.value ?? inv.amount?.value ?? null,
    amountPaid: inv.payments?.paid_amount?.value ?? null,
    invoiceDate: inv.detail.invoice_date ?? null,
    dueDate,
    daysOverdue,
    recipientEmail: recipient?.email_address ?? null,
    lastReminderAt,
    severity: severityOf(daysOverdue),
    untrusted,
    flags: flagUntrusted(untrusted.note, untrusted.recipientName, ...untrusted.items.flatMap((i) => [i.name, i.description])),
  };
}

/**
 * The proposal that keeps an invoice out of a run, if any: one in the queue, or a
 * blocked/escalated one a human hasn't resolved or dismissed yet.
 */
export async function holdingProposal(invoiceId: string): Promise<{ proposal: Proposal; reason: "in_queue" | "needs_human" } | null> {
  const held = (await getStore().listProposals({ invoiceId, status: [...ACTIVE_PROPOSAL, ...NEEDS_HUMAN] }))
    .filter((p) => !(NEEDS_HUMAN.includes(p.status) && p.resolution));
  if (!held.length) return null;
  return { proposal: held[0], reason: NEEDS_HUMAN.includes(held[0].status) ? "needs_human" : "in_queue" };
}

/**
 * This run's set: every invoice policy will escalate (no draft, so no drafting cost), plus the
 * RUN_SIZE most urgent invoices that will be drafted. The rest wait for a later run.
 */
export function chooseRunSet(eligible: InvoiceRecord[]): { candidates: InvoiceRecord[]; deferred: InvoiceRecord[] } {
  const sorted = [...eligible].sort(compareUrgency);
  const escalate = sorted.filter((r) => r.daysOverdue > ESCALATE_AFTER_DAYS);
  const draftable = sorted.filter((r) => r.daysOverdue <= ESCALATE_AFTER_DAYS);
  const chosen = new Set([...escalate, ...draftable.slice(0, RUN_SIZE)]);
  return { candidates: sorted.filter((r) => chosen.has(r)), deferred: draftable.slice(RUN_SIZE) };
}

export type SweepOptions = {
  /** Restrict to these invoice IDs (a chat-requested draft). Same rules apply to each. */
  only?: string[];
  /** false = a read-only preview (the chat's "what's overdue"): no audit row. Default true. */
  audit?: boolean;
};

export async function sweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const store = getStore();
  const asOf = now();
  const today = localDate(asOf);
  const listed = await listAllInvoices();
  const truncated = listed.truncated;
  const invoices = opts.only ? listed.invoices.filter((i) => opts.only!.includes(i.id)) : listed.invoices;

  // The Director reads the WHOLE account (history), not just the "only" subset. If it can't run,
  // the sweep carries on with age-based tones (and says so in the audit row).
  let plan: DirectorPlan | null = null;
  let directorError: string | null = null;
  try {
    plan = await loadDirectorPlan({ invoices: listed.invoices, today });
  } catch (err) {
    directorError = (err as Error).message;
  }
  const moveOf = new Map((plan?.moves ?? []).map((m) => [m.invoiceId, m]));

  const open = invoices.filter((inv) => CHASEABLE.has(inv.status) && dueDateOf(inv));
  const overdueSummaries = open.filter((inv) => daysBetween(dueDateOf(inv)!, today) > 0);
  const openNotDue = open
    .filter((inv) => daysBetween(dueDateOf(inv)!, today) <= 0)
    .map((inv) => ({ invoiceId: inv.id, invoiceNumber: inv.detail.invoice_number ?? null, dueDate: dueDateOf(inv)!, amountDue: inv.due_amount?.value ?? null }));

  const eligible: InvoiceRecord[] = [];
  const excluded: SweepResult["excluded"] = [];
  const cooldownStart = nowMs() - REMINDER_COOLDOWN_DAYS * 86_400_000;

  for (const summary of overdueSummaries) {
    const last = await store.lastSendFor(summary.id);
    const days = daysBetween(dueDateOf(summary)!, today);
    if (days < GRACE_DAYS) {
      excluded.push({ invoiceId: summary.id, invoiceNumber: summary.detail.invoice_number ?? null, daysOverdue: days, reason: "grace_period",
        detail: `under the ${GRACE_DAYS}-day grace period` });
      continue;
    }
    if (last && Date.parse(last.sentAt) > cooldownStart) {
      excluded.push({ invoiceId: summary.id, invoiceNumber: summary.detail.invoice_number ?? null, daysOverdue: days, reason: "cooldown",
        detail: `last reminder ${last.sentAt} (${last.source})` });
      continue;
    }
    const hold = await holdingProposal(summary.id);
    if (hold) {
      excluded.push({ invoiceId: summary.id, invoiceNumber: summary.detail.invoice_number ?? null, daysOverdue: days,
        reason: hold.reason, detail: `proposal ${hold.proposal.id} is ${hold.proposal.status}` });
      continue;
    }
    // Summaries omit notes and line items, so fetch the full record. Re-check status: it may have changed.
    const full = await fetchInvoice(summary.id);
    if (!CHASEABLE.has(full.status) || !dueDateOf(full)) continue;
    const record = toRecord(full, today, last?.sentAt ?? null);
    if (record.daysOverdue < GRACE_DAYS) continue;
    const m = moveOf.get(record.invoiceId);
    if (m) {
      record.director = { pressure: m.pressure, move: m.move, day: m.day, reason: m.reason };
      // The Director decides what to propose and when, except for an owner's explicit request ("only").
      if (!opts.only && record.daysOverdue <= ESCALATE_AFTER_DAYS) {
        if (m.move === "wait") {
          excluded.push({ invoiceId: record.invoiceId, invoiceNumber: record.invoiceNumber, daysOverdue: days, reason: "director_wait", detail: m.reason });
          continue;
        }
        if (m.day && m.day > today) {
          excluded.push({ invoiceId: record.invoiceId, invoiceNumber: record.invoiceNumber, daysOverdue: days, reason: "director_scheduled", detail: m.reason });
          continue;
        }
      }
    }
    eligible.push(record);
  }

  const { candidates, deferred } = chooseRunSet(eligible);
  const result: SweepResult = {
    asOf: asOf.toISOString(),
    today,
    timezone: timezone(),
    candidates,
    deferred,
    excluded,
    openNotDue,
    counts: { listed: invoices.length, open: open.length, overdue: overdueSummaries.length },
    truncated,
  };

  if (opts.audit === false) return result;
  await store.audit({
    actor: "sweep",
    event: "sweep.completed",
    entityType: null,
    entityId: null,
    data: {
      asOf: result.asOf,
      counts: result.counts,
      candidates: result.candidates.map((c) => c.invoiceId),
      deferred: result.deferred.map((c) => c.invoiceId),
      excluded: result.excluded.map((e) => ({ id: e.invoiceId, reason: e.reason })),
      flagged: eligible.filter((r) => r.flags.length).map((r) => ({ id: r.invoiceId, flags: r.flags })),
      director: plan ? { forecast: { expectedCents: plan.forecast.expectedCents, shortfallCents: plan.forecast.shortfallCents }, moves: plan.moves.map((m) => [m.invoiceNumber ?? m.invoiceId, m.pressure, m.move, m.day]) } : { error: directorError },
      truncated,
      only: opts.only ?? null,
    },
  });
  return result;
}

/** Re-exported for the chat tools (same grace period the sweep enforces). */
export const GRACE_DAYS_EXPORT = GRACE_DAYS;
