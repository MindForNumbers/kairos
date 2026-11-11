import Link from "next/link";
import { requirePageSession } from "@/lib/auth-server";
import { loadDirectorPlan } from "@/lib/director/gather";
import { DIRECTOR_PARAMS, MOVE_LABEL, WEEKDAYS, weekdayOf, type Move } from "@/lib/director/model";
import { formatAmount } from "@/lib/agent/policy";
import Meter from "../Meter";

export const dynamic = "force-dynamic";

const money = (cents: number) => formatAmount((cents / 100).toFixed(2), "USD");
const dayLabel = (d: string | null, today: string) => (!d ? "—" : d === today ? "Today" : `${WEEKDAYS[weekdayOf(d)].slice(0, 3)} ${d}`);
const MOVE_CLASS: Record<Move, string> = { wait: "", friendly: "ok", firm: "warn", payment_plan: "warn", final_notice: "stale", escalate: "stale" };

export default async function DirectorPage() {
  await requirePageSession("/director");
  let plan;
  try {
    plan = await loadDirectorPlan();
  } catch (err) {
    return (
      <>
        <h1>Director&apos;s plan</h1>
        <div className="card error">Couldn&apos;t load the plan: {(err as Error).message}</div>
      </>
    );
  }
  const f = plan.forecast;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Director&apos;s plan</h1>
          <p className="muted subtitle">
            Getting paid is a timing problem. The Director reads each customer&apos;s history and recent signals and decides, in code, what to propose for each open invoice and when.
            Hard rules always win (grace period, 7-day cooldown, 60-day escalation, your incentive policy, flagged text). Drafts still go through the drafter, the critic and you on <Link href="/approvals">Approvals</Link>.
          </p>
        </div>
      </div>

      <section className="card stats">
        <div><label>Expected in the next {f.horizonDays} days</label><div>{money(f.expectedCents)}</div><div className="muted">confidence {f.confidence}</div></div>
        <div><label>Your cash target</label><div>{f.targetCents ? money(f.targetCents) : "not set"}</div><div className="muted"><Link href="/settings/incentives">set on Incentives</Link></div></div>
        <div><label>Shortfall</label><div>{f.targetCents ? money(f.shortfallCents) : "—"}</div><div className="muted">{f.shortfallCents ? "adds pressure on the likeliest large payers" : "no extra pressure"}</div></div>
        <div><label>PayPal payments (Transaction Search)</label><div>{plan.receivedAvailable ? "read" : "unavailable"}</div><div className="muted">a recent payment pauses reminders</div></div>
      </section>
      <p className="muted section-help">{f.confidenceNote}</p>

      <h2>Customers <span className="count">{plan.customers.length}</span></h2>
      {plan.customers.length === 0 && <div className="card muted">No overdue invoices.</div>}
      {plan.customers.map((c) => (
        <article key={c.customer} className="card director-row" data-move={c.move}>
          <div className="director-head">
            <div>
              <div className="inv">{c.customer}</div>
              <div className="muted">
                owes {money(c.openCents)}
                {c.history.paidInvoices ? ` · ${c.history.paidInvoices} paid before, ${c.history.avgDaysLate} days late on average` : " · no payment history yet"}
                {c.history.paymentWeekday !== null ? ` · usually pays on ${WEEKDAYS[c.history.paymentWeekday]}s` : ""}
              </div>
            </div>
            <Meter value={c.pressure} />
          </div>
          <table>
            <thead><tr><th>Invoice</th><th>Due</th><th>Pressure</th><th>Next move</th><th>Day</th><th>Why</th></tr></thead>
            <tbody>
              {c.invoices.map((m) => (
                <tr key={m.invoiceId}>
                  <td><Link href={`/invoices/${m.invoiceId}`}>{m.invoiceNumber ?? m.invoiceId}</Link></td>
                  <td>{money(m.dueCents)}<div className="muted">{m.daysOverdue}d overdue</div></td>
                  <td>{m.pressure}</td>
                  <td><span className={`pill ${MOVE_CLASS[m.move]}`}>{MOVE_LABEL[m.move]}</span></td>
                  <td>{dayLabel(m.day, plan.today)}</td>
                  <td className="muted">{m.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ))}
      <p className="muted footer-note">
        Ladder: wait under {DIRECTOR_PARAMS.waitBelow}, friendly under {DIRECTOR_PARAMS.friendlyBelow}, firm under {DIRECTOR_PARAMS.firmBelow}, then a payment plan if your policy allows one,
        and a final notice at {DIRECTOR_PARAMS.finalNoticeFrom}+ once {DIRECTOR_PARAMS.finalNoticeMinDays}+ days overdue. Same inputs always give the same plan.
      </p>
    </>
  );
}
