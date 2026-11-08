import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_MS, checkPassword, createSessionValue, passwordConfigured, sameOrigin, safeNext } from "@/lib/auth";
import { getStore } from "@/lib/db";

// Failed attempts per client, in memory: 5 per 15 minutes, then 429 until the window ends.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

export async function POST(req: Request) {
  if (!passwordConfigured()) {
    return NextResponse.json({ error: "AUTH_NOT_CONFIGURED", message: "Set KAIROS_ADMIN_PASSWORD (12+ characters) and restart." }, { status: 503 });
  }
  if (!sameOrigin(req)) return NextResponse.json({ error: "CROSS_ORIGIN_REQUEST" }, { status: 403 });

  const who = clientKey(req);
  const now = Date.now(); // real-clock: rate-limit window
  const f = failures.get(who);
  if (f && f.resetAt > now && f.count >= MAX_FAILURES) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS", retryAfterSeconds: Math.ceil((f.resetAt - now) / 1000) }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const ok = typeof body.password === "string" && checkPassword(body.password);
  await getStore().audit({ actor: "user:admin", event: ok ? "auth.login" : "auth.login_failed", entityType: null, entityId: null, data: { client: who } });

  if (!ok) {
    const cur = f && f.resetAt > now ? f : { count: 0, resetAt: now + WINDOW_MS };
    failures.set(who, { count: cur.count + 1, resetAt: cur.resetAt });
    return NextResponse.json({ error: "INVALID_PASSWORD" }, { status: 401 });
  }
  failures.delete(who);
  const res = NextResponse.json({ ok: true, next: safeNext(body.next) });
  res.cookies.set(SESSION_COOKIE, createSessionValue(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}
