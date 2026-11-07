// Live replay: send the frozen replay cases (tests/fixtures/replay.json) to the REAL critic,
// one fresh call per case. Bad cases must be caught the same way; known-good cases must pass
// (guards against the critic drifting stricter).
//   npm run agent:replay
// Uses the normal DB (KAIROS_DB_PATH): only audit and model_calls rows are written, so the
// spend counts toward KAIROS_DAILY_COST_CAP. npm test covers the same cases with stubbed models.
import { readFileSync } from "node:fs";
import { createBudget } from "../lib/agent/budget";
import { checkCoverage, checkDraft, decide, type Issue, type KnownInvoice } from "../lib/agent/checks";
import { critique } from "../lib/agent/critic";
import { planFor, type DraftPlan } from "../lib/agent/policy";
import type { SweepResult } from "../lib/agent/sweep";
import { setClockForTesting } from "../lib/clock";
import type { Draft } from "../lib/agent/drafter";

type Case = { id: string; invoiceNumber: string; origin: string; draft: Draft | null; expect: { decision: string; criticFails: string[]; codeFails: string[] } };

async function main() {
  const fx = JSON.parse(readFileSync("tests/fixtures/replay.json", "utf8")) as { sweep: SweepResult; cases: Case[] };
  setClockForTesting(fx.sweep.asOf); // overdue math as of the original run
  const s = fx.sweep;
  const plans = s.candidates.map(planFor);
  const known: KnownInvoice[] = s.candidates.map((r) => ({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, amountDue: r.amountDue, currency: r.currency, recipientEmail: r.recipientEmail, recipientName: r.untrusted.recipientName }));
  const budget = createBudget(null);
  const checks = (is: Issue[]) => [...new Set(is.map((i) => i.check))].sort();
  let failures = 0;

  for (const c of fx.cases) {
    const rec = s.candidates.find((r) => r.invoiceNumber === c.invoiceNumber)!;
    const others = plans.filter((p) => p.invoiceId !== rec.invoiceId).map((p) => p.invoiceId);
    const res = await critique({ records: s.candidates, plans, deferred: [], underReview: c.draft ? [c.draft] : [], alreadyCovered: others }, 0, budget);

    let liveFails: string[];
    let code: Issue[];
    let decision: string;
    if (res.failure) {
      liveFails = []; code = []; decision = `critic failed (${res.failure})`;
    } else if (!c.draft) {
      liveFails = res.omittedIds.includes(rec.invoiceId) ? ["e"] : [];
      code = checkCoverage(plans, new Set(others)).map((x) => x.issue);
      decision = liveFails.length || code.length ? "revise" : "passed";
    } else {
      const verdict = res.verdicts.get(rec.invoiceId) ?? "no verdict";
      liveFails = Array.isArray(verdict) ? checks(verdict) : [];
      code = checkDraft(c.draft, plans.find((p) => p.invoiceId === rec.invoiceId) as Extract<DraftPlan, { action: "draft" }>, known);
      decision = decide(code, verdict).decision;
    }
    const criticOk = c.expect.criticFails.every((k) => liveFails.includes(k));
    const decisionOk = decision === c.expect.decision;
    if (!criticOk || !decisionOk) failures++;
    console.log(`${criticOk && decisionOk ? "✓" : "✗"} ${c.id.padEnd(24)} expect critic ⊇ [${c.expect.criticFails}] → live [${liveFails}]   code [${checks(code)}]   decision ${decision}${decisionOk ? "" : ` (expected ${c.expect.decision})`}   $${res.meta.costUsd.toFixed(4)}`);
    if (!criticOk && res.verdicts.get(rec.invoiceId)) console.log(`    critic said: ${JSON.stringify(res.verdicts.get(rec.invoiceId))}`);
  }
  console.log(`\n${fx.cases.length - failures}/${fx.cases.length} matched (bad cases caught, good cases passed) · critic ${process.env.KAIROS_CRITIC_MODEL || "claude-sonnet-5-5"} · total $${budget.spentUsd().toFixed(4)}`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
