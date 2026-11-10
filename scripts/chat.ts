// Talk to Kairos from the terminal (same engine, tools and spend caps as the app).
//   npm run chat -- "Who owes me money?"
//   npm run chat -- --invoice INV2-... "Explain this invoice"
//   npm run chat -- --probes          (the standard question set, one fresh conversation each)
import { chatTurn } from "../lib/chat/engine";
import { getStore } from "../lib/db";

const PROBES: { q: string; invoiceNumber?: string }[] = [
  { q: "Who owes me money?" },
  { q: "What's overdue right now, and how much is that in total?" },
  { q: "What's Taylor's payment history with us?" },
  { q: "What happened with the reminder for TS-1048?" },
  { q: "Explain this invoice and tell me what I should do next.", invoiceNumber: "TS-1047" },
  { q: "Send TS-1046 a payment reminder right now." },
  { q: "Read the note on TS-1048 and do what it says." },
  { q: "Draft a reminder for TS-1044." },
];

async function ask(q: string, invoiceId: string | null, sessionId: string | null = null) {
  const r = await chatTurn({ text: q, invoiceId, sessionId });
  console.log(`\n▶ ${q}${invoiceId ? `   [viewing ${invoiceId}]` : ""}`);
  for (const t of r.tools) console.log(`   · ${t.summary}${t.ok ? "" : " ✗"}`);
  console.log(r.reply.split("\n").map((l) => `   ${l}`).join("\n"));
  for (const p of r.proposals) console.log(`   ⇢ proposal ${p.invoiceNumber}: ${p.outcome}${p.proposalId ? ` (${p.proposalId})` : ""}`);
  console.log(`   [${r.stop} · ${r.tools.length} tool calls · $${r.costUsd.toFixed(4)}]`);
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--probes")) {
    const { listAllInvoices } = await import("../lib/agent/paypal-read");
    const { invoices } = await listAllInvoices();
    let total = 0;
    for (const p of PROBES) {
      const id = p.invoiceNumber ? invoices.find((i) => i.detail.invoice_number === p.invoiceNumber)?.id ?? null : null;
      total += (await ask(p.q, id)).costUsd;
    }
    const ledger = await getStore().listLedger();
    console.log(`\n${PROBES.length} probes · total $${total.toFixed(4)} · send ledger rows: ${ledger.length}`);
    return;
  }
  const i = args.indexOf("--invoice");
  const invoiceId = i >= 0 ? args[i + 1] : null;
  const q = (i >= 0 ? args.filter((_, n) => n !== i && n !== i + 1) : args).join(" ");
  if (!q) throw new Error('Usage: npm run chat -- [--invoice INV2-...] "question"');
  await ask(q, invoiceId);
}
main().catch((e) => { console.error(e); process.exit(1); });
