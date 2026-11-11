import WithAssistant from "./WithAssistant";
import Link from "next/link";
import { requirePageSession } from "@/lib/auth-server";
import { loadDashboard, type Dashboard } from "@/lib/dashboard";
import { PayPalError } from "@/lib/paypal/client";
import { money, recipientLabel } from "@/lib/format";
import { daysBetween } from "@/lib/clock";
import { dueDateOf } from "@/lib/agent/sweep";

export const dynamic = "force-dynamic";

// Inline line icons (stroke = currentColor), drawn for Kairos.
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const ICONS = {
  photo: "M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  voice: "M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6",
  agent: "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18.5 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8zM5.5 15l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L3.5 17l1.4-.6z",
  approve: "M9 11.5l2.2 2.2L15.5 9.5M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
  reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
};
function quickActions(waiting: number) {
  return [
    { href: "/invoices/new#from-photo", title: "Invoice from a photo", sub: "Snap a quote or job note; Kairos fills the form for you to check.", icon: <Icon d={ICONS.photo} /> },
    { href: "/invoices/new#from-photo", title: "Dictate an invoice", sub: "Say what you did and for whom; review before it's created.", icon: <Icon d={ICONS.voice} /> },
    { href: "/approvals#run-agent", title: "Run Kairos now", sub: "Draft reminders for overdue invoices. Nothing sends without you.", icon: <Icon d={ICONS.agent} /> },
    { href: "/approvals", title: "Review approvals", sub: waiting ? `${waiting} reminder${waiting === 1 ? "" : "s"} waiting for your OK.` : "Nothing waiting right now.", icon: <Icon d={ICONS.approve} /> },
    { href: "/reports", title: "Reports", sub: "Aging, cash forecast and the Director's plan.", icon: <Icon d={ICONS.reports} /> },
  ];
}

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

      <nav className="quick-actions" aria-label="Quick actions">
        {quickActions(d.queue.awaitingApproval).map((q) => (
          <Link key={q.title} href={q.href} className="quick">
            <span className="quick-icon" aria-hidden>{q.icon}</span>
            <span className="quick-title">{q.title}</span>
            <span className="quick-sub">{q.sub}</span>
          </Link>
        ))}
      </nav>

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
