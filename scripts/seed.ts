// Seed today's demo set: 8 sandbox invoices across 4 customers (lib/demo/reset.ts).
//   KAIROS_SEED_EMAILS=a@x.com,b@x.com,c@x.com,d@x.com npm run seed
//   npm run seed -- --emails=a@x.com,b@x.com,c@x.com,d@x.com [--dry-run]
// Numbers are <prefix>-<YYMMDD>-<n> (prefix KAIROS_SEED_PREFIX, default TS). Re-running the
// same day skips numbers that already exist. To also retire older sets: npm run demo:reset.
import { parseEmails, seedDemo } from "../lib/demo/reset";

async function main() {
  const raw = process.argv.find((a) => a.startsWith("--emails="))?.slice(9) ?? process.env.KAIROS_SEED_EMAILS ?? "";
  const dryRun = process.argv.includes("--dry-run");
  const r = await seedDemo({ emails: parseEmails(raw), dryRun, log: console.log });
  console.log(`\n${dryRun ? "DRY RUN: " : ""}created ${r.created.length}, already existed ${r.existing.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
