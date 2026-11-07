import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, MAX_REVISIONS } from "../lib/agent/pipeline";
import { costOf, maxCostOf } from "../lib/llm/pricing";
import { cleanDrafts, isolate, loadReplay, passAll, recordOf, reset, stubModels } from "./helpers";

const fx = loadReplay();
const sweep = async () => fx.sweep;
const id = (n: string) => recordOf(fx.sweep, n).invoiceId;

afterEach(() => {
  reset();
  delete process.env.KAIROS_RUN_COST_CAP;
  delete process.env.KAIROS_DAILY_COST_CAP;
});

test("clean run: every draft passes in one round", async () => {
  isolate(fx.sweep.asOf);
  const { counts } = stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: (r) => ({ json: passAll(r.user) }) });
  const r = await runAgent({ sweep });
  assert.deepEqual(r.outcomes.map((o) => [o.invoiceNumber, o.outcome]),
    [["DEMO-07", "escalated"], ["DEMO-06", "passed"], ["DEMO-08", "passed"], ["DEMO-05", "passed"], ["DEMO-04", "passed"]]);
  assert.deepEqual(counts, { drafter: 1, critic: 1 });
  assert.equal(r.halted, null);
});

test(`revision cap: a draft still failing (a) after ${MAX_REVISIONS} revisions is blocked`, async () => {
  const store = isolate(fx.sweep.asOf);
  // DEMO-06 always comes back with the wrong amount; everything else is clean. Critic passes all (code catches it).
  const { counts } = stubModels({
    drafter: (r) => ({ json: cleanDrafts(r.user, { "DEMO-06": "Hello, invoice DEMO-06 for $2,530.00 was due September 19, 2026. Please pay now." }) }),
    critic: (r) => ({ json: passAll(r.user) }),
  });
  const r = await runAgent({ sweep });

  assert.equal(r.rounds, MAX_REVISIONS + 1);
  assert.deepEqual(counts, { drafter: MAX_REVISIONS + 1, critic: MAX_REVISIONS + 1 });
  const o6 = r.outcomes.find((o) => o.invoiceNumber === "DEMO-06")!;
  assert.equal(o6.outcome, "blocked");
  assert.match(o6.reason!, /Still failing after 2 revisions: \(a\)/);
  const chain = (await store.listProposals({ invoiceId: id("DEMO-06") })).sort((a, b) => a.revision - b.revision);
  assert.deepEqual(chain.map((p) => [p.revision, p.status]), [[0, "revised"], [1, "revised"], [2, "blocked"]]);
  assert.deepEqual(chain.slice(1).map((p) => p.parentId), [chain[0].id, chain[1].id]);
  // Revision prompts only targeted DEMO-06 and carried the (a) feedback.
  assert.equal(r.outcomes.filter((o) => o.outcome === "passed").length, 3);
});

test("revision cap: an invoice the drafter never covers ends up escalated, not silently dropped", async () => {
  isolate(fx.sweep.asOf);
  stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user, { "DEMO-04": null }) }), critic: (r) => ({ json: passAll(r.user) }) });
  const r = await runAgent({ sweep });
  const o4 = r.outcomes.find((o) => o.invoiceNumber === "DEMO-04")!;
  assert.equal(o4.outcome, "escalated");
  assert.match(o4.reason!, /Still failing after 2 revisions: \(e\)/);
});

test("critic refusal = fail: every draft under review is blocked for a human, no revisions", async () => {
  const store = isolate(fx.sweep.asOf);
  const { counts } = stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: () => ({ refusal: true }) });
  const r = await runAgent({ sweep });
  assert.deepEqual(counts, { drafter: 1, critic: 1 });
  for (const n of ["DEMO-06", "DEMO-08", "DEMO-05", "DEMO-04"]) {
    const o = r.outcomes.find((x) => x.invoiceNumber === n)!;
    assert.equal(o.outcome, "blocked", n);
    assert.match(o.reason!, /^Critic failed \(refusal: general_harms\); needs a human/);
  }
  assert.equal((await store.listProposals({ status: ["passed"] })).length, 0);
});

test("critic invalid output = fail, same as a refusal", async () => {
  isolate(fx.sweep.asOf);
  stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: () => ({ json: { reviews: "nope" } }) });
  const r = await runAgent({ sweep });
  assert.ok(r.outcomes.filter((o) => o.outcome !== "escalated").every((o) => o.outcome === "blocked" && /Critic failed \(invalid_output/.test(o.reason!)));
});

test("critic that skips a draft: no verdict = blocked", async () => {
  isolate(fx.sweep.asOf);
  stubModels({
    drafter: (r) => ({ json: cleanDrafts(r.user) }),
    critic: (r) => { const j = passAll(r.user); j.reviews = j.reviews.filter((x) => x.invoiceId !== id("DEMO-05")); return { json: j }; },
  });
  const r = await runAgent({ sweep });
  assert.equal(r.outcomes.find((o) => o.invoiceNumber === "DEMO-05")!.reason, "Critic returned no verdict; needs a human");
  assert.equal(r.outcomes.find((o) => o.invoiceNumber === "DEMO-06")!.outcome, "passed");
});

test("cost is recorded per call and reported per run", async () => {
  const store = isolate(fx.sweep.asOf);
  stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: (r) => ({ json: passAll(r.user) }) });
  const r = await runAgent({ sweep });
  const expected = costOf("claude-haiku-5-5", { inputTokens: 3000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 })
    + costOf("claude-sonnet-5-5", { inputTokens: 3000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.ok(Math.abs(r.cost.totalUsd - expected) < 1e-9, `${r.cost.totalUsd} vs ${expected}`);
  assert.equal(r.cost.byPurpose.drafter.calls, 1);
  assert.equal(r.cost.byPurpose.critic.calls, 1);
  assert.ok(Math.abs((await store.modelSpendForRun(r.runId)).totalUsd - expected) < 1e-9);
});

test("run cost cap halts BEFORE a call that could exceed it; unreviewed drafts are blocked", async () => {
  const store = isolate(fx.sweep.asOf);
  process.env.KAIROS_RUN_COST_CAP = "0.05"; // enough for the drafter, not for a worst-case critic call
  const { counts } = stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: (r) => ({ json: passAll(r.user) }) });
  const r = await runAgent({ sweep });
  assert.equal(r.halted?.cap, "run");
  assert.deepEqual(counts, { drafter: 1, critic: 0 }, "critic was never called");
  assert.ok(r.cost.totalUsd <= 0.05);
  assert.ok(r.outcomes.filter((o) => o.outcome !== "escalated").every((o) => o.outcome === "blocked" && /Run halted before review finished/.test(o.reason!)));
  assert.equal((await store.listProposals({ status: ["pending_review"] })).length, 0, "nothing left pending");
  assert.equal((await store.getRun(r.runId))!.status, "failed");
});

test("daily cost cap counts spend from earlier runs today", async () => {
  const store = isolate(fx.sweep.asOf);
  process.env.KAIROS_DAILY_COST_CAP = "1.00";
  await store.recordModelCall({ runId: null, purpose: "earlier", model: "claude-sonnet-5-5", requestId: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.999 });
  const { counts } = stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: (r) => ({ json: passAll(r.user) }) });
  const r = await runAgent({ sweep });
  assert.equal(r.halted?.cap, "daily");
  assert.deepEqual(counts, { drafter: 0, critic: 0 });
  // Halted before the first draft batch was saved: the run leaves nothing behind (DEMO-07 is escalated next run).
  assert.deepEqual(r.outcomes, []);
  assert.equal((await store.listProposals()).length, 0);
});

test("pricing: worst-case estimate bounds the actual cost; unknown models are refused", () => {
  const worst = maxCostOf("claude-sonnet-5-5", 10_000, 16_000);
  assert.ok(worst >= costOf("claude-sonnet-5-5", { inputTokens: 4000, outputTokens: 16_000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  assert.throws(() => costOf("claude-mystery-9", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), /No price/);
  // Haiku long-prompt tier.
  assert.equal(costOf("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0.5);
});
