/**
 * App-wide password (KAIROS_ADMIN_PASSWORD). One shared admin login.
 * Enforced twice: in proxy.ts for every request, and again inside every page and route
 * handler (authorize / requirePageSession), so one missed matcher can't open a hole.
 * No "server-only" import: proxy.ts runs this outside the React server bundle.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "kairos_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const ADMIN_ACTOR = "user:admin";

/** Reachable without a session. The PayPal webhook authenticates by PayPal signature instead. */
/** /api/webhooks/invoices is the same webhook handler under the URL registered with PayPal. */
/** Cron endpoints authenticate with a bearer secret instead (lib/cron.ts). */
export const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/webhooks/paypal", "/api/webhooks/invoices", "/api/cron/agent-run", "/api/cron/demo-reset"]);

function adminPassword(): string | null {
  const pw = process.env.KAIROS_ADMIN_PASSWORD;
  return pw && pw.length > 0 ? pw : null;
}

export function passwordConfigured(): boolean {
  const pw = adminPassword();
  return pw !== null && pw.length >= 12;
}

const sha = (s: string) => createHash("sha256").update(s).digest();

export function checkPassword(input: string): boolean {
  const pw = adminPassword();
  if (!pw || !passwordConfigured()) return false;
  return timingSafeEqual(sha(input), sha(pw));
}

/** HMAC key derived from the password: changing the password signs everyone out. */
function key(): Buffer {
  return sha(`kairos-session-v1\0${adminPassword() ?? ""}`);
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function createSessionValue(): string {
  // real-clock: session lifetime is wall-clock time, not business time (KAIROS_NOW).
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${exp}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionValue(value: string | undefined | null): boolean {
  if (!value || !passwordConfigured()) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const payload = value.slice(0, i);
  const given = Buffer.from(value.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const exp = Number(payload.split(".")[0]);
  // real-clock
  return Number.isFinite(exp) && exp > Date.now();
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * For route handlers: null when the request carries a valid session, otherwise the
 * response to return (401, or 503 when no password is configured). State-changing
 * requests must also come from this origin (CSRF).
 */
export function authorize(req: Request): Response | null {
  if (!passwordConfigured()) {
    return Response.json({ error: "AUTH_NOT_CONFIGURED", message: "Set KAIROS_ADMIN_PASSWORD (12+ characters)" }, { status: 503 });
  }
  if (!verifySessionValue(readCookie(req.headers.get("cookie"), SESSION_COOKIE))) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!sameOrigin(req)) return Response.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 });
  return null;
}

/** GET/HEAD always pass; anything else needs an Origin (or Referer) matching Host. */
export function sameOrigin(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!host || !source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

/** Only same-site relative paths; anything else falls back to "/". */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
