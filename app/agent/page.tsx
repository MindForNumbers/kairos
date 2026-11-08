import Link from "next/link";
import { requirePageSession } from "@/lib/auth-server";
import { daysBetween, isOverridden, localDate, nowIso, startOfLocalDay } from "@/lib/clock";
import { getStore, type Proposal, type Run } from "@/lib/db";
import type { Issue } from "@/lib/agent/checks";
import { CHECK_LABELS } from "@/lib/agent/checks";
import { formatAmount, formatDueDate } from "@/lib/agent/policy";
import type { InvoiceRecord, SweepResult } from "@/lib/agent/sweep";
import type { RunReport } from "@/lib/agent/pipeline";
import { costCaps } from "@/lib/agent/budget";
import { isStale, liveApproval } from "@/lib/queue/actions";
import { RULES_VERSION } from "@/lib/agent/rules-version";
import { ApproveControls, ResolveControls } from "./Controls";

export const dynamic = "force-dynamic";

type Review = { round?: number; code?: Issue[]; critic?: Issue[] | string; criticModel?: string | null; final?: Issue[] };

const TONE_LABEL: Record<string, string> = { friendly: "Friendly", firm: "Firm", final_notice: "Final notice" };

export default async function AgentPage() {
  await requirePageSession("/agent");
  const store = getStore();

  const [queue, human, closed, runs] = await Promise.all([
    store.listProposals({ status: ["passed", "approved"] }),
    store.listProposals({ status: ["blocked", "escalated"] }),
    store.listProposals({ status: ["rejected", "sent", "skipped", "blocked", "escalated"] }),
    store.listRuns(1),
  ]);
  const needsHuman = human.filter((p) => !p.resolution);
  const recentlyClosed = closed.filter((p) => !["blocked", "escalated"].includes(p.status) || p.resolution).slice(0, 10);

  // Invoice records come from the sweep of the run that produced each proposal.
  const runCache = new Map<string, Run | null>();
  const recordFor = async (p: Proposal): Promise<InvoiceRecord | null> => {
    if (!runCache.has(p.runId)) runCache.set(p.runId, await store.getRun(p.runId));
    const sweep = runCache.get(p.runId)?.sweep as SweepResult | undefined;
    return sweep?.candidates.find((c) => c.invoiceId === p.invoiceId) ?? null;
  };
  const historyFor = async (p: Proposal) => {
    const out: { revision: number; review: Review | null }[] = [];
    for (let cur = p.parentId ? await store.getProposal(p.parentId) : null; cur; cur = cur.parentId ? await store.getProposal(cur.parentId) : null) {
      out.push({ revision: cur.revision, review: cur.review as Review | null });
    }
    return out;
  };

  const today = localDate();
  const now = nowIso();
  const lastRun = runs[0];
  const report = lastRun?.report as RunReport | null;
  const caps = costCaps();
  const spentToday = await store.modelSpendSince(startOfLocalDay());

  const queueCards = await Promise.all(queue.map(async (p) => ({ p, rec: await recordFor(p), history: await historyFor(p), approvals: await store.listApprovals(p.id) })));
  const humanCards = await Promise.all(needsHuman.map(async (p) => ({ p, rec: await recordFor(p), history: await historyFor(p) })));
  const closedRows = await Promise.all(recentlyClosed.map(async (p) => ({ p, rec: await recordFor(p) })));

  return (
    <>
      <div className="page-head">
        <h1>Collections agent</h1>
        {isOverridden() && <span className="badge">Clock override (KAIROS_NOW): today is {today}</span>}
      </div>

      <section className="card stats">
        <div><label>Last run</label>{lastRun ? <><div>{fmtTime(lastRun.startedAt)}</div><div className="muted">{lastRun.status}{report?.halted ? ` · halted (${report.halted.cap} cap)` : ""}</div></> : <div className="muted">No runs yet</div>}</div>
        <div><label>Last run cost</label><div>{report?.cost ? `$${report.cost.totalUsd.toFixed(4)}` : "—"}</div><div className="muted">cap ${caps.runUsd.toFixed(2)} per run</div></div>
        <div><label>Spent today</label><div>${spentToday.toFixed(4)}</div><div className="muted">cap ${caps.dailyUsd.toFixed(2)} per day</div></div>
        <div><label>Models</label><div>{report?.models ? `${report.models.drafter.join(", ")} → ${report.models.critic.join(", ")}` : "—"}</div><div className="muted">drafter → critic</div></div>
        <div><label>Rules version</label><div data-rules-version={RULES_VERSION}>{RULES_VERSION}</div><div className="muted">drafts from other versions are stale</div></div>
      </section>

      <h2>Approval queue <span className="count">{queueCards.length}</span></h2>
      <p className="muted section-help">Drafts that passed both the critic and the code checks. Approving mints a single-use token bound to this exact draft, valid for 15 minutes. Nothing is sent from this page yet (the executor is Stage 6).</p>
      {queueCards.length === 0 && <div className="card muted">Nothing waiting for approval.</div>}
      {queueCards.map(({ p, rec, history, approvals }) => {
        const live = liveApproval(approvals, now);
        return (
          <article key={p.id} className="card proposal">
            <InvoiceHeader p={p} rec={rec} today={today} />
            <Draft p={p} />
            <Checks review={p.review as Review | null} />
            {history.length > 0 && <History history={history} />}
            <ApproveControls
              proposalId={p.id}
              status={p.status}
              liveExpiresAt={live?.expiresAt ?? null}
              hadExpiredApproval={p.status === "approved" && !live}
              stale={isStale(p) ? { made: p.rulesVersion, current: RULES_VERSION } : null}
            />
          </article>
        );
      })}

      <h2>Needs a human <span className="count">{humanCards.length}</span></h2>
      <p className="muted section-help">Blocked by a check, escalated by policy, or escalated by the drafter. These invoices are held out of agent runs until you resolve or dismiss them. Either one makes the invoice eligible for the next run.</p>
      {humanCards.length === 0 && <div className="card muted">Nothing needs a human.</div>}
      {humanCards.map(({ p, rec, history }) => (
        <article key={p.id} className="card proposal human">
          <InvoiceHeader p={p} rec={rec} today={today} />
          <p className="reason"><strong>{p.status === "escalated" ? "Escalated" : "Blocked"}:</strong> {p.reason}</p>
          {p.kind === "reminder" && <Draft p={p} />}
          {p.kind === "reminder" && <Checks review={p.review as Review | null} />}
          {history.length > 0 && <History history={history} />}
          {rec && (rec.flags.length > 0 || rec.untrusted.note) && (
            <div className="untrusted">
              <label>Invoice note (customer-visible text, shown as data)</label>
              {rec.flags.length > 0 && <div className="flags">{rec.flags.map((f) => <span key={f} className="pill warn">{f.replaceAll("_", " ")}</span>)}</div>}
              {rec.untrusted.note && <blockquote>{rec.untrusted.note}</blockquote>}
            </div>
          )}
          <ResolveControls proposalId={p.id} />
        </article>
      ))}

      <h2>Recently closed</h2>
      {closedRows.length === 0 ? <div className="card muted">Nothing closed yet.</div> : (
        <div className="card">
          <table>
            <thead><tr><th>Invoice</th><th>Outcome</th><th>By</th><th>When</th><th>Note</th></tr></thead>
            <tbody>
              {closedRows.map(({ p, rec }) => (
                <tr key={p.id}>
                  <td>{rec?.invoiceNumber ?? p.invoiceId}</td>
                  <td><span className={`status status-${p.resolution ? "CANCELLED" : p.status.toUpperCase()}`}>{p.resolution ? `${p.resolution.action} (${p.status})` : p.status}</span></td>
                  <td>{p.resolution?.actor ?? "—"}</td>
                  <td>{fmtTime(p.resolution?.at ?? p.updatedAt)}</td>
                  <td className="muted">{p.resolution?.note ?? (p.status === "rejected" ? p.reason : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted footer-note">Run the agent with <code>npm run agent:run</code>. Every decision on this page is written to the audit log.</p>
    </>
  );
}

function fmtTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.KAIROS_TIMEZONE || "America/Los_Angeles" }).format(new Date(iso));
}

function InvoiceHeader({ p, rec, today }: { p: Proposal; rec: InvoiceRecord | null; today: string }) {
  const days = rec ? daysBetween(rec.dueDate, today) : null;
  return (
    <header className="proposal-head">
      <div>
        <div className="inv">
          <Link href={`/invoices/${p.invoiceId}`}>{rec?.invoiceNumber ?? p.invoiceId}</Link>
          {p.tone && <span className={`pill tone-${p.tone}`}>{TONE_LABEL[p.tone] ?? p.tone}</span>}
          {p.revision > 0 && <span className="pill">revision {p.revision}</span>}
          {p.kind === "reminder" && ["passed", "approved"].includes(p.status) && isStale(p) && <span className="pill stale">stale: re-run</span>}
        </div>
        <div className="muted">{rec?.recipientEmail ?? "—"}</div>
      </div>
      {rec && (
        <div className="amount">
          <div>{formatAmount(rec.amountDue ?? "0", rec.currency)}</div>
          <div className="muted">due {formatDueDate(rec.dueDate)}{days !== null && days > 0 ? ` · ${days}d overdue` : ""}</div>
        </div>
      )}
    </header>
  );
}

function Draft({ p }: { p: Proposal }) {
  return (
    <div className="draft">
      <div className="subject"><label>Subject</label>{p.subject}</div>
      <div className="note"><label>Note PayPal will email</label><div className="note-text">{p.note}</div></div>
    </div>
  );
}

function Checks({ review }: { review: Review | null }) {
  if (!review) return null;
  const code = review.code ?? [];
  const critic = Array.isArray(review.critic) ? review.critic : null;
  const rows = (["a", "b", "c", "d"] as const).map((k) => ({
    k,
    code: code.filter((i) => i.check === k),
    critic: critic ? critic.filter((i) => i.check === k) : null,
  }));
  return (
    <div className="checks">
      <table>
        <thead><tr><th>Check</th><th>Code</th><th>Critic{review.criticModel ? ` (${review.criticModel})` : ""}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td><strong>{r.k}</strong> <span className="muted">{CHECK_LABELS[r.k]}</span></td>
              <td>{r.code.length ? r.code.map((i, j) => <div key={j} className="fail">✗ {i.problem}</div>) : <span className="ok">✓</span>}</td>
              <td>{r.critic === null ? <span className="fail">⚠ {String(review.critic ?? "not run")}</span> : r.critic.length ? r.critic.map((i, j) => <div key={j} className="fail">✗ {i.problem}</div>) : <span className="ok">✓</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History({ history }: { history: { revision: number; review: Review | null }[] }) {
  return (
    <details className="history">
      <summary>Earlier revisions ({history.length})</summary>
      {history.map((h) => {
        const issues = [...(h.review?.code ?? []), ...(Array.isArray(h.review?.critic) ? h.review!.critic as Issue[] : [])];
        return (
          <div key={h.revision} className="muted">
            Revision {h.revision} failed: {issues.length ? issues.map((i) => `(${i.check}, ${i.source}) ${i.problem}`).join("; ") : "no recorded issues"}
          </div>
        );
      })}
    </details>
  );
}
