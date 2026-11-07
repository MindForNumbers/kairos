// Stage 0 smoke test: one structured call to claude-haiku-5-5.
// Run: npm run llm:smoke
import { z } from "zod";
import { structuredCall, MODEL } from "../lib/llm/client";

const schema = z.object({ ok: z.boolean(), echo: z.string() });

async function main() {
const res = await structuredCall({
  purpose: "smoke",
  system: "Reply with JSON only.",
  user: 'Return ok=true and echo="kairos".',
  schema,
  effort: "low",
  maxTokens: 1024,
});
console.log(MODEL, res.ok ? res.data : res, res.meta);
process.exit(res.ok && res.data.echo === "kairos" ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
