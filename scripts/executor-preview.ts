// What would the executor do for each queued draft, right now? Read-only: no token is minted
// or claimed and nothing is sent. It re-fetches each invoice from PayPal (GET only).
//   npm run executor:preview
import { getStore } from "../lib/db";
import { previewExecution } from "../lib/executor/execute";
import { dailySendCap, executorEnabled, killFilePath, killActive, quietHours } from "../lib/executor/limits";
import { isOverridden, nowIso } from "../lib/clock";

async function main() {
  const store = getStore();
  const queued = (await store.listProposals({ status: ["passed"] })).reverse();
  const q = quietHours();
  console.log(`Executor preview · ${nowIso()}${isOverridden() ? " (KAIROS_NOW)" : ""}`);
  console.log(`mode: ${executorEnabled() ? "LIVE (KAIROS_EXECUTOR_ENABLED=1)" : "DRY RUN (set KAIROS_EXECUTOR_ENABLED=1 to send)"} · daily cap ${dailySendCap()} · quiet ${q.label} · KILL ${killActive() ? "PRESENT" : "absent"} (${killFilePath()})\n`);

  for (const p of queued) {
    const r = await previewExecution(p.id);
    console.log(`━━ ${p.subject} · ${p.id}`);
    console.log(`   would: ${r.outcome.toUpperCase()}: ${r.reason}`);
    for (const s of r.steps) console.log(`   ${s.ok ? "✓" : "✗"} ${s.name.padEnd(16)} ${s.detail}`);
    if (r.request) {
      console.log(`   request: ${r.request.method} ${r.request.path}`);
      console.log(`   body:    ${JSON.stringify(r.request.body, null, 2).replace(/\n/g, "\n            ")}`);
    }
    console.log("");
  }
  if (!queued.length) console.log("Nothing in the approval queue.");
}
main().catch((e) => { console.error(e); process.exit(1); });
