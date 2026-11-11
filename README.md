# Kairos

Invoicing and collections for a small business on PayPal (sandbox). Built on the PayPal Invoicing API v2.

- **Invoices**: create, send, record payments, cancel (`/invoices`).
- **Collections agent**: finds overdue invoices, drafts reminders, and checks each draft with a second model plus code checks. Drafts wait on **Approvals** (`/approvals`) and nothing is sent until the owner approves. Invoices more than 60 days overdue go to a human.
- **Kairos chat**: a read-only assistant docked on every page. It answers questions about invoices, customers, the queue and sent reminders, and can request drafts, which still go to Approvals. On an empty conversation it opens with a briefing. Its numbers are computed in code from the same data as the home tiles; Haiku only phrases a template, cached per shape and regenerated at most once an hour. `get_report` gives aging, collected vs outstanding, top customers owing and reminder activity for a period.
- **Invoice from a photo or voice note**: on **New invoice**, snap a job note or dictate one (Chrome). Kairos fills in the form, and the owner checks it and clicks Create.
- **Pay in parts**: the owner sets a payment-plan policy on **Incentives** (`/settings/incentives`), and reminders for eligible invoices can offer to let the customer pay in parts through PayPal.
- **The Kairos Director**: deterministic collections pacing (`/director`). Per customer, a pressure score, the next move, a suggested day and the reason, plus a 14-day cash forecast.
- **Proactive insights**: the briefing shows up to three code-computed cards (stuck invoice → offer a payment plan, possible payment outside the invoice → hold the reminder, cash forecast, slow payers) with one-click actions that never send anything.
- **Embeddable**: the assistant is a self-contained React component another business dashboard can mount (`components/kairos/`, demo at `/embed-demo`).

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

Both endpoints require `Authorization: Bearer $KAIROS_CRON_SECRET` (32+ characters) and are called by Render Cron Jobs.

**Re-seeding today from scratch** (e.g. after a deploy changed the seed): `POST /api/cron/demo-reset?fresh=1`, or `npm run demo:reset -- --fresh`.
- It seeds a brand-new set for today under the next letter suffix (`TS-261111b-1041` …, still within PayPal's 25 characters), then cancels every other open demo invoice, including today's earlier set, and closes their proposals.
- Only the seeded demo numbers are ever matched, with or without a suffix.
- The scheduled nightly call is unchanged. If it runs again the same day, it adopts today's newest set instead of recreating the plain one.
- Up to 25 fresh re-seeds per day (suffixes b–z). To run the reset by hand: `npm run demo:reset -- --dry-run`, then `npm run demo:reset` (needs `KAIROS_SEED_EMAILS`: four distinct sandbox personal-account emails).

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

## The Kairos Director: collections pacing

*Getting paid is a timing problem.* The Director is inspired by the AI Director in Left 4 Dead, which reads how the players are doing and paces the game. It reads each customer's history and recent signals and decides, in code, what Kairos should propose for each overdue invoice and when (`lib/director/`). No model decides anything here, and the same inputs always give the same plan.

**Pressure (0–100) per open invoice**, built from named factors:
- **Money at stake:** the amount due and its share of everything you're owed.
- **How late:** days overdue.
- **Customer history:** average days late, and whether past reminders were followed by a payment within 7 days. Reminders on this invoice with no payment since add pressure.
- **Recent signals:** a part payment on the invoice, or a PayPal payment from the customer (Transaction Search) in the last 7 days, is relief. Pressure drops and the Director pauses.
- **Relationship:** lifetime paid and on-time ratio make it gentler.
- **Your cash need:** if the 14-day forecast falls short of the cash target you set on Incentives, the largest, most likely payers get more pressure.

**Output per invoice:**
- **The next move on the ladder:** wait (< 20), friendly (< 45), firm (< 60), then an offer to pay in parts if your incentive policy allows it and no plan was offered before. A final notice needs 80+ pressure and 21+ days overdue; otherwise the move is firm. Escalate is the existing 60-day rule.
- **A suggested day:** the customer's usual payment weekday, unless pressure is 60+. It is never inside the 7-day cooldown.
- **A one-line reason** naming the top factors.

**Hard rules always win:** the grace period, the cooldown, the 60-day escalation, the incentive policy and flagged invoice text. The Director only decides what to propose and when. A run drafts only the invoices whose move isn't "wait" and whose day is today, highest pressure first. Drafts still go drafter → critic + code checks → Approvals. The drafting tone comes from the Director's move instead of the age bucket, and a pay-in-parts offer is allowed only on an "offer payment plan" move. When you ask the chat to draft a specific invoice, the Director's "wait" doesn't hold your request back; the hard rules still apply. The Director's parameters, and your cash target, are part of the rules version.

**Where to see it:**
- the **Director** page (`/director`): each customer with a pressure meter, next move, day and reason, plus the 14-day cash forecast with a confidence note;
- the pressure and reason on every Approvals card;
- the chat's read-only `get_director_plan` tool ("who should I focus on this week, and why?").

The Director reads PayPal only through the agent's read-only door, plus Transaction Search and the send ledger. `scripts/check-boundaries.mjs` keeps `lib/director/` free of model calls and writes, and keeps `lib/director/model.ts` pure.

**Demo data:** the daily reset seeds payment histories so the Director makes different calls:
- **Daniel** pays on time, on Fridays, so his overdue invoice gets **wait**.
- **Maya** pays 40–50 days late and owes $2,350, so she gets **offer payment plan**.
- **Tom** part-paid two days ago, so he gets **pause**.
- **Priya** is new, so her small invoice gets a **friendly** reminder and her 75-day invoice is **escalated**.

If no incentive policy has ever been saved, the reset saves a demo default (pay in parts on, $1,500 cash target). A policy you've saved, even one that's off, is never changed.

## Proactive insights

When the Kairos panel opens, the briefing shows up to three **insight cards** under the summary (`lib/insights/`). Code computes them from data Kairos already has: invoices, the send ledger, PayPal Transaction Search and the Director's plan. They are ranked by money at stake, with at most one card per customer.

| Insight | What it finds | Action |
|---|---|---|
| **Large invoice stuck** | an overdue invoice where the Director's move is "offer payment plan" under your policy | **Offer payment plan**: drafts a reminder for that invoice through the normal pipeline (sweep rules → Director → drafter → critic + code checks) and puts it on Approvals. Nothing is sent. |
| **Possible payment outside the invoice** | a PayPal payment in the last 30 days from a customer, for exactly the amount due on one of their open invoices, and not linked to that invoice | **Hold reminder**: a Kairos-side hold. Nothing changes in PayPal. The invoice isn't drafted, and a waiting draft can't be approved, until you clear the hold on the Director page. |
| **Cash over the next 14 days** | expected inflow from open invoices, using each customer's usual lateness and likelihood of paying, against your cash target, with a confidence note | ask the chat |
| **Slow payer** | customers with 2+ paid invoices who pay 14+ days late on average and still owe money | ask the chat |

- **Wording:** code inserts every number and name. Haiku only phrases: it writes one template per card shape with placeholders and no digits, never sees a number or any customer text, and code fills the values in. Templates are cached and regenerated at most once an hour, and code's own wording is the fallback. The spend caps apply.
- **Chat:** the read-only `get_insights` tool answers "any risks?", "what's my cash looking like?" and "how does Maya usually pay?". The chat can't take the actions; only the owner clicks them.
- **Re-checked:** each action re-checks on the server that its insight still applies.
- **Boundaries:** `lib/insights/` only reads, and `compute.ts` is pure. Holds are created and cleared only in `lib/queue/insight-actions.ts`. Holds and their clears are append-only rows, and both are audited.

**In the demo:**
- **Large invoice stuck:** Maya's $2,350 invoice.
- **Slow payer:** Maya.
- **Cash forecast:** always shown.
- **Possible payment outside the invoice:** Daniel's open $250 invoice matches the real $250 PayPal payment made from his sandbox account. That payment ages out of the 30-day window. To recreate the insight, pay any invoice from one of the sandbox customer accounts, then reseed a matching amount.

## Pay in parts (owner-defined payment plans)

Getting paid sometimes means letting a customer pay part now. On **Incentives** (`/settings/incentives`) the owner turns this on and sets the limits: minimum amount due, minimum days overdue, maximum number of parts and minimum payment per part. This is PayPal's **partial payments** on the invoice: the customer chooses when to pay each part. It is not an auto-charged installment plan.

- **Code decides.** Eligibility is computed in code: the policy is on, the amount and days are within the limits, and the invoice text isn't flagged as suspicious, so the prompt-injection invoice never gets an offer. Code also computes the terms: minimum per part = the policy minimum, raised to `amount due ÷ max parts` when needed, so there are never more than the maximum number of parts. The drafter only chooses `payment_plan` or `none` and never writes a number. Code inserts one fixed sentence, e.g. *"You can pay this invoice in up to 3 parts of at least $783.34 each."*, just before the closing line.
- **Checked twice.** Check (b) is now "no concession outside the owner's policy". The note may contain exactly the code-rendered sentence, once, on an eligible invoice, with the policy's terms, or no offer at all. Any other wording about payment plans, parts or instalments, an offer on an ineligible invoice, different terms, and every discount, waiver or extension are blocked. The critic gets the policy and each invoice's one allowed sentence, and checks the same thing. The replay set has four cases for this: the 50% demand dressed up as an offer (blocked), an offer on an ineligible invoice (blocked), an over-limit offer (blocked) and a correct policy offer (must pass). They run with stubbed models in `npm test` and against the live critic with `npm run agent:replay`.
- **Versioned.** Every save is a new, append-only version, and each save is audited. The policy values are part of the rules version (`r-<code>.p-<policy>`), so changing the policy makes waiting drafts stale: they can't be approved or sent until the agent re-runs.
- **On approval**, the executor re-derives the terms from the live balance. It then turns on partial payments for the invoice with that minimum (one full-invoice update, `send_to_recipient=false`, one attempt), and only then sends the reminder.
  - If turning partial payments on definitely failed, nothing is sent and the draft stays approvable.
  - If the outcome is unknown, the existing rule applies: the token is not released and the item is blocked for a human.
  - A sandbox test confirmed that this update works on an invoice already SENT, keeps it SENT and doesn't re-send it (`last_sent_time` unchanged).
- The Approvals card shows **"Includes offer: pay in up to N parts of at least $X"**.

**Next step: early-payment discounts** (e.g. "2% off if paid within 5 days"). They aren't built. They would need their own policy limits, a time-boxed amount change on the invoice, and a way to restore the full amount when the window closes.

## Integrating Kairos into a business dashboard

The assistant panel (the briefing, insight cards, chat and draft requests) is a self-contained React component: `components/kairos/KairosAssistant.tsx`, with `InsightCards.tsx` and `kairos.css` beside it.
- **No framework dependencies:** it uses only React and `fetch`, so it can be mounted by a host business dashboard (a Next.js app, Vite, or any React page).
- **Scoped, neutral styles:** everything sits under `.kairos-root` with its own `--k-*` variables. It's neutral grey by default, dark mode follows the system, and nothing leaks into or out of the host. The Kairos app mounts the same component through a thin wrapper (`app/KairosPanel.tsx`) that maps it onto the app's colors.
- **Demo:** `/embed-demo` shows it inline inside a plain example host page.

```tsx
import KairosAssistant from "./kairos/KairosAssistant"; // copy components/kairos/ into the host

<KairosAssistant
  layout="inline"                    // or "docked": a sidebar, a slide-up drawer on phones
  apiBase=""                         // where the Kairos API is served (same origin; see Auth)
  context={{ invoiceId: "INV2-…", invoiceNumber: "TS-1046" }} // optional: what the user is looking at
  onNavigate={(path) => router.push(path)} // "/approvals", "/director"; default: full page load
  onDraftsCreated={() => refreshCounts()}  // optional: the host refreshes its own badges
  theme="light"                      // optional: force a theme
/>
```

To match the host's look, set `--kairos-accent` (or any `--k-*` variable) on a wrapper. For example, `.my-host { --kairos-accent: #334155; }`.

**Auth:**
- The component calls the Kairos API with the browser's Kairos session cookie: `HttpOnly`, `SameSite=Strict`, set by signing in at `/login`. Every POST must also come from the same origin (CSRF check).
- So Kairos must be served from the **same origin** as the host page, for example behind the host's reverse proxy, with `/api/*`, `/login`, `/approvals` and `/director` routed to Kairos.
- Cross-origin embedding (a host on another domain calling Kairos directly) is **not supported, by design**.
- *Next step:* scoped API tokens, so a host server can call Kairos on the owner's behalf without sharing the session.

**API endpoints the component calls** (all session-authenticated):

| Endpoint | Purpose |
|---|---|
| `GET /api/chat/briefing` | the opening briefing: summary text (code numbers), chips, up to 3 insight cards |
| `GET /api/chat?sessionId=…` | restore a conversation (the server owns the transcript) |
| `POST /api/chat/stream` `{message, sessionId, invoiceId}` | one chat turn, as server-sent events: `text`, `tool_start`, `tool_done`, `proposals`, `done`, `error` |
| `POST /api/insights/actions` `{type: "offer_plan" \| "hold", invoiceId}` | the one-click insight actions (draft for approval / Kairos-side hold) |

**Links:** the component links to two Kairos pages, the owner's decision points: `/approvals` (approve or reject drafts, the only way anything is sent) and `/director`. A host can open them in a new tab or route to them.

**Data Kairos needs:**
- A PayPal REST app with Invoicing (sandbox or live). Transaction Search is optional: it feeds "received", relief and the outside-payment insight.
- An Anthropic API key.
- A persistent disk for SQLite (the proposals, approvals, send ledger, holds, policy versions and audit log).
- Optionally the PayPal webhook.

The host passes no invoice data. Kairos reads it from PayPal itself, and the host only says which invoice the user is looking at.

**Unchanged inside a host:**
- The chat stays read-only, apart from requesting drafts.
- Customer text is treated as data.
- Spend caps apply.
- Nothing is sent until the owner approves it on Approvals.

## Reports (AG Studio)

`/reports` is a read-only analytics page built with [AG Studio](https://www.ag-grid.com/studio/) (AG Grid's embedded dashboard component, `ag-studio` + `ag-studio-react` 3.1.0).

**Two pages:**
- **Overview:** collected vs outstanding this month, the 14-day cash forecast against your cash target, reminder activity, aging of open invoices, top customers owing, Director pressure by customer, and the forecast per invoice.
- **Invoices:** a sortable, filterable grid (number, customer, status, due date, days overdue, amount due, Director pressure and next move) and a pivot of amount due grouped by customer and aging bucket.

**Same numbers as the chat:** `lib/reports/load.ts` builds the page from the code the chat and briefing already use:
- the chat's own `get_report` tool handler (this month);
- the Director plan, names and forecast through `loadInsights`;
- `invoice-stats` for the invoice rows.

One invoice list per page view, and no PayPal calls of its own. `lib/reports/build.ts` only reshapes those results into rows (pure, tested in `tests/reports.test.ts`).

**Custom widgets:** forecast vs target, Director pressure, collected vs outstanding and reminder activity are Kairos React widgets registered with AG Studio's `createWidgets`. They render Kairos's numbers from Studio's `context`. The aging, owing and forecast charts and the invoice grid are stock AG Studio widgets over Kairos's tables, running in AG Studio's in-browser data engine with cross-filtering.

**Customize:** switches Studio to edit mode, where you can move widgets or add new ones from Kairos's tables (the "Kairos" group sits at the top of the widget menu). Changes live in that browser tab only; Reset layout restores the default. Nothing on the page writes to Kairos or PayPal.

**Look:** Kairos's teal theme via `studioTheme.withParams`. Every value is a Kairos CSS variable, so light and dark follow the rest of the app. Below 720px wide, widgets stack one per row.

**Bundle:** AG Studio, with the AG Grid and AG Charts Enterprise it includes, builds to one chunk of about 6.5 MB (1.8 MB gzipped). It is loaded with a client-only dynamic import on `/reports` alone, after the page shell has rendered. A boundary rule keeps every other file from importing it, so no other page downloads it.

**Licence:** AG Studio is commercial. Without a key it runs with a watermark and console warnings. Set `AG_STUDIO_LICENSE_KEY` (a free 45-day trial key from AG Grid). The key is passed to the browser, as AG Studio requires, so treat it as public.

**Boundary rules:**
- `lib/reports/` and `app/reports/` import no PayPal client, queue, executor, payments or db module, make no HTTP calls and write nothing.
- `load.ts` may run only the `get_report` tool.
- `build.ts` is pure.

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

**Not built with the plugin:** every Invoicing API v2 call (`lib/paypal/`, hand-written, predating the plugin). That covers the invoices UI, the agent's reads, the executor's reminder send, the seed and cleanup scripts, and photo/voice intake's Create. The business-name field adds `billing_info.business_name` to that existing create request. The executor's "turn on partial payments" update for pay-in-parts offers is also hand-written Invoicing code (`PUT /v2/invoicing/invoices/{id}`), because the plugin's SDK has no Invoicing operations to build it from.

## Built vs. next

**Built:**
- invoicing on PayPal;
- the approval-gated collections agent (drafter, independent critic and code checks);
- the read-only chat with briefing, reports and insight cards;
- photo/voice intake;
- owner-defined pay-in-parts offers;
- the Kairos Director;
- proactive insights with holds;
- the embeddable assistant;
- read-only reports with AG Studio;
- the nightly demo reset, cron runs and webhook handling.

**Next:**
- **Early-payment discounts:** see Pay in parts.
- **Scoped API tokens for host dashboards:** see Integrating.
- **Director tuning from outcomes:** the weights are fixed parameters today. They are versioned, so they could be tuned against which reminders actually got paid.
- **Multi-currency cash forecasts:** the forecast sums one currency.
