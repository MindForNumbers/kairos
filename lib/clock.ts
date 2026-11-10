/**
 * The only time source in Kairos. Code that needs "now" (overdue math, the 7-day rule,
 * the daily cap, quiet hours, token expiry, DB timestamps) calls into this module, never
 * `new Date()` or `Date.now()` directly. scripts/check-boundaries.mjs enforces that.
 *
 * KAIROS_NOW=<ISO timestamp> moves the clock: it reads that instant at process start and
 * keeps ticking from there, so a 15-minute token still expires 15 real minutes later.
 * KAIROS_NOW_FROZEN=1 stops it ticking (tests).
 */

type ClockState = { offsetMs: number; frozenAt: number | null };

function fromEnv(): ClockState {
  const raw = process.env.KAIROS_NOW?.trim();
  if (!raw) return { offsetMs: 0, frozenAt: null };
  const target = Date.parse(raw);
  if (Number.isNaN(target)) throw new Error(`KAIROS_NOW is not a valid ISO timestamp: ${raw}`);
  return process.env.KAIROS_NOW_FROZEN === "1"
    ? { offsetMs: 0, frozenAt: target }
    : { offsetMs: target - Date.now(), frozenAt: null };
}

let state: ClockState = fromEnv();

export function nowMs(): number {
  return state.frozenAt ?? Date.now() + state.offsetMs;
}

export function now(): Date {
  return new Date(nowMs());
}

export function nowIso(): string {
  return now().toISOString();
}

/** True when KAIROS_NOW (or a test) has moved the clock. Shown in the UI so demos aren't mistaken for real time. */
export function isOverridden(): boolean {
  return state.frozenAt !== null || state.offsetMs !== 0;
}

/** Tests only: pin the clock to an instant (or reset to real or env time with `null`). */
export function setClockForTesting(at: Date | string | null): void {
  state = at === null ? fromEnv() : { offsetMs: 0, frozenAt: new Date(at).getTime() };
}

// ---- Calendar helpers (in the business timezone) ------------------------

export function timezone(): string {
  return process.env.KAIROS_TIMEZONE?.trim() || "America/Los_Angeles";
}

/** YYYY-MM-DD for an instant in the business timezone. */
export function localDate(at: Date = now(), tz = timezone()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Minutes since local midnight (0-1439) in the business timezone. */
export function localMinuteOfDay(at: Date = now(), tz = timezone()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD strings). Positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The UTC instant of local midnight today in the business timezone (start of the daily-cap window). */
export function startOfLocalDay(at: Date = now(), tz = timezone()): Date {
  const date = localDate(at, tz);
  // Search the ±14h window for the instant whose local date flips to `date` at 00:00.
  let guess = Date.parse(`${date}T00:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const minutes = localMinuteOfDay(new Date(guess), tz);
    const sameDay = localDate(new Date(guess), tz) === date;
    guess -= (sameDay ? minutes : minutes - 1440) * 60_000;
  }
  return new Date(guess);
}

/** The UTC instant of local midnight at the start of a YYYY-MM-DD business date. */
export function startOfLocalDate(date: string, tz = timezone()): Date {
  // Noon UTC falls on the same calendar date in every zone from UTC-11 to UTC+11.
  return startOfLocalDay(new Date(`${date}T12:00:00Z`), tz);
}

/** Monday of the business week containing `date` (YYYY-MM-DD). */
export function startOfLocalWeek(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Calendar date `n` days after a YYYY-MM-DD date (negative n goes back). */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
