// Replay set: the fault-injection run of 2026-11-06, frozen. Deterministic (stubbed models).
// The same cases run against the LIVE critic with `npm run agent:replay`.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { checkCoverage, checkDraft, decide, type Issue, type KnownInvoice } from "../lib/agent/checks";
import { runAgent } from "../lib/agent/pipeline";
import { planFor, type DraftPlan } from "../lib/agent/policy";
import { bodyOf, cleanDrafts, isolate, loadReplay, recordOf, reset, stubModels, tagJson } from "./helpers";

const fx = loadReplay();
const plans = fx.sweep.candidates.map(planFor);
const known: KnownInvoice[] = fx.sweep.candidates.map((r) => ({
  invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, amountDue: r.amountDue, currency: r.currency,
  recipientEmail: r.recipientEmail, recipientName: r.untrusted.recipientName,
}));
const checksOf = (issues: Issue[]) => [...new Set(issues.map((i) => i.check))].sort();

after(reset);

for (const c of fx.cases) {
  test(`replay ${c.id} (${c.origin}): ${c.expect.decision === "passed" ? "must pass (false-positive guard)" : "caught the same way"}`, () => {
    const rec = recordOf(fx.sweep, c.invoiceNumber);
    if (!c.draft) {
      // (e) omission: everything else is covered, this invoice isn't.
      const covered = new Set(plans.filter((p) => p.invoiceId !== rec.invoiceId).map((p) => p.invoiceId));
      assert.deepEqual(checkCoverage(plans, covered).map((x) => x.invoiceId), [rec.invoiceId]);
      assert.deepEqual(c.expect.codeFails, ["e"]);
      assert.deepEqual(checksOf(c.recordedCritic!), c.expect.criticFails);
      return;
    }
    const plan = plans.find((p) => p.invoiceId === rec.invoiceId) as Extract<DraftPlan, { action: "draft" }>;
    const code = checkDraft(c.draft, plan, known);
    assert.deepEqual(checksOf(code), c.expect.codeFails, `code checks: ${code.map((i) => i.problem).join("; ")}`);
    for (const k of c.expect.criticFails) assert.ok(checksOf(c.recordedCritic!).includes(k as never), `recorded critic flagged ${k}`);
    assert.equal(decide(code, c.recordedCritic!).decision, c.expect.decision);
    // The code checks alone must also reach the same decision (defence in depth): no case relies on one layer.
    assert.equal(decide(code, []).decision, c.expect.decision, "code checks alone");
  });
}

test("replay through the full pipeline (stubbed models) reproduces the run's outcomes", async () => {
  const store = isolate(fx.sweep.asOf);
  const caseBy = (id: string) => fx.cases.find((c) => c.id === id)!;
  const id = (n: string) => recordOf(fx.sweep, n).invoiceId;
  const verdict = (issues: Issue[] | null) => {
    const v = (k: string) => {
      const hit = (issues ?? []).find((i) => i.check === k);
      return hit ? { pass: false, problem: hit.problem } : { pass: true, problem: null };
    };
    return { a_facts_match: v("a"), b_no_concessions: v("b"), c_no_other_customer_data: v("c"), d_traces_to_one_overdue_invoice: v("d") };
  };

  const { counts } = stubModels({
    drafter: (req, n) => ({ json: n === 0
      ? cleanDrafts(req.user, {
          "DEMO-08": bodyOf(caseBy("R1-injection-obeyed").draft!.note),
          "DEMO-05": bodyOf(caseBy("R2-subtle-arrangement").draft!.note),
          "DEMO-06": bodyOf(caseBy("R3-wrong-amount").draft!.note),
          "DEMO-04": null, // omitted
        })
      : cleanDrafts(req.user, { "DEMO-04": bodyOf(caseBy("R5-when-convenient").draft!.note) }) }),
    critic: (req, n) => {
      const ids = tagJson<{ invoiceId: string }[]>(req.user, "drafts_under_review").map((d) => d.invoiceId);
      const recorded: Record<string, ReturnType<typeof verdict>> = n === 0
        ? { [id("DEMO-08")]: verdict(caseBy("R1-injection-obeyed").recordedCritic), [id("DEMO-05")]: verdict(caseBy("R2-subtle-arrangement").recordedCritic), [id("DEMO-06")]: verdict(caseBy("R3-wrong-amount").recordedCritic) }
        : { [id("DEMO-06")]: verdict([]), [id("DEMO-04")]: verdict(caseBy("R5-when-convenient").recordedCritic) };
      return { json: {
        reviews: ids.map((i) => ({ invoiceId: i, ...recorded[i] })),
        e_omitted: n === 0 ? [{ invoiceId: id("DEMO-04"), problem: caseBy("R4-omitted").recordedCritic![0].problem }] : [],
        urgency_warnings: [],
      } };
    },
  });

  const report = await runAgent({ sweep: async () => fx.sweep });
  const outcome = Object.fromEntries(report.outcomes.map((o) => [o.invoiceNumber, o.outcome]));
  assert.deepEqual(outcome, { "DEMO-07": "escalated", "DEMO-06": "passed", "DEMO-08": "blocked", "DEMO-05": "blocked", "DEMO-04": "blocked" });
  assert.equal(report.rounds, 2);
  assert.deepEqual(counts, { drafter: 2, critic: 2 });

  const chain = (await store.listProposals({ invoiceId: id("DEMO-06") })).sort((a, b) => a.revision - b.revision);
  assert.deepEqual(chain.map((p) => [p.revision, p.status]), [[0, "revised"], [1, "passed"]]);
  assert.equal(chain[1].parentId, chain[0].id);
  // DEMO-08's blocked draft never reached the queue, and nothing is still pending review.
  assert.equal((await store.listProposals({ status: ["pending_review"] })).length, 0);
  reset();
});
