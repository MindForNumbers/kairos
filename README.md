# Kairos

Invoicing and collections for a small business on PayPal (sandbox). Built on the PayPal Invoicing API v2.

- **Invoices**: create, send, record payments, cancel (`/invoices`).
- **Collections agent**: finds overdue invoices, drafts reminders, and checks each draft with a second model plus code checks. Drafts wait on **Approvals** (`/approvals`) and nothing is sent until the owner approves. Invoices more than 60 days overdue go to a human.
- **Kairos chat**: a read-only assistant docked on every page. It answers questions about invoices, customers, the queue and sent reminders, and can request drafts, which still go to Approvals.
- **Invoice from a photo or voice note**: on **New invoice**, snap a job note or dictate one (Chrome). Kairos fills in the form, and the owner checks it and clicks Create.

## Run it

```bash
npm install
cp .env.example .env   # PayPal sandbox app, ANTHROPIC_API_KEY, KAIROS_ADMIN_PASSWORD
npm run dev            # http://localhost:3000
npm test               # unit tests, models stubbed
npm run check:boundaries
```

Demo data: `KAIROS_SEED_EMAILS=a@…,b@…,c@…,d@… npm run seed` (four sandbox personal accounts), then `npm run sandbox:cleanup -- --keep=TS --apply` and `npm run agent:run`.

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

The project was required to build any new PayPal API code with APIMatic's Context Plugin (`paypal@context-plugins`, v0.4.1, which provides the `paypal:typescript-*` skills). That plugin is installed and was checked. Its SDK is the PayPal Server SDK, which covers Orders, Payments, Subscriptions, Transaction Search and Vault, **not Invoicing**. Every PayPal call in Kairos is an Invoicing API v2 call, so **no part of Kairos was built with the plugin**. The Invoicing calls live in `lib/paypal/` (hand-written, predating the plugin), and the features added since the plugin was installed (multi-customer demo seed, chat `recent_sends`, photo/voice intake) reuse those existing calls and add no new PayPal endpoint code.
