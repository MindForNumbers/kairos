import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { setClockForTesting } from "../lib/clock";
import { runAgent } from "../lib/agent/pipeline";
import { MIN_GAP_MS, triggerRun, summarize } from "../lib/queue/run";
import type { QueueError } from "../lib/queue/actions";
import { cleanDrafts, isolate, loadReplay, passAll, reset, stubModels } from "./helpers";

const fx = loadReplay();
const T0 = "2026-11-08T20:00:00Z";
const runner = () => runAgent({ sweep: async () => fx.sweep });
afterEach(reset);

test("Run agent: one at a time, 60s between starts, summary for the button", async () => {
  const store = isolate(T0);
  stubModels({ drafter: (r) => ({ json: cleanDrafts(r.user) }), critic: (r) => ({ json: passAll(r.user) }) });

  const first = triggerRun("user:admin", runner);
  await assert.rejects(triggerRun("user:admin", runner), (e: QueueError) => e.code === "RUN_IN_PROGRESS");
  const s = summarize(await first);
  assert.deepEqual([s.candidates, s.passed, s.blocked, s.escalated], [5, 4, 0, 1]);

  setClockForTesting(new Date(Date.parse(T0) + 30_000));
  await assert.rejects(triggerRun("user:admin", runner), (e: QueueError) => e.code === "TOO_SOON" && e.status === 429);

  setClockForTesting(new Date(Date.parse(T0) + MIN_GAP_MS + 1_000));
  await triggerRun("user:admin", runner);
  assert.equal((await store.listAudit()).filter((e) => e.event === "run.requested").length, 2);
});
