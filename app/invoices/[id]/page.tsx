import WithAssistant from "../../WithAssistant";
import { requirePageSession } from "@/lib/auth-server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getInvoice } from "@/lib/paypal/invoices";
import { PayPalError } from "@/lib/paypal/client";
import { money, recipientLabel } from "@/lib/format";
import InvoiceActions from "./InvoiceActions";

export const dynamic = "force-dynamic";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession(`/invoices/${(await params).id}`);
  const { id } = await params;

  let inv;
  try {
    inv = await getInvoice(id);
  } catch (err) {
    if (err instanceof PayPalError && err.status === 404) notFound();
    throw err;
  }

  const recipient = inv.primary_recipients?.[0];
  const payUrl = inv.detail.metadata?.recipient_view_url;
  const txns = inv.payments?.transactions ?? [];

  return (
    <WithAssistant invoiceId={inv.id} invoiceNumber={inv.detail.invoice_number ?? null}>
      <p><Link href="/invoices">← Invoices</Link></p>
      <h1>
        Invoice {inv.detail.invoice_number ?? inv.id}{" "}
        <span className={`status status-${inv.status}`}>{inv.status.replaceAll("_", " ")}</span>
      </h1>

      <InvoiceActions id={inv.id} status={inv.status} dueAmount={inv.due_amount?.value} />

      <div className="card">
        <div className="row">
          <div>
            <label>Bill to</label>
            <div>{recipientLabel(recipient)}</div>
            {recipient?.billing_info?.business_name && <div>{recipient.billing_info.business_name}</div>}
            <div className="muted">{recipient?.billing_info?.email_address}</div>
          </div>
          <div>
            <label>Terms</label>
            <div>{inv.detail.payment_term?.term_type?.replaceAll("_", " ") ?? "—"}</div>
            <div className="muted">{inv.detail.payment_term?.due_date ? `Due ${inv.detail.payment_term.due_date}` : ""}</div>
          </div>
          <div>
            <label>Total / Due</label>
            <div>{money(inv.amount)}</div>
            <div className="muted">{money(inv.due_amount)} due</div>
          </div>
        </div>

        <h2>Items</h2>
        <table>
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Tax</th></tr></thead>
          <tbody>
            {(inv.items ?? []).map((it, i) => (
              <tr key={i}>
                <td>{it.name}{it.description && <div className="muted">{it.description}</div>}</td>
                <td className="num">{it.quantity}</td>
                <td className="num">{money(it.unit_amount)}</td>
                <td className="num">{it.tax ? `${it.tax.percent}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {inv.detail.note && (<><h2>Note</h2><p>{inv.detail.note}</p></>)}

        {txns.length > 0 && (
          <>
            <h2>Payments</h2>
            <table>
              <thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {txns.map((t, i) => (
                  <tr key={t.payment_id ?? i}>
                    <td>{t.payment_date ?? "—"}</td>
                    <td>{t.method?.replaceAll("_", " ") ?? "—"}</td>
                    <td>{t.note ?? ""}</td>
                    <td className="num">{money(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {payUrl && inv.status !== "DRAFT" && (
          <p className="muted">Payer link: <a href={payUrl} target="_blank" rel="noreferrer">{payUrl}</a></p>
        )}
      </div>
    </WithAssistant>
  );
}
