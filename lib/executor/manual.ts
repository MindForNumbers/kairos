import "server-only";
import { getStore } from "@/lib/db";
import { classifySendError, executorDeps, remindRequestFor } from "./execute";
import { evaluateLimits } from "./limits";

/**
 * A human clicking "Send reminder" on an invoice. Same send path as the executor (one
 * attempt, no retry) and it goes in the send ledger, so it counts toward the daily cap and
 * the agent's 7-day rule. Differences from agent sends (decision 4):
 *   - KILL still blocks it.
 *   - 7-day rule, daily cap and quiet hours only WARN; the human confirms and it goes out.
 *   - It is never a dry run: a human chose to send it.
 */

export type ManualResult =
  | { status: "sent"; ledgerId: string; warnings: string[] }
  | { status: "needs_confirmation"; warnings: string[] }
  | { status: "halted"; reason: string }
  | { status: "failed"; reason: string; debugId?: string }
  | { status: "unknown"; reason: string; debugId?: string };

const WARNING_LABEL = { cooldown: "Reminded within the last 7 days", daily_cap: "Daily send cap reached", quiet_hours: "Inside quiet hours" } as const;

export async function sendManualReminder(
  invoiceId: string,
  msg: { subject?: string; note?: string },
  opts: { actor: string; confirmed: boolean },
): Promise<ManualResult> {
  const store = getStore();
  const deps = executorDeps();
  const audit = (event: string, data: Record<string, unknown>) =>
    store.audit({ actor: opts.actor, event: `manual_remind.${event}`, entityType: "invoice", entityId: invoiceId, data });

  if (deps.killActive()) {
    await audit("halted", { reason: "KILL file present" });
    return { status: "halted", reason: "KILL file present: all sending is halted" };
  }
  const warnings = (await evaluateLimits(invoiceId))
    .filter((l) => !l.ok && l.name !== "kill")
    .map((l) => `${WARNING_LABEL[l.name as keyof typeof WARNING_LABEL]} (${l.detail})`);
  if (warnings.length && !opts.confirmed) return { status: "needs_confirmation", warnings };

  try {
    await deps.ensureToken();
  } catch (err) {
    await audit("failed", { reason: `auth: ${(err as Error).message}` });
    return { status: "failed", reason: "Couldn't get a PayPal access token; nothing was sent" };
  }
  const request = remindRequestFor({ invoiceId, subject: msg.subject ?? null, note: msg.note ?? null });
  try {
    await deps.send(request, `manual_${invoiceId}`);
  } catch (err) {
    const c = classifySendError(err);
    await audit(c.sent === "no" ? "failed" : "unknown", { reason: c.detail, debugId: c.debugId ?? null, warningsConfirmed: warnings });
    return c.sent === "no"
      ? { status: "failed", reason: c.detail, debugId: c.debugId }
      : { status: "unknown", reason: `${c.detail}. Check the invoice's history in PayPal before sending again.`, debugId: c.debugId };
  }
  const entry = await store.recordManualSend({ invoiceId, subject: msg.subject ?? null, note: msg.note ?? null, actor: opts.actor });
  await audit("sent", { ledgerId: entry.id, warningsConfirmed: warnings });
  return { status: "sent", ledgerId: entry.id, warnings };
}
