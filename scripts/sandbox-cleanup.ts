// Reset the sandbox to a single demo set: cancel (or delete, if draft) every invoice whose
// number doesn't start with "<KEEP>-". Paid/cancelled/refunded invoices can't be cancelled
// and are only reported. Recipients are NOT emailed.
//   npm run sandbox:cleanup                 # dry run, keeps DEMO-*
//   npm run sandbox:cleanup -- --apply      # do it
//   npm run sandbox:cleanup -- --keep=SEED  # keep a different prefix
import { paypalRequest } from "../lib/paypal/client";
import { listInvoices, type Invoice } from "../lib/paypal/invoices";

// PayPal refuses to cancel PARTIALLY_PAID invoices (CANNOT_CANCEL_PAID_INVOICE), verified in sandbox.
const CANCELLABLE = new Set(["SENT", "UNPAID", "SCHEDULED", "PAYMENT_PENDING"]);

async function listAll(): Promise<Invoice[]> {
  const all: Invoice[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await listInvoices(page, 100);
    all.push(...(res.items ?? []));
    if (page >= (res.total_pages ?? 1)) break;
  }
  return all;
}

async function main() {
  const env = (process.env.PAYPAL_ENVIRONMENT ?? "sandbox").trim().toLowerCase();
  if (env === "live" || env === "production") throw new Error("Refusing to run: PAYPAL_ENVIRONMENT is live");
  const apply = process.argv.includes("--apply");
  const keep = process.argv.find((a) => a.startsWith("--keep="))?.slice(7) || process.env.KAIROS_SEED_PREFIX?.trim() || "DEMO";

  const invoices = await listAll();
  console.log(`${apply ? "APPLY" : "DRY RUN"}: keeping ${keep}-*, ${invoices.length} invoices listed\n`);
  const counts = { kept: 0, cancelled: 0, deleted: 0, left: 0, failed: 0 };

  for (const inv of invoices) {
    const num = inv.detail.invoice_number ?? "—";
    const to = inv.primary_recipients?.[0]?.billing_info?.email_address ?? "—";
    const tag = `${num.padEnd(14)} ${inv.id}  ${inv.status.padEnd(15)} ${to}`;
    if (num.startsWith(`${keep}-`)) { counts.kept++; console.log(`  keep    ${tag}`); continue; }

    const action = inv.status === "DRAFT" ? "delete" : CANCELLABLE.has(inv.status) ? "cancel" : null;
    if (!action) { counts.left++; console.log(`  leave   ${tag}  (${inv.status} can't be cancelled${inv.status === "PARTIALLY_PAID" ? "; record the remaining payment to close it" : ""})`); continue; }
    if (!apply) { console.log(`  ${action.padEnd(7)} ${tag}`); continue; }
    try {
      if (action === "delete") {
        await paypalRequest(`/v2/invoicing/invoices/${inv.id}`, { method: "DELETE" });
        counts.deleted++;
      } else {
        await paypalRequest(`/v2/invoicing/invoices/${inv.id}/cancel`, {
          method: "POST",
          body: { note: "Sandbox cleanup", send_to_recipient: false, send_to_invoicer: false },
        });
        counts.cancelled++;
      }
      console.log(`  ${action === "delete" ? "deleted" : "cancelled"} ${tag}`);
    } catch (e) {
      counts.failed++;
      console.log(`  FAILED  ${tag}  ${(e as Error).name}: ${(e as Error).message}`);
    }
  }
  console.log(`\n${JSON.stringify(counts)}${apply ? "" : "  (dry run; pass --apply)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
