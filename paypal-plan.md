# PayPal plan — read-only Transaction Search (APIMatic `paypal` SDK)

Scope: list **completed payments received** in a date range, read-only, for the Kairos chat
(`recent_payments` tool), `get_report` ("collected"), and the briefing ("$X received this week").
Everything else in Kairos stays on the hand-written Invoicing v2 client in `lib/paypal/`.

## Repo survey

| Convention | Pattern | Exemplar |
| --- | --- | --- |
| Read-only PayPal access behind one module, boundary-checked | a single module owns the reads; `scripts/check-boundaries.mjs` forbids other paths | `lib/agent/paypal-read.ts` + its rules in `scripts/check-boundaries.mjs` |
| Test seam swapped by a `set…ForTesting(null)` function | module-level dependency, reset in `afterEach` | `lib/agent/paypal-read.ts` (`setPaypalReadsForTesting`) |
| Business time from `lib/clock.ts`; real time marked `// real-clock` | boundary rule | `lib/executor/limits.ts` |
| Chat tools return `{ data, untrusted }`; customer text goes in `untrusted` | `lib/chat/tools.ts` handlers | `recent_sends` handler |
| Env → host mapping | `PAYPAL_ENVIRONMENT` sandbox (default) / live | `lib/paypal/client.ts` lines 5–18 |

- **Module format:** `package.json` has no `"type"`; `tsconfig` `module: esnext`, `moduleResolution: bundler`. Next.js bundles the server code (ESM); `npm test` runs through `tsx` (CJS). Each process loads **one** dialect, but to be dialect-safe the error boundary narrows on `err.kind` / `err.status` / `err.payload.kind`, never on `instanceof` across modules.
- **Runtime:** Node 22.18 (SDK floor `>=20.3` ✓). Server-only (`import "server-only"`).
- **tsconfig:** `strict: true`; `exactOptionalPropertyTypes` off; `verbatimModuleSyntax` off. Use `import type` for type-only names anyway.
- **Toolchain:** npm; `paypal` pinned to `git+https://github.com/context-plugins/paypal-typescript-sdk.git#5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2` (v2.29.0; lockfile `resolved` kept as `git+https` so installs need no SSH key, built by its `prepare` → `dist/`). Commands: `npm run typecheck`, `npm test`, `npm run check:boundaries`, `npm run build`.
- **Baseline (untouched tree, before this work):** typecheck clean, boundaries ok (11 rules), 103 tests pass.
- **Credentials:** `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` from `.env` (Render env tomorrow). Never logged.
- **Smoke (read-only, scratchpad, real sandbox credential, 2026-11-09 ~19:3x PST):** `searchTransactions` last 7 days → **200**, `totalItems 0`, `lastRefreshedDatetime 2026-11-10T03:29:59Z`. The scope is granted (a 403 would mean not enabled); there's no data yet (lag ≤ 3 h per api-reference).

## Host

- The SDK declares one environment, default `https://api-m.sandbox.paypal.com`; there's no `ServerEnvironment`.
- `PAYPAL_ENVIRONMENT` = `sandbox` (or unset) → no override. `live` / `production` → `serverOptions: { baseUrl: "https://api-m.paypal.com" }`. Any other value → throw at client build (fail fast). This mirrors `lib/paypal/client.ts`.

## Contract sheet

### `client.transactionSearch.searchTransactions`

- **Signature:** `searchTransactions(request: TransactionSearch.SearchTransactionsRequest, options?: RequestOptions): ApiPromise<SearchResponse, TransactionSearch.SearchTransactionsError>` (map: `map/operations/transaction-search.md`)
- **Wire:** `GET /v1/reporting/transactions` · **Auth:** `oauth2` · no request body.
- **Returns:** `SearchResponse` (`src/models/search-response.ts`), every member optional: `transactionDetails?: TransactionDetails[]`, `lastRefreshedDatetime?: string`, `page?`, `totalItems?`, `totalPages?`.
- **No pagination in the SDK** (sdk-map "Not on this SDK"). We loop `page` ourselves.
- **Range rule (api-reference):** `startDate` / `endDate` are RFC 3339 with seconds; the maximum range is **31 days** → split longer ranges into ≤31-day windows. Data lags **up to 3 hours**.

**Fields used** (flat, channel-blind; all `query`):

| Field | Wire | Type | Req | Default | Our value |
| --- | --- | --- | --- | --- | --- |
| `startDate` | `start_date` | string | yes | — | window start, RFC 3339 UTC with seconds |
| `endDate` | `end_date` | string | yes | — | window end, capped at real now |
| `transactionStatus` | `transaction_status` | string | no | — | `"S"` |
| `fields` | `fields` | string | no | `"transaction_info"` | `"transaction_info,payer_info,cart_info"` |
| `page` | `page` | number | no | `1` | 1, 2, … while `page < totalPages` (cap 10) |
| `balanceAffectingRecordsOnly` | `balance_affecting_records_only` | string | no | `"Y"` | omitted → `"Y"` sent by default |
| `pageSize` | `page_size` | number | no | `100` | omitted → `100` sent by default |

**OPTIONAL FIELDS**

| Field | What requires it | Set it? |
| --- | --- | --- |
| `transactionStatus` | task: "completed payments" (api-reference: `S` = completed) | ✅ `"S"` |
| `fields` | task: customer name for "what came in", and matching to invoices (`payer_info`, `cart_info`) | ✅ |
| `page` | the pagination row above (SDK has none) | ✅ |
| `transactionId`, `transactionType`, `transactionAmount`, `transactionCurrency`, `paymentInstrumentType`, `storeId`, `terminalId` | nothing | ❌ leave out |
| `balanceAffectingRecordsOnly`, `pageSize` | nothing (their defaults `"Y"` / `100` are sent anyway and suit us) | ❌ leave out |

**Response members we depend on** (all optional, so missing = `undefined`, not an error):
- `TransactionDetails.transactionInfo` (`src/models/transaction-information.ts`): `transactionId`, `transactionEventCode`, `transactionInitiationDate`, `transactionAmount: Money { currencyCode; value }`, `transactionStatus`, `invoiceId`.
- `payerInfo.payerName` (`PayerName`: `givenName`, `surname`, `fullName`, `alternateFullName`) and `payerInfo.emailAddress`.
- `cartInfo.paypalInvoiceId` (`src/models/cart-information.ts`).

A row with no `transactionInfo`, `transactionAmount` or `transactionId` is **skipped and counted** (`skipped`), never guessed.

**"Payment received" rule (ours):** `transactionStatus === "S"` and amount > 0 and event code `T00…` (PayPal payment events).
- **ASSUMPTION A1:** the `T00` family covers invoice payments. This comes from PayPal's public event-code docs, which the map links but doesn't carry. Verify against the TS-1043 payment once it appears. Other positive codes (e.g. `T03` bank deposits) aren't customer payments.

**Error arms** (`TransactionSearch.SearchTransactionsError`, narrow on `err.payload.kind`):
- `"searchError"` [`default` — any status no other arm covers] → `SearchError { name; message; debugId; … }` (`src/models/search-error.ts`)
- `"undeclared"` [a `default`-matched body that didn't fit `SearchError`] → `rawBody: ArrayBuffer`

**Error model:** throw-based. The family is `PaypalError` (`kind`: api / decode / encode / connection / timeout / auth). `AuthError` = the token couldn't be obtained (its `cause` is the token endpoint's `ApiError`). The SDK doesn't log response bodies. Logging is off; we set `logging: { level: "off" }` explicitly so `PAYPAL_CLIENT_LOG` can't turn it on.

### 1b.1 DURABLE WRITES — `none` (read-only scope).
### 1b.2 CROSS-OPERATION INVARIANTS — `none` (no caller-supplied values; date windows computed in code).

### 1b.4 WHEN THE API SAYS NO

The callers are the chat tool, the report and the briefing (not HTTP routes), so every outcome becomes a `state` with a fixed `message`, and the reason is logged.

| status / failure | state | the caller reads | test |
| --- | --- | --- | --- |
| 403 (`searchError` name `NOT_AUTHORIZED` or any 403) | `not_enabled` | "Transaction Search isn't enabled for this PayPal app" — after one retry with a **new client** (fresh token, in case the scope was granted after the cached token was issued) | fake 403 twice → `not_enabled`, 2 requests, second on a new token |
| 401 | `unavailable` | fixed: "PayPal rejected Kairos's credentials" | fake 401 → `unavailable` |
| 400 / other 4xx | `unavailable` | fixed message; the API's `name: message` logged (it's our request bug, not the user's input) | fake 400 with reason → reason in the log, `unavailable` |
| 429 / 5xx (after SDK retries) | `unavailable` | fixed: "PayPal's reporting is busy" | — |
| `auth` (token not obtained) | `unavailable` | fixed credentials message; `cause` logged | — |
| `connection` / `timeout` / `decode` on a read | `unavailable` | fixed message | fake a connection failure → `unavailable` |
| 200 with 0 rows | `ok` with `payments: []` plus `dataAsOf` (`lastRefreshedDatetime`) | "No completed PayPal payments in this period (PayPal's data is current to X; new payments can take up to 3 hours to appear)" | fake empty → note present |

Outside the family (abort reason, `ConfigurationError`, `TypeError`) → rethrown.

### Client, retry, logging
- One client per process (module-level, lazily built), rebuilt only for the 403 fresh-token retry (at most once per 10 min).
- Retry: SDK defaults retry GETs on 408/429/5xx/connection/timeout. We set `retry: { maxRetries: 2, timeout: 20_000 }` because a chat turn shouldn't hang 4 × 60 s. Reads only, so retrying is safe.
- Logging: `{ level: "off" }` (payer emails and names are in responses).
- `fetch`: default global; tests inject `ClientOptions.fetch` (the seam).

### Boundaries (new rules)
1. Only `lib/payments/` imports the `paypal` SDK package.
2. `lib/payments/` uses only `transactionSearch` (no `.orders` / `.payments` / `.vault` / `.subscriptions`), makes no `fetch(` calls, writes nothing to the store, and imports no `lib/paypal/`, queue or executor.

## Assumptions & Blockers
- A1 (minor, above): `T00` = payment received. Verify live.
- A2 (minor): `cartInfo.paypalInvoiceId` or `transactionInfo.invoiceId` identifies the Kairos invoice; match on either the INV2 id or the invoice number. Verify on TS-1043.
- No blockers. The scope is granted (smoke 200).
- **Status 2026-11-09 21:1x PST:** A1 and A2 are still unverified live. TS-1043 is still `SENT` with no payment, and Transaction Search returns 0 rows (data current to 19:29:59 PST). When the payment lands, check its `transaction_event_code` and which field carries the invoice reference. Until then, a payment outside the `T00` family isn't counted, and one whose reference doesn't match an invoice is listed without an invoice number. Both fail safe (under-reported, never misattributed).

## REQUIRED READING
- Error boundary, family narrowing, rethrow outside the family → MUST load `typescript-error-handling` (loaded).
- Building the long-lived client, `ConfigurationError` from the constructor → MUST load `typescript-client-initialization`.
- First call, flat request object, `ApiPromise` modes → MUST load `typescript-calling-endpoints`.
- Retry / timeout / logging settings above → MUST load `typescript-configuration-resilience`.
- Faking `ClientOptions.fetch`, wire-shape stubs, asserting the built request → MUST load `typescript-testing`.
