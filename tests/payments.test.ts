import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchResponseSchema, type SearchResponse, type TransactionDetails } from "paypal";
import { listPaymentsReceived, setTransactionSearchFetchForTesting, toReceived, totalByCurrency } from "../lib/payments/received";
import { isolate, reset } from "./helpers";

type Call = { url: URL; request: Request };

/** Fake fetch (the SDK's one seam). Routes the OAuth token request; everything else to `search`. */
function stubFetch(search: (url: URL, n: number) => Response) {
  const calls: Call[] = [];
  let n = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ url, request });
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: `T${calls.length}`, token_type: "Bearer", expires_in: 3600 });
    return search(url, n++);
  };
  return { fetch, calls, searches: () => calls.filter((c) => c.url.pathname === "/v1/reporting/transactions"), tokens: () => calls.filter((c) => c.url.pathname === "/v1/oauth2/token") };
}

const row = (over: { id?: string; code?: string; status?: string; value?: string; at?: string; invoice?: string } = {}): TransactionDetails => ({
  transactionInfo: {
    transactionId: over.id ?? "9AB12345CD6789012", transactionEventCode: over.code ?? "T0007", transactionStatus: over.status ?? "S",
    transactionInitiationDate: over.at ?? "2026-11-09T22:15:00Z", transactionAmount: { currencyCode: "USD", value: over.value ?? "250.00" },
  },
  payerInfo: { emailAddress: "daniel@example.com", payerName: { givenName: "Daniel", surname: "Reyes" } },
  cartInfo: { paypalInvoiceId: over.invoice ?? "INV2-RJ3P-9XE5-SEJJ-DGFW" },
});

/** Wire-shape body, encoded by the SDK's own schema (so a model rename breaks the fixture, not the test). */
const page = (rows: TransactionDetails[], extra: Partial<SearchResponse> = {}) =>
  Response.json(searchResponseSchema.encode({ transactionDetails: rows, page: 1, totalPages: rows.length ? 1 : 0, totalItems: rows.length, lastRefreshedDatetime: "2026-11-10T03:29:59Z", ...extra }));

const searchError = (status: number, name: string) =>
  Response.json({ name, message: "denied", debug_id: "abc123" }, { status });

beforeEach(() => {
  isolate("2026-11-09T20:00:00Z");
  process.env.PAYPAL_CLIENT_ID = "id";
  process.env.PAYPAL_CLIENT_SECRET = "secret";
  delete process.env.PAYPAL_ENVIRONMENT;
});
afterEach(() => { reset(); setTransactionSearchFetchForTesting(null); });

const WEEK = [new Date("2026-11-09T08:00:00Z"), new Date("2026-11-10T08:00:00Z")] as const;

test("sends only the query fields the plan allows, to the sandbox host, with a bearer token", async () => {
  const stub = stubFetch(() => page([row()]));
  setTransactionSearchFetchForTesting(stub.fetch);
  const r = await listPaymentsReceived(new Date("2026-11-03T08:00:00Z"), new Date("2026-11-04T08:00:00Z"));
  assert.equal(r.state, "ok");
  const [s] = stub.searches();
  assert.equal(s.url.origin, "https://api-m.sandbox.paypal.com");
  assert.equal(s.request.method, "GET");
  assert.deepEqual([...s.url.searchParams.keys()].sort(), [
    "balance_affecting_records_only", "end_date", "fields", "page", "page_size", "start_date", "transaction_status", // the last two defaults are the SDK's own
  ].sort());
  assert.equal(s.url.searchParams.get("start_date"), "2026-11-03T08:00:00Z");
  assert.equal(s.url.searchParams.get("end_date"), "2026-11-04T08:00:00Z");
  assert.equal(s.url.searchParams.get("transaction_status"), "S");
  assert.equal(s.url.searchParams.get("fields"), "transaction_info,payer_info,cart_info");
  assert.equal(s.url.searchParams.get("page"), "1");
  assert.match(s.request.headers.get("authorization") ?? "", /^Bearer T/);
});

test("keeps only completed incoming T00 payments; skips rows missing what we need", async () => {
  const stub = stubFetch(() => page([
    row({ id: "A", value: "250.00" }),
    row({ id: "B", value: "-30.00" }),             // money out
    row({ id: "C", code: "T0300", value: "500" }), // bank deposit, not a customer payment
    row({ id: "D", status: "P" }),                 // pending
    { transactionInfo: { transactionId: "E" } },   // no amount/date
  ]));
  setTransactionSearchFetchForTesting(stub.fetch);
  const r = await listPaymentsReceived(...WEEK);
  assert.ok(r.state === "ok");
  assert.deepEqual(r.payments.map((p) => p.transactionId), ["A"]);
  assert.equal(r.skipped, 1);
  assert.equal(r.payments[0].invoiceRef, "INV2-RJ3P-9XE5-SEJJ-DGFW");
  assert.equal(r.payments[0].payerName, "Daniel Reyes");
  assert.equal(r.payments[0].localDate, "2026-11-09");
  assert.equal(r.dataAsOf, "2026-11-10T03:29:59Z");
  assert.deepEqual(totalByCurrency(r.payments), [{ currency: "USD", value: "250.00", count: 1 }]);
});

test("pages until totalPages; ranges over 31 days are split into windows", async () => {
  const stub = stubFetch((url) => url.searchParams.get("page") === "1"
    ? page([row({ id: "P1" })], { totalPages: 2 })
    : page([row({ id: "P2" })], { page: 2, totalPages: 2 }));
  setTransactionSearchFetchForTesting(stub.fetch);
  const r = await listPaymentsReceived(new Date("2026-11-01T07:00:00Z"), new Date("2026-11-09T08:00:00Z"));
  assert.ok(r.state === "ok");
  assert.deepEqual(r.payments.map((p) => p.transactionId).sort(), ["P1", "P2"]);
  assert.equal(stub.searches().length, 2);

  const stub2 = stubFetch(() => page([]));
  setTransactionSearchFetchForTesting(stub2.fetch);
  await listPaymentsReceived(new Date("2026-01-01T08:00:00Z"), new Date("2026-03-15T08:00:00Z"));
  const windows = stub2.searches().map((c) => [c.url.searchParams.get("start_date")!, c.url.searchParams.get("end_date")!]);
  assert.equal(windows.length, 3);
  for (const [s, e] of windows) assert.ok(Date.parse(e) - Date.parse(s) <= 31 * 86_400_000, `${s}..${e}`);
});

test("403 (scope not granted): retries once with a fresh token, then reports not_enabled", async () => {
  const stub = stubFetch(() => searchError(403, "NOT_AUTHORIZED"));
  setTransactionSearchFetchForTesting(stub.fetch);
  const r = await listPaymentsReceived(...WEEK);
  assert.equal(r.state, "not_enabled");
  assert.equal(stub.searches().length, 2);
  assert.equal(stub.tokens().length, 2, "the retry used a new client, so a new token");
  assert.notEqual(stub.searches()[0].request.headers.get("authorization"), stub.searches()[1].request.headers.get("authorization"));
});

test("a 403 that clears after a fresh token returns the data", async () => {
  const stub = stubFetch((_u, n) => (n === 0 ? searchError(403, "NOT_AUTHORIZED") : page([row()])));
  setTransactionSearchFetchForTesting(stub.fetch);
  const r = await listPaymentsReceived(...WEEK);
  assert.equal(r.state, "ok");
});

test("401 and 400 are 'unavailable' with a fixed message; the API's reason goes to the log", async () => {
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    setTransactionSearchFetchForTesting(stubFetch(() => searchError(401, "AUTHENTICATION_FAILURE")).fetch);
    const r1 = await listPaymentsReceived(...WEEK);
    assert.deepEqual(r1, { state: "unavailable", message: "PayPal rejected Kairos's credentials." });

    setTransactionSearchFetchForTesting(stubFetch(() => searchError(400, "INVALID_REQUEST")).fetch);
    const r2 = await listPaymentsReceived(...WEEK);
    assert.equal(r2.state, "unavailable");
    assert.ok(logged.some((l) => /HTTP 400: INVALID_REQUEST: denied \(debug_id abc123\)/.test(l)));
  } finally {
    console.warn = warn;
  }
});

test("no data yet: ok with an empty list and PayPal's refresh time; missing credentials: unavailable, no request", async () => {
  const stub = stubFetch(() => page([]));
  setTransactionSearchFetchForTesting(stub.fetch);
  const r = await listPaymentsReceived(...WEEK);
  assert.ok(r.state === "ok");
  assert.equal(r.payments.length, 0);
  assert.equal(r.dataAsOf, "2026-11-10T03:29:59Z");

  delete process.env.PAYPAL_CLIENT_SECRET;
  const stub2 = stubFetch(() => page([]));
  setTransactionSearchFetchForTesting(stub2.fetch);
  const r2 = await listPaymentsReceived(...WEEK);
  assert.equal(r2.state, "unavailable");
  assert.equal(stub2.calls.length, 0);
});

test("toReceived: alternate full name wins; a row without status S is not a payment", () => {
  const p = toReceived({ ...row(), payerInfo: { payerName: { alternateFullName: "Reyes Landscaping", givenName: "Daniel" } } });
  assert.ok(p && p !== "skip" && p.payerName === "Reyes Landscaping");
  assert.equal(toReceived(row({ status: "V" })), null);
});
