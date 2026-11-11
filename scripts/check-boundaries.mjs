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
    name: "lib/intake/ only reads input and fills a form: no PayPal, queue, executor, HTTP, file writes or store writes (beyond its budget's model_calls and audit)",
    applies: (f) => f.startsWith("lib/intake/") || f.startsWith("app/api/intake/"),
    forbid: /lib\/(paypal|queue|executor)\b|paypal-read|\bfetch\(|["'`]\/api\/|from\s+["']node:(fs|fs\/promises|http|https|net)["']|\.(createApproval|claimApproval|recordAgentSend|recordManualSend|updateProposalStatus|resolveProposal|createProposal|createRun|appendChatMessage)\(|\b(writeFile|createWriteStream)\b/,
  },
  {
    name: "Only lib/payments/ imports the APIMatic PayPal SDK (package \"paypal\")",
    applies: (f) => !f.startsWith("lib/payments/") && !f.startsWith("tests/") && f !== "scripts/check-boundaries.mjs",
    forbid: /from\s+["']paypal["']|require\(["']paypal["']\)/,
  },
  {
    name: "lib/payments/ is read-only Transaction Search: only transactionSearch.searchTransactions, no other SDK resource, no HTTP, no lib/paypal, queue, executor or store",
    applies: (f) => f.startsWith("lib/payments/"),
    check: (src) =>
      !/\.(orders|payments|vault|subscriptions)\s*\.|\bfetch\(|lib\/(paypal|queue|executor|db)\b|getStore\(/.test(src) &&
      [...src.matchAll(/transactionSearch\.(\w+)/g)].every((m) => m[1] === "searchTransactions"),
  },
  {
    name: "Only lib/executor/ updates (PUT) an existing invoice or turns on partial payments for one (the owner's create call in lib/paypal/invoices.ts may set it on a new invoice)",
    applies: (f) => /^(lib|app|scripts)\//.test(f) && !f.startsWith("lib/executor/") && f !== "scripts/check-boundaries.mjs",
    check: (src, f) => !/method:\s*["']PUT["']/.test(src) && (f === "lib/paypal/invoices.ts" || !/allow_partial_payment["']?\s*:\s*true/.test(src)),
  },
  {
    name: "The drafter never writes offer terms: lib/agent/ renders them from the owner's policy (offerSentence), the model only picks payment_plan or none",
    applies: (f) => f === "lib/agent/drafter.ts",
    check: (src) => /offer:\s*z\.enum\(\["payment_plan",\s*"none"\]\)/.test(src) && !/z\.object\(\{[^}]*\b(parts|minimumAmount)\b/.test(src),
  },
  {
    name: "lib/director/ is deterministic and read-only: no LLM, no direct PayPal client (reads go through paypal-read), no queue/executor, no HTTP, no store writes",
    applies: (f) => f.startsWith("lib/director/"),
    forbid: /from\s+["']@\/lib\/(llm|paypal|queue|executor)\b|structuredCall|@anthropic-ai\/sdk|\bfetch\(|\.(createApproval|claimApproval|releaseApproval|recordAgentSend|recordManualSend|updateProposalStatus|resolveProposal|createProposal|createRun|finishRun|appendIncentivePolicy|audit)\(/,
  },
  {
    name: "lib/director/model.ts is pure: no I/O, no store, no clock reads (today comes in the input)",
    applies: (f) => f === "lib/director/model.ts",
    forbid: /getStore|from\s+["']node:|\bnow\(|nowMs\(|localDate\(|Math\.random/,
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
    if (r.applies(f) && (r.forbid ? r.forbid.test(src) : !r.check(src, f))) {
      console.error(`✗ ${f}: ${r.name}`);
      failed++;
    }
  }
}
// Deploys (Render) have no SSH key: every git dependency must resolve over https. `npm install`
// rewrites a GitHub dependency's lockfile `resolved` to git+ssh, so catch it here.
const lock = readFileSync("package-lock.json", "utf8");
if (/"resolved":\s*"git\+ssh:/.test(lock)) {
  console.error('✗ package-lock.json: a dependency resolves via git+ssh; set its "resolved" to git+https:// (deploys have no SSH key)');
  failed++;
}
if (failed) process.exit(1);
console.log(`✓ boundaries ok (${rules.length} rules + lockfile check, ${files.length} files)`);
