# Kairos

Invoicing and collections for a small business on PayPal (sandbox). Built on the PayPal Invoicing API v2.

- **Invoices**: create, send, record payments, cancel (`/invoices`).
- **Collections agent**: finds overdue invoices, drafts reminders, and checks each draft with a second model plus code checks. Drafts wait on **Approvals** (`/approvals`) and nothing is sent until the owner approves. Invoices more than 60 days overdue go to a human.
- **Kairos chat**: a read-only assistant docked on every page. It answers questions about invoices, customers, the queue and sent reminders, and can request drafts, which still go to Approvals. On an empty conversation it opens with a briefing. Its numbers are computed in code from the same data as the home tiles; Haiku only phrases a template, cached per shape and regenerated at most once an hour. `get_report` gives aging, collected vs outstanding, top customers owing and reminder activity for a period.
- **Invoice from a photo or voice note**: on **New invoice**, snap a job note or dictate one (Chrome). Kairos fills in the form, and the owner checks it and clicks Create.

## Run it

```bash
npm install
cp .env.example .env   # PayPal sandbox app, ANTHROPIC_API_KEY, KAIROS_ADMIN_PASSWORD
npm run dev            # http://localhost:3000
npm test               # unit tests, models stubbed
npm run check:boundaries
```

## Demo data resets daily

The hosted demo runs on a PayPal **sandbox**, and its data resets every day:

- **14:30 UTC: demo reset** (`POST /api/cron/demo-reset`). Seeds a fresh set of 8 invoices for 4 customers, numbered `TS-<YYMMDD>-1041` … `-1048`: 2 paid, 3 slightly overdue, one over $2,000, one over 60 days, and one whose note tries a prompt injection. Some are issued and paid within the current month so "this month" reports have data. Then it cancels the previous day's open demo invoices and closes their proposals. Only those 8 numbers are ever touched: an invoice you create on New Invoice (PayPal numbers it after the demo ones, e.g. `TS-<YYMMDD>-1049`) is left alone. Paid demo invoices can't be cancelled and stay as history.
- **15:00 UTC: agent run** (`POST /api/cron/agent-run`). Drafts reminders for the new set. Nothing is sent until someone approves it on Approvals.

Both endpoints require `Authorization: Bearer $KAIROS_CRON_SECRET` (32+ characters) and are called by Render Cron Jobs. To run the reset by hand: `npm run demo:reset -- --dry-run`, then `npm run demo:reset` (needs `KAIROS_SEED_EMAILS`: four distinct sandbox personal-account emails).

The PayPal webhook (`/api/webhooks/paypal`, signature-verified) skips repeat deliveries of the same event id. On PAID, CANCELLED or REFUNDED it closes that invoice's open proposals, and on PAID it records days-to-payment in the audit log.

## Invoice from a photo

`lib/intake/` turns a photo or a voice transcript into New Invoice form values:

1. **Extract**: Claude Sonnet 5.5 reads the input and copies values as written.
2. **Code checks**: normalize amounts and quantities, check line math against the total shown, validate the email, terms and currency. Text that reads like instructions is flagged and never prefilled.
3. **Review**: Claude Haiku 5.5 compares the extraction with the same input and reports misreads.

The form shows every finding next to its field. If any errors remain, the owner must tick "I've checked the flagged fields" before Save/Create.

**Safety rules:**
- `lib/intake/` can't reach PayPal, the queue or the executor, and can't write files; `scripts/check-boundaries.mjs` enforces this.
- Photos are untrusted input and are not stored. The browser re-encodes them (max 2000 px, which drops EXIF/GPS), the server holds the bytes in memory for the two model calls, and the audit log keeps only a sha256, size and outcome.
- Each intake has a cost cap, `KAIROS_INTAKE_COST_CAP` (default $0.15; a typical photo costs about $0.017). The shared daily cap also applies.

## PayPal API code and the APIMatic plugin

New PayPal API code in Kairos is built with APIMatic's Context Plugin (`paypal@context-plugins` v0.4.1, the `paypal:typescript-*` skills) and its generated SDK, the `paypal` package (PayPal Server SDK v2.29.0, pinned to commit `5d0df8a` over public https: `git+https://github.com/context-plugins/paypal-typescript-sdk.git#5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`). `npm ci` clones it without credentials and builds it with the SDK's `prepare` script, because the repo has no prebuilt `dist/`. npm rewrites a GitHub `resolved` URL to `git+ssh` on `npm install`, so after any `npm install`, check that `package-lock.json` still says `git+https`. That SDK covers Orders, Payments, Subscriptions, Transaction Search and Vault, **not Invoicing**.

**What the plugin built: read-only Transaction Search, and nothing else.**
- `paypal-plan.md`: the plugin's required plan and contract sheet. It covers the operation's signature, fields and defaults, error arms, host binding, retry and logging choices, and the "when the API says no" table, all taken from the SDK map that ships in the package.
- `lib/payments/received.ts`: the SDK client (one per process, sandbox or live from `PAYPAL_ENVIRONMENT`, logging forced off, `retry: { maxRetries: 2, timeout: 20000 }`) and the one SDK call, `client.transactionSearch.searchTransactions`. It handles pagination, splitting ranges into windows of 31 days or less, the "payment received" filter, error classification (403 → "not enabled", retried once with a fresh token; everything else → "unavailable" with a fixed message and the API's reason logged) and "no data yet" (an empty list plus PayPal's `last_refreshed_datetime`).
- `tests/payments.test.ts`: tests through the SDK's `fetch` seam, with wire bodies built by the SDK's own `searchResponseSchema`.
- Two rules in `scripts/check-boundaries.mjs`: only `lib/payments/` may import the SDK, and it may call only `transactionSearch.searchTransactions`, with no HTTP of its own and no access to `lib/paypal`, the queue, the executor or the database.

**What uses it, but wasn't built by the plugin:**
- the chat's `recent_payments` tool;
- `get_report`'s "collected" figure (PayPal-received payments plus payments recorded by hand on invoices, which Transaction Search never lists; it falls back to invoice records when Transaction Search is unavailable);
- the briefing's "received through PayPal this week" figure, cached for 10 minutes.

**Not built with the plugin:** every Invoicing API v2 call (`lib/paypal/`, hand-written, predating the plugin). That covers the invoices UI, the agent's reads, the executor's reminder send, the seed and cleanup scripts, and photo/voice intake's Create. The business-name field adds `billing_info.business_name` to that existing create request.
