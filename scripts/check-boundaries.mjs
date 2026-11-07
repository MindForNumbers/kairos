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
];

let failed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const r of rules) {
    if (r.applies(f) && r.forbid.test(src)) {
      console.error(`✗ ${f}: ${r.name}`);
      failed++;
    }
  }
}
if (failed) process.exit(1);
console.log(`✓ boundaries ok (${rules.length} rules, ${files.length} files)`);
