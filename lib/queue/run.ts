import "server-only";
import { nowMs } from "@/lib/clock";
import { getStore } from "@/lib/db";
import { runAgent, type RunReport } from "@/lib/agent/pipeline";
import { QueueError } from "./actions";

/**
 * "Run agent" from the Approvals page. A human decision, so it lives with the queue, not
 * the agent. Guards: one run at a time; at least MIN_GAP_MS between starts (protects the
 * hosted demo from click-spam); spend caps apply inside runAgent() as usual.
 */

export const MIN_GAP_MS = 60_000;
/** A "running" run older than this is treated as crashed, not as in progress. */
const STALE_RUN_MS = 10 * 60_000;

// Taken synchronously, before any await, so two simultaneous clicks can't both pass the checks.
let busy = false;

export async function triggerRun(actor: string, runner: () => Promise<RunReport> = () => runAgent()): Promise<RunReport> {
  if (busy) throw new QueueError(409, "RUN_IN_PROGRESS", "An agent run is already in progress");
  busy = true;
  try {
    const store = getStore();
    const [last] = await store.listRuns(1);
    if (last) {
      const age = nowMs() - Date.parse(last.startedAt);
      if (last.status === "running" && age < STALE_RUN_MS) throw new QueueError(409, "RUN_IN_PROGRESS", "An agent run is already in progress");
      if (age < MIN_GAP_MS) {
        throw new QueueError(429, "TOO_SOON", `The last run started ${Math.round(age / 1000)}s ago; wait ${Math.ceil((MIN_GAP_MS - age) / 1000)}s`);
      }
    }
    await store.audit({ actor, event: "run.requested", entityType: null, entityId: null, data: { source: "approvals_page" } });
    return await runner();
  } finally {
    busy = false;
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
