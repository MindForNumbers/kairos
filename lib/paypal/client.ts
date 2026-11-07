import "server-only";
import { randomUUID } from "node:crypto";

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

type Env = keyof typeof BASE_URLS;

function config() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  }
  const raw = (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").trim().toLowerCase();
  const env: Env = raw === "live" || raw === "production" ? "live" : "sandbox";
  return { clientId, clientSecret, baseUrl: BASE_URLS[env] };
}

/** Error carrying PayPal's structured error body. Always log `debugId` — PayPal support needs it. */
export class PayPalError extends Error {
  constructor(
    public status: number,
    public name: string,
    message: string,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// ---- OAuth token cache --------------------------------------------------
// One token per server process, refreshed 60s before expiry. Concurrent
// callers share the same in-flight request instead of stampeding /oauth2/token.
let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (inflight) return inflight;

  inflight = (async () => {
    const { clientId, clientSecret, baseUrl } = config();
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new PayPalError(res.status, body.error ?? "AUTH_FAILED", body.error_description ?? "PayPal auth failed", res.headers.get("paypal-debug-id") ?? undefined);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// ---- Request helper -----------------------------------------------------

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Reuse a caller-supplied key so retried/double-submitted POSTs are deduplicated by PayPal. */
  requestId?: string;
  query?: Record<string, string | number | boolean | undefined>;
};

const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function paypalRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { baseUrl } = config();
  const method = opts.method ?? "GET";
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  // Fixed for the lifetime of this call, so retries are idempotent on PayPal's side.
  const requestId = method === "POST" ? (opts.requestId ?? randomUUID()) : undefined;

  for (let attempt = 1; ; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store",
    });

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    // Token revoked/expired early: drop cache and retry once.
    if (res.status === 401 && attempt === 1) {
      cached = null;
      continue;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** (attempt - 1) * 500 + Math.random() * 250;
      await sleep(backoff);
      continue;
    }

    const body = await res.json().catch(() => ({}));
    const err = new PayPalError(
      res.status,
      body.name ?? `HTTP_${res.status}`,
      body.message ?? res.statusText,
      body.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
      body.details,
    );
    console.error(`[paypal] ${method} ${url.pathname} -> ${res.status} ${err.name} debug_id=${err.debugId}`, body.details ?? "");
    throw err;
  }
}
