import "server-only";
import { PaypalClient } from "paypal";
import type { ClientOptions, TransactionDetails } from "paypal";
import { localDate } from "@/lib/clock";

/**
 * Payments received, from PayPal Transaction Search. READ-ONLY.
 *
 * Built with APIMatic's PayPal TypeScript SDK (`paypal`, from the paypal@context-plugins
 * plugin); the contract sheet is paypal-plan.md at the repo root. This is the only module
 * allowed to import the SDK, and it uses only `transactionSearch.searchTransactions`
 * (scripts/check-boundaries.mjs enforces both).
 *
 * Only completed (status S) incoming PayPal payments are listed. Payments recorded by hand in
 * Kairos (bank transfer, cash) are not PayPal transactions and never appear here, and PayPal
 * says new transactions can take up to 3 hours to show up.
 */

export type ReceivedPayment = {
  transactionId: string;
  /** When PayPal says the payment was initiated (ISO), and that day in the business timezone. */
  at: string;
  localDate: string;
  amount: { currency: string; value: string };
  eventCode: string;
  /** Untrusted customer text. */
  payerName: string | null;
  payerEmail: string | null;
  /** PayPal invoice ID (INV2-…) or invoice number, when the payment was for an invoice. */
  invoiceRef: string | null;
};

export type ReceivedResult =
  | { state: "ok"; payments: ReceivedPayment[]; dataAsOf: string | null; truncated: boolean; skipped: number }
  | { state: "not_enabled" | "unavailable"; message: string };

export const LAG_NOTE = "PayPal can take up to 3 hours to list a new payment, and payments recorded by hand in Kairos (bank transfer, cash) never appear here.";

const MAX_WINDOW_MS = 31 * 86_400_000 - 1000; // the API's range limit is 31 days
const MAX_WINDOWS = 13;
const MAX_PAGES = 10;
const REBUILD_AFTER_403_MS = 10 * 60_000;
const FIELDS = "transaction_info,payer_info,cart_info";

// ---- Client: one per process, built lazily ----------------------------------------------

let client: PaypalClient | null = null;
let fetchOverride: typeof fetch | null = null;
let rebuiltAt = 0;

class NotConfigured extends Error {}

function buildClient(): PaypalClient {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  // An unset credential is not an SDK error (it would 401 later), so check here.
  if (!clientId || !clientSecret) throw new NotConfigured("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");
  const env = (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").trim().toLowerCase();
  let serverOptions: ClientOptions["serverOptions"];
  if (env === "live" || env === "production") serverOptions = { baseUrl: "https://api-m.paypal.com" };
  else if (env !== "sandbox") throw new NotConfigured(`PAYPAL_ENVIRONMENT must be sandbox or live, got "${env}"`);
  // sandbox: the SDK's one built-in host (https://api-m.sandbox.paypal.com), no override.
  return new PaypalClient({
    oauth2: { clientId, clientSecret },
    ...(serverOptions ? { serverOptions } : {}),
    retry: { maxRetries: 2, timeout: 20_000 }, // reads only; keep a chat turn from hanging 4 × 60 s
    logging: { level: "off" }, // responses carry payer emails; also stops PAYPAL_CLIENT_LOG turning logging on
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
}

function getClient(): PaypalClient {
  client ??= buildClient();
  return client;
}

/** Tests only: route the SDK through a fake fetch (null restores the global fetch). */
export function setTransactionSearchFetchForTesting(f: typeof fetch | null): void {
  fetchOverride = f;
  client = null;
  rebuiltAt = 0;
}

// ---- Errors -----------------------------------------------------------------------------

type Family = { kind: string; uri: string; status?: number; payload?: { kind: string; body?: unknown; rawBody?: ArrayBuffer }; cause?: unknown };

/** The SDK's error family, narrowed on `kind` (dialect-safe: no instanceof across ESM/CJS copies). */
function isFamily(err: unknown): err is Family {
  return typeof err === "object" && err !== null && "kind" in err && "uri" in err;
}

function reasonOf(err: Family): string {
  const p = err.payload;
  if (!p) return "";
  if (p.kind === "searchError" && p.body && typeof p.body === "object") {
    const b = p.body as { name?: string; message?: string; debugId?: string };
    return `${b.name ?? ""}: ${b.message ?? ""} (debug_id ${b.debugId ?? "?"})`;
  }
  return p.rawBody ? new TextDecoder().decode(p.rawBody).slice(0, 300) : "";
}

type Failure = { state: "not_enabled" | "unavailable"; message: string; status?: number };

function classify(err: unknown): Failure {
  if (err instanceof NotConfigured) return { state: "unavailable", message: "PayPal isn't configured for Kairos." };
  if (!isFamily(err)) throw err; // an abort reason, a ConfigurationError or a bug
  if (err.kind === "api") {
    console.warn(`[payments] searchTransactions HTTP ${err.status}: ${reasonOf(err)}`);
    if (err.status === 403) return { state: "not_enabled", status: 403, message: "Transaction Search isn't enabled for this PayPal app, so Kairos can't see payments received." };
    if (err.status === 401) return { state: "unavailable", message: "PayPal rejected Kairos's credentials." };
    if (err.status === 429 || (err.status ?? 0) >= 500) return { state: "unavailable", message: "PayPal's reporting service is busy. Try again in a few minutes." };
    return { state: "unavailable", message: "PayPal couldn't list payments just now." };
  }
  console.warn(`[payments] searchTransactions failed: ${err.kind}`, err.cause ?? "");
  if (err.kind === "auth") return { state: "unavailable", message: "Kairos couldn't sign in to PayPal." };
  return { state: "unavailable", message: "PayPal couldn't be reached just now." };
}

// ---- Search -----------------------------------------------------------------------------

const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Pure: one transaction row → a received payment, or null if it isn't one (or lacks what we need). */
export function toReceived(t: TransactionDetails): ReceivedPayment | "skip" | null {
  const info = t.transactionInfo;
  if (!info?.transactionId || !info.transactionAmount || !info.transactionInitiationDate) return "skip";
  const value = Number(info.transactionAmount.value);
  if (info.transactionStatus !== "S" || !(value > 0) || !(info.transactionEventCode ?? "").startsWith("T00")) return null;
  const n = t.payerInfo?.payerName;
  return {
    transactionId: info.transactionId,
    at: info.transactionInitiationDate,
    localDate: localDate(new Date(info.transactionInitiationDate)),
    amount: { currency: info.transactionAmount.currencyCode, value: info.transactionAmount.value },
    eventCode: info.transactionEventCode ?? "",
    payerName: n?.alternateFullName || n?.fullName || [n?.givenName, n?.surname].filter(Boolean).join(" ") || null,
    payerEmail: t.payerInfo?.emailAddress ?? null,
    invoiceRef: t.cartInfo?.paypalInvoiceId ?? info.invoiceId ?? null,
  };
}

async function searchOnce(fromMs: number, toMs: number): Promise<ReceivedResult & { state: "ok" }> {
  const payments: ReceivedPayment[] = [];
  let skipped = 0;
  let truncated = false;
  let dataAsOf: string | null = null;
  let windows = 0;
  for (let start = fromMs; start < toMs; start += MAX_WINDOW_MS + 1000) {
    if (++windows > MAX_WINDOWS) { truncated = true; break; }
    const end = Math.min(toMs, start + MAX_WINDOW_MS);
    for (let page = 1; ; page++) {
      const r = await getClient().transactionSearch.searchTransactions({
        startDate: rfc3339(start), endDate: rfc3339(end), transactionStatus: "S", fields: FIELDS, page,
      });
      dataAsOf = r.lastRefreshedDatetime ?? dataAsOf;
      for (const t of r.transactionDetails ?? []) {
        const p = toReceived(t);
        if (p === "skip") skipped++;
        else if (p) payments.push(p);
      }
      if (page >= (r.totalPages ?? 0)) break;
      if (page >= MAX_PAGES) { truncated = true; break; }
    }
  }
  const seen = new Set<string>();
  const unique = payments.filter((p) => (seen.has(p.transactionId) ? false : (seen.add(p.transactionId), true)));
  unique.sort((a, b) => b.at.localeCompare(a.at));
  return { state: "ok", payments: unique, dataAsOf, truncated, skipped };
}

/** Completed PayPal payments received between two instants (end capped at now). Never throws for API failures. */
export async function listPaymentsReceived(from: Date, to: Date): Promise<ReceivedResult> {
  const nowMs = Date.now(); // real-clock: PayPal's reporting runs on real time, not KAIROS_NOW
  const toMs = Math.min(to.getTime(), nowMs - 1000);
  const fromMs = from.getTime();
  if (fromMs >= toMs) return { state: "ok", payments: [], dataAsOf: null, truncated: false, skipped: 0 };
  try {
    return await searchOnce(fromMs, toMs);
  } catch (err) {
    const f = classify(err);
    // A 403 can mean the scope was granted after the cached token was issued: retry once with a new client (fresh token).
    if (f.status === 403 && nowMs - rebuiltAt > REBUILD_AFTER_403_MS) {
      rebuiltAt = nowMs;
      client = null;
      try {
        return await searchOnce(fromMs, toMs);
      } catch (err2) {
        const f2 = classify(err2);
        return { state: f2.state, message: f2.message };
      }
    }
    return { state: f.state, message: f.message };
  }
}

/** Sum by currency, in cents (no float drift). */
export function totalByCurrency(payments: ReceivedPayment[]): { currency: string; value: string; count: number }[] {
  const m = new Map<string, { cents: number; count: number }>();
  for (const p of payments) {
    const [w, f = ""] = p.amount.value.split(".");
    const c = Number(w) * 100 + Number((f + "00").slice(0, 2));
    const t = m.get(p.amount.currency) ?? { cents: 0, count: 0 };
    t.cents += c; t.count++;
    m.set(p.amount.currency, t);
  }
  return [...m].map(([currency, t]) => ({ currency, value: `${Math.floor(t.cents / 100)}.${String(t.cents % 100).padStart(2, "0")}`, count: t.count }));
}
