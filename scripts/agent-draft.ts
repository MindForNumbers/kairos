// Stage 3 review: sweep + drafter, printed. Nothing is saved as a proposal and nothing is sent.
// Run: npm run agent:draft
import { createBudget } from "../lib/agent/budget";
import { draft } from "../lib/agent/drafter";
import { requiredFacts, wordCount } from "../lib/agent/policy";
import { sweep } from "../lib/agent/sweep";

async function main() {
  const s = await sweep();
  console.log(`Sweep ${s.asOf} (today ${s.today}): run set ${s.candidates.map((c) => c.invoiceNumber).join(", ")}; deferred ${s.deferred.map((c) => c.invoiceNumber).join(", ") || "none"}\n`);
  const b = await draft(s.candidates, { budget: createBudget(null) });
  const byId = new Map(s.candidates.map((c) => [c.invoiceId, c]));

  for (const d of b.drafts) {
    const rec = byId.get(d.invoiceId)!;
    const f = requiredFacts(rec);
    const has = (x: string) => (d.note.includes(x) ? "✓" : "✗");
    console.log(`━━ ${rec.invoiceNumber} (${d.invoiceId}) · ${rec.daysOverdue}d overdue · tone=${d.tone}${rec.flags.length ? ` · flags: ${rec.flags.join(",")}` : ""}`);
    console.log(`Subject: ${d.subject}`);
    console.log(`Note (${wordCount(d.note)} words):\n${d.note}`);
    console.log(`Exact facts in note: ${has(f.invoiceNumber)} ${f.invoiceNumber}  ${has(f.amountDue)} ${f.amountDue}  ${has(f.dueDate)} ${f.dueDate}\n`);
  }
  for (const e of b.escalations) {
    const rec = byId.get(e.invoiceId);
    console.log(`━━ ${rec?.invoiceNumber} (${e.invoiceId}) · ${rec?.daysOverdue}d overdue · ESCALATE (${e.source})\n${e.reason}\n`);
  }
  if (b.missing.length) console.log(`Missing (no usable draft): ${b.missing.join(", ")}`);
  if (b.dropped.length) console.log(`Dropped by code: ${JSON.stringify(b.dropped)}`);
  if (b.failure) console.log(`Drafter failure: ${b.failure}`);
  if (b.meta) console.log(`\n${b.meta.model} · ${b.meta.inputTokens} in / ${b.meta.outputTokens} out · $${b.meta.costUsd.toFixed(5)} · ${b.meta.durationMs} ms · ${b.meta.requestId}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
