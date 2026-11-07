// Read-only sweep: prints this run's set, deferred and excluded invoices.
// Run: npm run agent:sweep   (KAIROS_NOW=2026-12-15T17:00:00Z npm run agent:sweep to time-travel)
import { sweep } from "../lib/agent/sweep";
import { isOverridden } from "../lib/clock";

async function main() {
  const r = await sweep();
  const row = (c: { invoiceNumber: string | null; invoiceId: string; daysOverdue: number; amountDue: string | null; currency?: string; flags?: string[] }) =>
    `  ${(c.invoiceNumber ?? "—").padEnd(14)} ${c.invoiceId.padEnd(26)} ${String(c.daysOverdue).padStart(4)}d  ${(c.amountDue ?? "—").padStart(10)} ${c.currency ?? ""} ${c.flags?.length ? `⚠ ${c.flags.join(",")}` : ""}`;

  console.log(`Sweep as of ${r.asOf}${isOverridden() ? " (KAIROS_NOW override)" : ""}, today=${r.today} ${r.timezone}`);
  console.log(`listed=${r.counts.listed} open=${r.counts.open} overdue=${r.counts.overdue}${r.truncated ? " (TRUNCATED)" : ""}\n`);
  console.log(`This run's set (${r.candidates.length}):`); r.candidates.forEach((c) => console.log(row(c)));
  console.log(`\nDeferred to next run (${r.deferred.length}):`); r.deferred.forEach((c) => console.log(row(c)));
  console.log(`\nExcluded (${r.excluded.length}):`); r.excluded.forEach((e) => console.log(`${row({ ...e, amountDue: null })}  ${e.reason}: ${e.detail}`));
  console.log(`\nOpen, not yet due (${r.openNotDue.length}):`); r.openNotDue.forEach((o) => console.log(`  ${(o.invoiceNumber ?? "—").padEnd(14)} due ${o.dueDate}  ${o.amountDue ?? "—"}`));
  if (process.argv.includes("--json")) console.log("\n" + JSON.stringify(r, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
