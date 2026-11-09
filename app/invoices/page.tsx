import WithAssistant from "../WithAssistant";
import { requirePageSession } from "@/lib/auth-server";
import Link from "next/link";
import { listInvoices } from "@/lib/paypal/invoices";
import { PayPalError } from "@/lib/paypal/client";
import { money, recipientLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requirePageSession("/invoices");
  const page = Math.max(1, Number((await searchParams).page) || 1);

  let data;
  try {
    data = await listInvoices(page);
  } catch (err) {
    const e = err as PayPalError;
    return (
      <div className="card">
        <h1>Couldn&apos;t load invoices</h1>
        <p className="error">{e.name}: {e.message}{e.debugId ? `\ndebug_id: ${e.debugId}` : ""}</p>
        <p className="muted">Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env.</p>
      </div>
    );
  }

  const items = data.items ?? [];
  const totalPages = data.total_pages ?? 1;

  return (
    <WithAssistant>
      <h1>Invoices</h1>
      <div className="card">
        {items.length === 0 ? (
          <p className="muted">No invoices yet. <Link href="/invoices/new">Create your first one.</Link></p>
        ) : (
          <table>
            <thead>
              <tr><th>Number</th><th>Recipient</th><th>Status</th><th>Date</th><th className="num">Amount</th><th className="num">Due</th></tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id}>
                  <td><Link href={`/invoices/${inv.id}`}>{inv.detail.invoice_number ?? inv.id}</Link></td>
                  <td>{recipientLabel(inv.primary_recipients?.[0])}</td>
                  <td><span className={`status status-${inv.status}`}>{inv.status.replaceAll("_", " ")}</span></td>
                  <td>{inv.detail.invoice_date ?? "—"}</td>
                  <td className="num">{money(inv.amount)}</td>
                  <td className="num">{money(inv.due_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {totalPages > 1 && (
        <div className="actions">
          {page > 1 && <Link className="button" href={`/invoices?page=${page - 1}`}>← Previous</Link>}
          <span className="muted">Page {page} of {totalPages}</span>
          {page < totalPages && <Link className="button" href={`/invoices?page=${page + 1}`}>Next →</Link>}
        </div>
      )}
    </WithAssistant>
  );
}
