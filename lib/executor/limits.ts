import "server-only";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { localMinuteOfDay, now, nowMs, startOfLocalDay, timezone } from "@/lib/clock";
import { getStore } from "@/lib/db";

/**
 * Hard bounds on sending, enforced in code by the executor (agent sends) and by the manual
 * Remind route. Configuration:
 *   KAIROS_EXECUTOR_ENABLED=1   really send; anything else = dry run (every check, no PayPal call)
 *   KAIROS_DAILY_SEND_CAP       reminders per business day, agent + manual (default 10)
 *   KAIROS_QUIET_START / _END   no agent sends in this local window (default 21:00 → 08:00)
 *   KAIROS_KILL_FILE            if this file exists, nothing is sent (default ./KILL)
 */

export const COOLDOWN_DAYS = 7;

export function executorEnabled(): boolean {
  return process.env.KAIROS_EXECUTOR_ENABLED?.trim() === "1";
}

export function dailySendCap(): number {
  const raw = process.env.KAIROS_DAILY_SEND_CAP?.trim();
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`KAIROS_DAILY_SEND_CAP must be a whole number ≥ 0, got "${raw}"`);
  return n;
}

function parseHHMM(name: string, fallback: string): number {
  const raw = process.env[name]?.trim() || fallback;
  const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error(`${name} must be HH:MM (24h), got "${raw}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function quietHours(): { start: number; end: number; label: string } {
  const start = parseHHMM("KAIROS_QUIET_START", "21:00");
  const end = parseHHMM("KAIROS_QUIET_END", "08:00");
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { start, end, label: `${fmt(start)}–${fmt(end)} ${timezone()}` };
}

/** True inside [start, end) in the business timezone; handles windows that wrap midnight. */
export function inQuietHours(minuteOfDay: number, q = quietHours()): boolean {
  if (q.start === q.end) return false;
  return q.start < q.end ? minuteOfDay >= q.start && minuteOfDay < q.end : minuteOfDay >= q.start || minuteOfDay < q.end;
}

export function killFilePath(): string {
  return resolve(/*turbopackIgnore: true*/ process.env.KAIROS_KILL_FILE?.trim() || "KILL");
}

export function killActive(): boolean {
  return existsSync(killFilePath());
}

export type LimitCheck = { name: "kill" | "cooldown" | "daily_cap" | "quiet_hours"; ok: boolean; detail: string };

/** Every send-time bound for one invoice, evaluated now. */
export async function evaluateLimits(invoiceId: string): Promise<LimitCheck[]> {
  const store = getStore();
  const last = await store.lastSendFor(invoiceId);
  const cooldownStart = nowMs() - COOLDOWN_DAYS * 86_400_000;
  const sentToday = await store.countSendsSince(startOfLocalDay());
  const cap = dailySendCap();
  const q = quietHours();
  const minute = localMinuteOfDay(now());
  const kill = killActive();
  return [
    { name: "kill", ok: !kill, detail: kill ? `KILL file present (${killFilePath()})` : "no KILL file" },
    { name: "cooldown", ok: !(last && Date.parse(last.sentAt) > cooldownStart),
      detail: last ? `last reminder ${last.sentAt} (${last.source})${Date.parse(last.sentAt) > cooldownStart ? `, within ${COOLDOWN_DAYS} days` : ""}` : "no reminder sent before" },
    { name: "daily_cap", ok: sentToday < cap, detail: `${sentToday} of ${cap} sent today` },
    { name: "quiet_hours", ok: !inQuietHours(minute, q), detail: `now ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}, quiet ${q.label}` },
  ];
}
