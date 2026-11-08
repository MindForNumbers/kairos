import "server-only";
import { getStore, type Proposal } from "@/lib/db";
import { CostCapError, costCaps, createBudget } from "./budget";
import { checkCoverage, checkDraft, decide, type Issue, type KnownInvoice } from "./checks";
import { critique, type CriticResult } from "./critic";
import { draft, type Draft, type DraftBatch, type RevisionFeedback } from "./drafter";
import { planFor, type DraftPlan } from "./policy";
import { RULES_VERSION } from "./rules-version";
import { sweep, type InvoiceRecord, type SweepResult } from "./sweep";

/**
 * One agent run: sweep → draft → (critic + code checks → revise)* → proposals.
 *   fail a/d/e → revise (max MAX_REVISIONS)
 *   fail b/c, critic failure, or no verdict → block (goes to "Needs a human")
 * Nothing here sends anything. Passed proposals wait for a human in the approval queue.
 */

export const MAX_REVISIONS = 2;

export type PipelineHooks = {
  /** Test/demo seam: transform drafter output before review (e.g. fault injection). */
  afterDraft?: (round: number, batch: DraftBatch, records: InvoiceRecord[]) => DraftBatch;
  /** Test seam: replace the PayPal sweep with a fixture. */
  sweep?: () => Promise<SweepResult>;
};

export type TraceEntry = {
  round: number;
  invoiceId: string;
  invoiceNumber: string | null;
  proposalId: string;
  subject: string;
  note: string;
  code: Issue[];
  critic: Issue[] | "no verdict" | "critic failed";
  decision: "passed" | "revise" | "blocked";
  reason: string | null;
};

export type InvoiceOutcome = {
  invoiceId: string;
  invoiceNumber: string | null;
  outcome: "passed" | "blocked" | "escalated";
  proposalId: string;
  reason: string | null;
};

export type RunReport = {
  runId: string;
  sweep: Pick<SweepResult, "asOf" | "today" | "counts"> & { candidates: string[]; deferred: string[]; excluded: SweepResult["excluded"] };
  rounds: number;
  trace: TraceEntry[];
  coverageIssues: { round: number; issues: Issue[] }[];
  outcomes: InvoiceOutcome[];
  urgencyWarnings: CriticResult["urgencyWarnings"];
  models: { drafter: string[]; critic: string[] };
  cost: { totalUsd: number; byPurpose: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>; caps: { runUsd: number; dailyUsd: number } };
  /** Set when a spend cap stopped the run. Unreviewed drafts were blocked. */
  halted: { cap: "run" | "daily"; message: string } | null;
  /** Rules fingerprint every proposal in this run was stamped with. */
  rulesVersion: string;
};

function knownInvoices(s: SweepResult): KnownInvoice[] {
  const fromRecord = (r: InvoiceRecord): KnownInvoice => ({
    invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, amountDue: r.amountDue, currency: r.currency,
    recipientEmail: r.recipientEmail, recipientName: r.untrusted.recipientName,
  });
  return [
    ...s.candidates.map(fromRecord),
    ...s.deferred.map(fromRecord),
    ...s.excluded.map((e) => ({ invoiceId: e.invoiceId, invoiceNumber: e.invoiceNumber, amountDue: null, currency: "USD", recipientEmail: null, recipientName: null })),
    ...s.openNotDue.map((o) => ({ invoiceId: o.invoiceId, invoiceNumber: o.invoiceNumber, amountDue: o.amountDue, currency: "USD", recipientEmail: null, recipientName: null })),
  ];
}

export async function runAgent(hooks: PipelineHooks = {}): Promise<RunReport> {
  const store = getStore();
  const s = await (hooks.sweep ?? sweep)();
  const run = await store.createRun(s);
  const budget = createBudget(run.id);

  // Declared outside try so a cost-cap halt can still report what happened.
  const current = new Map<string, { proposal: Proposal; draft: Draft | null }>();
  const settled = new Map<string, InvoiceOutcome>();
  const trace: TraceEntry[] = [];
  const coverageIssues: RunReport["coverageIssues"] = [];
  const urgencyWarnings: RunReport["urgencyWarnings"] = [];
  const models = { drafter: new Set<string>(), critic: new Set<string>() };
  let round = 0;
  let halted: RunReport["halted"] = null;
  const plans = s.candidates.map(planFor);
  const recordById = new Map(s.candidates.map((r) => [r.invoiceId, r]));
  const numberOf = (id: string) => recordById.get(id)?.invoiceNumber ?? null;

  const buildReport = async (): Promise<RunReport> => ({
    runId: run.id,
    sweep: { asOf: s.asOf, today: s.today, counts: s.counts, candidates: s.candidates.map((c) => c.invoiceId), deferred: s.deferred.map((c) => c.invoiceId), excluded: s.excluded },
    rounds: round + 1,
    trace,
    coverageIssues,
    outcomes: plans.map((p) => settled.get(p.invoiceId)!).filter(Boolean),
    urgencyWarnings,
    models: { drafter: [...models.drafter], critic: [...models.critic] },
    cost: { ...(await store.modelSpendForRun(run.id)), caps: costCaps() },
    halted,
    rulesVersion: RULES_VERSION,
  });

  try {
    const planById = new Map(plans.map((p) => [p.invoiceId, p]));
    const known = knownInvoices(s);

    const persist = async (batch: DraftBatch) => {
      if (batch.meta) models.drafter.add(batch.meta.model);
      for (const d of batch.drafts) {
        const parent = current.get(d.invoiceId)?.proposal;
        const p = await store.createProposal({ runId: run.id, parentId: parent?.id ?? null, invoiceId: d.invoiceId, kind: "reminder", tone: d.tone, subject: d.subject, note: d.note, rulesVersion: RULES_VERSION });
        if (parent) await store.updateProposalStatus(parent.id, { status: "revised" }, ["pending_review"]);
        current.set(d.invoiceId, { proposal: p, draft: d });
      }
      for (const e of batch.escalations) {
        const parent = current.get(e.invoiceId)?.proposal;
        const reason = `${e.source === "policy" ? "Policy" : "Drafter"}: ${e.reason}`;
        const p = await store.createProposal({ runId: run.id, parentId: parent?.id ?? null, invoiceId: e.invoiceId, kind: "escalate", tone: null, subject: null, note: null, status: "escalated", reason, rulesVersion: RULES_VERSION });
        if (parent) await store.updateProposalStatus(parent.id, { status: "revised" }, ["pending_review"]);
        current.set(e.invoiceId, { proposal: p, draft: null });
        settled.set(e.invoiceId, { invoiceId: e.invoiceId, invoiceNumber: numberOf(e.invoiceId), outcome: "escalated", proposalId: p.id, reason });
      }
    };

    const settle = async (id: string, outcome: "passed" | "blocked", reason: string | null, review: unknown) => {
      const p = current.get(id)!.proposal;
      const ok = await store.updateProposalStatus(p.id, { status: outcome, reason, review }, ["pending_review"]);
      if (!ok) throw new Error(`proposal ${p.id} was not pending_review`);
      settled.set(id, { invoiceId: id, invoiceNumber: numberOf(id), outcome, proposalId: p.id, reason });
    };

    let batch = await draft(s.candidates, { budget });
    batch = hooks.afterDraft?.(0, batch, s.candidates) ?? batch;
    await persist(batch);

    for (; ; round++) {
      const underReview = [...current.values()]
        .filter((c) => c.draft && !settled.has(c.proposal.invoiceId) && c.proposal.status === "pending_review")
        .map((c) => c.draft!);

      let critic: CriticResult | null = null;
      if (underReview.length) {
        critic = await critique({
          records: s.candidates, plans, deferred: s.deferred, underReview, alreadyCovered: [...settled.keys()],
        }, round, budget);
        models.critic.add(critic.meta.model);
        if (round === 0) urgencyWarnings.push(...critic.urgencyWarnings);
      }

      const toRevise = new Map<string, Issue[]>();
      for (const d of underReview) {
        const plan = planById.get(d.invoiceId) as Extract<DraftPlan, { action: "draft" }>;
        const code = checkDraft(d, plan, known);
        const verdict: TraceEntry["critic"] = !critic || critic.failure ? "critic failed" : critic.verdicts.get(d.invoiceId) ?? "no verdict";
        const issues = [...code, ...(Array.isArray(verdict) ? verdict : [])];
        const review = { round, code, critic: verdict, criticModel: critic?.meta.model ?? null, criticRequestId: critic?.meta.requestId ?? null };

        const { decision, reason } = decide(code, verdict, critic?.failure ?? null);

        trace.push({ round, invoiceId: d.invoiceId, invoiceNumber: numberOf(d.invoiceId), proposalId: current.get(d.invoiceId)!.proposal.id,
          subject: d.subject, note: d.note, code, critic: verdict, decision, reason });

        if (decision === "revise") {
          toRevise.set(d.invoiceId, issues);
          await store.updateProposalStatus(current.get(d.invoiceId)!.proposal.id, { status: "pending_review", review }, ["pending_review"]);
        } else {
          await settle(d.invoiceId, decision, reason, review);
        }
      }

      // (e) coverage: code is exact; critic claims are accepted only for real, uncovered invoices.
      const covered = new Set([...settled.keys(), ...underReview.map((d) => d.invoiceId)]);
      const omitted = new Map<string, Issue[]>();
      for (const { invoiceId, issue } of checkCoverage(plans, covered)) omitted.set(invoiceId, [issue]);
      if (critic && !critic.failure) {
        critic.omittedIds.forEach((id, i) => omitted.set(id, [...(omitted.get(id) ?? []), critic!.omitted[i]]));
      }
      if (omitted.size) coverageIssues.push({ round, issues: [...omitted.values()].flat() });
      for (const [id, issues] of omitted) if (!settled.has(id) && !toRevise.has(id)) toRevise.set(id, issues);

      if (!toRevise.size) break;

      if (round >= MAX_REVISIONS) {
        for (const [id, issues] of toRevise) {
          const reason = `Still failing after ${MAX_REVISIONS} revisions: ${issues.map((i) => `(${i.check}) ${i.problem}`).join("; ")}`;
          if (current.get(id)?.draft) {
            await settle(id, "blocked", reason, { round, final: issues });
          } else {
            await persist({ drafts: [], escalations: [{ invoiceId: id, source: "drafter", reason }], missing: [], dropped: [], meta: null, failure: null });
          }
        }
        break;
      }

      // Revise: only a/d/e problems are fed back (b/c never get a second chance).
      const feedback: RevisionFeedback[] = [...toRevise].map(([invoiceId, issues]) => ({
        invoiceId, issues: issues.filter((i) => i.check === "a" || i.check === "d" || i.check === "e").map(({ check, problem }) => ({ check, problem })),
      }));
      batch = await draft(s.candidates.filter((r) => toRevise.has(r.invoiceId)), { feedback, budget });
      batch = hooks.afterDraft?.(round + 1, batch, s.candidates) ?? batch;
      await persist(batch);
    }

    const report = await buildReport();
    await store.finishRun(run.id, "completed", report);
    await store.audit({ actor: "system", event: "run.completed", entityType: "run", entityId: run.id,
      data: { outcomes: report.outcomes.map((o) => ({ id: o.invoiceId, outcome: o.outcome })), rounds: report.rounds, urgencyWarnings, costUsd: report.cost.totalUsd } });
    return report;
  } catch (err) {
    if (err instanceof CostCapError) {
      // Halt: nothing unreviewed may linger as pending_review (it would block the invoice forever).
      halted = { cap: err.cap, message: err.message };
      for (const [id, c] of current) {
        if (settled.has(id) || c.proposal.status !== "pending_review") continue;
        const reason = `Run halted before review finished: ${err.message}`;
        if (await store.updateProposalStatus(c.proposal.id, { status: "blocked", reason }, ["pending_review"])) {
          settled.set(id, { invoiceId: id, invoiceNumber: numberOf(id), outcome: "blocked", proposalId: c.proposal.id, reason });
        }
      }
      const report = await buildReport();
      await store.finishRun(run.id, "failed", report);
      await store.audit({ actor: "system", event: "run.halted", entityType: "run", entityId: run.id, data: { cap: err.cap, message: err.message, costUsd: report.cost.totalUsd } });
      return report;
    }
    await store.finishRun(run.id, "failed", { error: String(err) });
    await store.audit({ actor: "system", event: "run.failed", entityType: "run", entityId: run.id, data: { error: String(err) } });
    throw err;
  }
}
