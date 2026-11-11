import "server-only";
import { nowMs } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { runAgent, type RunReport } from "@/lib/agent/pipeline";
import { RunBusyError, withRunLock } from "@/lib/agent/run-guard";
import { QueueError } from "./actions";

/**
 * "Run agent" from the Approvals page. A human decision, so it lives with the queue, not
 * the agent. Guards: one run at a time (shared with chat requests); at least MIN_GAP_MS
 * between full runs (protects the hosted demo from click-spam); spend caps apply inside
 * runAgent() as usual.
 */

export const MIN_GAP_MS = 60_000;
/** A "running" run older than this is treated as crashed, not as in progress. */
const STALE_RUN_MS = 10 * 60_000;

export async function triggerRun(actor: string, runner: () => Promise<RunReport> = () => runAgent(), source = "approvals_page"): Promise<RunReport> {
  try {
    return await withRunLock(async () => {
      const store = getStore();
      const [last] = await store.listRuns(1);
      if (last) {
        const age = nowMs() - Date.parse(last.startedAt);
        if (last.status === "running" && age < STALE_RUN_MS) throw new RunBusyError();
        if (age < MIN_GAP_MS) {
          throw new QueueError(429, "TOO_SOON", `The last run started ${Math.round(age / 1000)}s ago; wait ${Math.ceil((MIN_GAP_MS - age) / 1000)}s`);
        }
      }
      await store.audit({ actor, event: "run.requested", entityType: null, entityId: null, data: { source } });
      return runner();
    });
  } catch (err) {
    if (err instanceof RunBusyError) throw new QueueError(409, "RUN_IN_PROGRESS", err.message);
    throw err;
  }
}

/** What the button shows: counts, not the full trace. */
export function summarize(r: RunReport) {
  const count = (o: string) => r.outcomes.filter((x) => x.outcome === o).length;
  return {
    runId: r.runId,
    candidates: r.sweep.candidates.length,
    passed: count("passed"),
    blocked: count("blocked"),
    escalated: count("escalated"),
    excluded: r.sweep.excluded.map((e) => ({ invoiceNumber: e.invoiceNumber, reason: e.reason })),
    rounds: r.rounds,
    costUsd: r.cost.totalUsd,
    halted: r.halted,
  };
}
