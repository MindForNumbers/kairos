// Fails if code crosses an architectural boundary. Rules grow as stages land.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".next", ".git", "data"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) files.push(relative(ROOT, p));
  }
})(ROOT);

const rules = [
  {
    name: "Database drivers are only imported inside lib/db/",
    applies: (f) => !f.startsWith("lib/db/") && !f.startsWith("tests/") && f !== "scripts/check-boundaries.mjs",
    forbid: /from\s+["'](better-sqlite3|pg|postgres)["']|require\(["'](better-sqlite3|pg|postgres)["']\)/,
  },
  {
    name: "Only lib/db/index.ts is imported from outside lib/db/",
    applies: (f) => !f.startsWith("lib/db/"),
    forbid: /from\s+["'](@\/lib\/db|(\.\.\/)+lib\/db)\/(sqlite|types|draft-hash)["']/,
  },
  {
    name: "lib/agent/ reaches PayPal only through lib/agent/paypal-read.ts",
    applies: (f) => f.startsWith("lib/agent/") && f !== "lib/agent/paypal-read.ts",
    forbid: /from\s+["'](@\/lib\/paypal|(\.\.\/)+paypal)(\/[^"']*)?["']/,
  },
  {
    name: "paypal-read.ts imports only read operations",
    applies: (f) => f === "lib/agent/paypal-read.ts",
    check: (src) => {
      const imports = [...src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)];
      const allowed = new Set(["getInvoice", "listInvoices", "Invoice"]);
      return imports.every(([, , names, from]) =>
        !from.includes("paypal") ||
        (from === "@/lib/paypal/invoices" && names.split(",").map((n) => n.trim()).filter(Boolean).every((n) => allowed.has(n))));
    },
  },
  {
    name: "lib/agent/ makes no HTTP calls and never touches /api routes or the executor",
    applies: (f) => f.startsWith("lib/agent/"),
    forbid: /\bfetch\(|["'`]\/api\/|lib\/(executor|queue|auth)|from\s+["']node:(http|https|net)["']/,
  },
  {
    name: "Business time comes from lib/clock.ts (mark genuine real-time reads with a real-clock comment)",
    applies: (f) => /^(lib|app\/api|scripts)\//.test(f) && f !== "lib/clock.ts" && f !== "scripts/check-boundaries.mjs",
    check: (src) => src.split("\n").every((line, i, lines) =>
      !/new Date\(\)|Date\.now\(\)/.test(line) || /real-clock/.test(line) || /real-clock/.test(lines[i - 1] ?? "")),
  },
  {
    name: "Only lib/executor/ calls PayPal's /remind endpoint (one attempt, limits, ledger)",
    applies: (f) => /^(lib|app|scripts)\//.test(f) && !f.startsWith("lib/executor/") && f !== "scripts/check-boundaries.mjs" && f !== "app/invoices/[id]/InvoiceActions.tsx",
    forbid: /\/remind\b|remindInvoice/,
  },
  {
    name: "executeApproval is reached only through the approval queue (lib/queue/actions.ts)",
    applies: (f) => /^(lib|app|scripts)\//.test(f) && !f.startsWith("lib/executor/") && f !== "lib/queue/actions.ts" && f !== "scripts/check-boundaries.mjs",
    forbid: /\bexecuteApproval\b|setExecutorDepsForTesting/,
  },
  {
    name: "The chat is read-only: no queue/executor, no direct PayPal client, no HTTP, no write-side store calls (it may only request drafts via runAgent)",
    applies: (f) => f.startsWith("lib/chat/") || f.startsWith("app/api/chat/"),
    forbid: /lib\/(queue|executor)\b|from\s+["']@\/lib\/paypal\/|\bfetch\(|["'`]\/api\/|\.(createApproval|claimApproval|releaseApproval|recordAgentSend|recordManualSend|updateProposalStatus|resolveProposal|createProposal|createRun|finishRun)\(|\b(approveProposal|approveAndExecute|rejectProposal|executeApproval|sendManualReminder|triggerRun|setPaypalReadsForTesting)\b/,
  },
  {
    name: "The executor is code, not a model: no LLM calls in lib/executor/",
    applies: (f) => f.startsWith("lib/executor/"),
    forbid: /from\s+["']@\/lib\/llm|structuredCall|@anthropic-ai\/sdk/,
  },
];

let failed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const r of rules) {
    if (r.applies(f) && (r.forbid ? r.forbid.test(src) : !r.check(src))) {
      console.error(`✗ ${f}: ${r.name}`);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log(`✓ boundaries ok (${rules.length} rules, ${files.length} files)`);
