import { requirePageSession } from "@/lib/auth-server";
import { getStore } from "@/lib/db";
import { currentPolicy, parsePolicy } from "@/lib/agent/incentives";
import { ESCALATE_AFTER_DAYS, GRACE_DAYS, formatAmount, offerLabel, offerTerms } from "@/lib/agent/policy";
import { currentRulesVersion } from "@/lib/agent/rules-version";
import PolicyForm from "./PolicyForm";

export const dynamic = "force-dynamic";

function fmtTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.KAIROS_TIMEZONE || "America/Los_Angeles" }).format(new Date(iso));
}

export default async function IncentivesPage() {
  await requirePageSession("/settings/incentives");
  const current = await currentPolicy();
  const history = (await getStore().listIncentivePolicies(10)).map((row) => ({ row, parsed: parsePolicy(row) }));
  const rulesVersion = await currentRulesVersion();
  const p = current.policy;
  const examples = ["640.00", "2350.00"].map((a) => ({ amount: a, offer: offerTerms(a, "USD", p) }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Incentives</h1>
          <p className="muted subtitle">
            What Kairos may offer a customer who is behind on an invoice. You set the limits; code decides which invoices qualify and writes the exact terms. The drafter can only choose to include your offer or not.
          </p>
        </div>
      </div>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Pay in parts</h2>
        <p className="muted">
          Lets the customer pay an overdue invoice in parts through PayPal (PayPal partial payments). It is not an automatic installment plan: nothing is charged on a schedule, the customer chooses when to pay each part.
          When you approve a reminder that includes the offer, Kairos turns on partial payments for that invoice with the minimum below, then sends the reminder with one fixed sentence, for example:
        </p>
        <blockquote className="muted">You can pay this invoice in up to 3 parts of at least $783.34 each.</blockquote>
        <p className="muted">
          No offer is made on invoices whose text was flagged as suspicious (for example a note asking for a discount). Saving a change makes reminders already waiting for approval stale: re-run the agent to redraft them under the new policy.
        </p>
        <PolicyForm initial={p} initialCashTarget={current.director.cashTarget14d} minDays={GRACE_DAYS} maxDays={ESCALATE_AFTER_DAYS} />
      </section>

      <section className="card stats" style={{ marginTop: 16 }}>
        <div><label>Status</label><div>{p.enabled ? <span className="pill ok">On</span> : <span className="pill">Off</span>}</div><div className="muted">{current.version ? `version ${current.version}, saved ${fmtTime(current.savedAt!)}` : "never saved (off by default)"}</div></div>
        {examples.map((e) => (
          <div key={e.amount}><label>Example: {formatAmount(e.amount, "USD")} due</label><div>{e.offer ? offerLabel(e.offer) : "no offer"}</div><div className="muted">if it meets the amount and days limits</div></div>
        ))}
        <div><label>Rules version</label><div>{rulesVersion}</div><div className="muted">code + this policy</div></div>
      </section>

      <h2>History</h2>
      {history.length === 0 ? <div className="card muted">No versions saved yet.</div> : (
        <div className="card">
          <table>
            <thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Pay in parts</th></tr></thead>
            <tbody>
              {history.map(({ row, parsed }) => {
                const q = parsed.policy;
                return (
                  <tr key={row.version}>
                    <td>{row.version}</td>
                    <td>{fmtTime(row.createdAt)}</td>
                    <td>{row.actor}</td>
                    <td>{q.enabled ? `on · invoices from ${formatAmount(String(q.minInvoiceAmount), "USD")}, ${q.minDaysOverdue}+ days overdue · up to ${q.maxParts} parts of at least ${formatAmount(String(q.minPaymentAmount), "USD")}` : "off"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted footer-note">Versions are append-only and every save is in the audit log. Early-payment discounts are not offered yet.</p>
    </>
  );
}
