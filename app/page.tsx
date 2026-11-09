import WithAssistant from "./WithAssistant";
import Link from "next/link";
import { requirePageSession } from "@/lib/auth-server";
import { loadDashboard, type Dashboard } from "@/lib/dashboard";
import { PayPalError } from "@/lib/paypal/client";
import { money, recipientLabel } from "@/lib/format";
import { daysBetween } from "@/lib/clock";
import { dueDateOf } from "@/lib/agent/sweep";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requirePageSession("/");

  let d: Dashboard;
  try {
    d = await loadDashboard();
  } catch (err) {
    const e = err as PayPalError;
    return (
      <div className="card">
        <h1>Couldn&apos;t load your invoices</h1>
        <p className="error">{e.name}: {e.message}{e.debugId ? `\ndebug_id: ${e.debugId}` : ""}</p>
      </div>
    );
  }

  return (
    <WithAssistant>
    <div className="home">
      <div className="page-head">
        <div>
          <h1>Good to see you</h1>
          <p className="muted subtitle">Here&apos;s where Test Store&apos;s invoices stand today.</p>
        </div>
        <Link href="/invoices/new" className="button primary">New invoice</Link>
      </div>

      <section className="tiles">
        <Link href="/invoices" className="tile">
          <span className="tile-label">Total unpaid</span>
          {d.unpaid.length === 0 ? <span className="tile-value">$0.00</span> : d.unpaid.map((u) => (
            <span key={u.currency} className="tile-value">{money({ currency_code: u.currency, value: u.value })}</span>
          ))}
          <span className="tile-note">{d.unpaid.reduce((n, u) => n + u.count, 0)} open invoices</span>
        </Link>
        <Link href="/invoices" className={`tile ${d.overdue.count ? "tile-warn" : ""}`}>
          <span className="tile-label">Overdue</span>
          <span className="tile-value">{d.overdue.count}</span>
          <span className="tile-note">{d.overdue.oldestDays ? `oldest ${d.overdue.oldestDays} days past due` : "nothing past due"}</span>
        </Link>
        <Link href="/approvals" className={`tile ${d.queue.awaitingApproval ? "tile-accent" : ""}`}>
          <span className="tile-label">Reminders awaiting approval</span>
          <span className="tile-value">{d.queue.awaitingApproval}</span>
          <span className="tile-note">drafted and checked by Kairos</span>
        </Link>
        <Link href="/approvals" className={`tile ${d.queue.needsHuman ? "tile-warn" : ""}`}>
          <span className="tile-label">Needs your attention</span>
          <span className="tile-value">{d.queue.needsHuman}</span>
          <span className="tile-note">blocked or escalated</span>
        </Link>
      </section>

      <section>
        <div className="section-head">
          <h2>Recent invoices</h2>
          <Link href="/invoices">View all →</Link>
        </div>
        <div className="card">
          {d.recent.length === 0 ? <p className="muted">No invoices yet. <Link href="/invoices/new">Create your first one.</Link></p> : (
            <table>
              <thead><tr><th>Number</th><th>Customer</th><th>Status</th><th className="hide-sm">Due</th><th className="num">Amount due</th></tr></thead>
              <tbody>
                {d.recent.map((inv) => {
                  const due = dueDateOf(inv);
                  const late = due && ["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.status) ? daysBetween(due, d.today) : 0;
                  return (
                    <tr key={inv.id}>
                      <td><Link href={`/invoices/${inv.id}`}>{inv.detail.invoice_number ?? inv.id}</Link></td>
                      <td>{recipientLabel(inv.primary_recipients?.[0])}</td>
                      <td>
                        <span className={`status status-${inv.status}`}>{inv.status.replaceAll("_", " ")}</span>
                        {late > 0 && <span className="late">{late}d late</span>}
                      </td>
                      <td className="hide-sm">{due ?? "—"}</td>
                      <td className="num">{money(inv.due_amount ?? inv.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {d.truncated && <p className="muted">Totals cover the most recent 1,000 invoices.</p>}
      </section>
    </div>
    </WithAssistant>
  );
}
