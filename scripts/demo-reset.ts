// The daily demo reset, from a shell (the hosted app runs the same code from POST /api/cron/demo-reset):
// seed today's date-stamped set, then cancel older <prefix>- invoices and close their proposals.
//   npm run demo:reset -- --dry-run
//   npm run demo:reset
import { parseEmails, resetDemo } from "../lib/demo/reset";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const summary = await resetDemo({ emails: parseEmails(process.env.KAIROS_SEED_EMAILS ?? ""), actor: "script:demo-reset", dryRun, log: console.log });
  console.log(`\n${dryRun ? "DRY RUN: " : ""}${JSON.stringify(summary)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
