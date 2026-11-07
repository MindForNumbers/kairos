import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { now as clockNow, nowIso } from "../clock";
import { hashDraft } from "./draft-hash";
import type {
  Approval, AuditEvent, ClaimResult, LedgerEntry, Proposal, ProposalStatus, Run, Store,
} from "./types";

// Each entry runs once, in order; PRAGMA user_version records progress.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id          TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    sweep       TEXT NOT NULL,
    report      TEXT
  );

  CREATE TABLE proposals (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    parent_id   TEXT REFERENCES proposals(id),
    revision    INTEGER NOT NULL DEFAULT 0,
    invoice_id  TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('reminder','escalate')),
    tone        TEXT,
    subject     TEXT,
    note        TEXT,
    draft_hash  TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending_review','revised','passed','blocked','escalated','approved','sent','skipped','rejected')),
    reason      TEXT,
    review      TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK (kind = 'escalate' OR (subject IS NOT NULL AND note IS NOT NULL))
  );
  CREATE INDEX proposals_status  ON proposals(status);
  CREATE INDEX proposals_invoice ON proposals(invoice_id);
  CREATE INDEX proposals_run     ON proposals(run_id);

  -- Content is immutable: a revision is a new row.
  CREATE TRIGGER proposals_content_immutable BEFORE UPDATE ON proposals
  WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.parent_id IS NOT OLD.parent_id
    OR NEW.revision IS NOT OLD.revision OR NEW.invoice_id IS NOT OLD.invoice_id OR NEW.kind IS NOT OLD.kind
    OR NEW.tone IS NOT OLD.tone OR NEW.subject IS NOT OLD.subject OR NEW.note IS NOT OLD.note
    OR NEW.draft_hash IS NOT OLD.draft_hash OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'proposal content is immutable'); END;
  CREATE TRIGGER proposals_no_delete BEFORE DELETE ON proposals
  BEGIN SELECT RAISE(ABORT, 'proposals cannot be deleted'); END;

  CREATE TABLE approvals (
    id          TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES proposals(id),
    token_hash  TEXT NOT NULL UNIQUE,
    draft_hash  TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    claimed_at  TEXT,
    used_at     TEXT
  );
  CREATE INDEX approvals_proposal ON approvals(proposal_id);

  -- Only claimed_at/used_at may change, and a burned token stays burned.
  CREATE TRIGGER approvals_immutable BEFORE UPDATE ON approvals
  WHEN NEW.id IS NOT OLD.id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.token_hash IS NOT OLD.token_hash
    OR NEW.draft_hash IS NOT OLD.draft_hash OR NEW.approved_by IS NOT OLD.approved_by
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at)
    OR (OLD.used_at IS NOT NULL AND NEW.claimed_at IS NOT OLD.claimed_at)
  BEGIN SELECT RAISE(ABORT, 'approval is immutable or already used'); END;
  CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
  BEGIN SELECT RAISE(ABORT, 'approvals cannot be deleted'); END;

  CREATE TABLE send_ledger (
    id          TEXT PRIMARY KEY,
    invoice_id  TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('agent','manual')),
    proposal_id TEXT REFERENCES proposals(id),
    approval_id TEXT UNIQUE REFERENCES approvals(id),
    subject     TEXT,
    note        TEXT,
    actor       TEXT NOT NULL,
    sent_at     TEXT NOT NULL,
    CHECK (source = 'manual' OR (proposal_id IS NOT NULL AND approval_id IS NOT NULL))
  );
  CREATE INDEX send_ledger_invoice ON send_ledger(invoice_id, sent_at);
  CREATE INDEX send_ledger_sent_at ON send_ledger(sent_at);
  CREATE TRIGGER send_ledger_no_update BEFORE UPDATE ON send_ledger
  BEGIN SELECT RAISE(ABORT, 'send_ledger is append-only'); END;
  CREATE TRIGGER send_ledger_no_delete BEFORE DELETE ON send_ledger
  BEGIN SELECT RAISE(ABORT, 'send_ledger is append-only'); END;

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    event       TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    data        TEXT
  );
  CREATE INDEX audit_entity ON audit_log(entity_type, entity_id);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
  `
  CREATE TABLE model_calls (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    at                 TEXT NOT NULL,
    run_id             TEXT REFERENCES runs(id),
    purpose            TEXT NOT NULL,
    model              TEXT NOT NULL,
    request_id         TEXT,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd           REAL NOT NULL CHECK (cost_usd >= 0)
  );
  CREATE INDEX model_calls_at  ON model_calls(at);
  CREATE INDEX model_calls_run ON model_calls(run_id);
  CREATE TRIGGER model_calls_no_update BEFORE UPDATE ON model_calls
  BEGIN SELECT RAISE(ABORT, 'model_calls is append-only'); END;
  CREATE TRIGGER model_calls_no_delete BEFORE DELETE ON model_calls
  BEGIN SELECT RAISE(ABORT, 'model_calls is append-only'); END;
  `,
];

const now = nowIso;
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const unjson = (s: string | null) => (s == null ? null : JSON.parse(s));

type Row = Record<string, unknown>;

const toRun = (r: Row): Run => ({
  id: r.id as string, startedAt: r.started_at as string, finishedAt: r.finished_at as string | null,
  status: r.status as Run["status"], sweep: unjson(r.sweep as string), report: unjson(r.report as string | null),
});

const toProposal = (r: Row): Proposal => ({
  id: r.id as string, runId: r.run_id as string, parentId: r.parent_id as string | null, revision: r.revision as number,
  invoiceId: r.invoice_id as string, kind: r.kind as Proposal["kind"], tone: r.tone as string | null,
  subject: r.subject as string | null, note: r.note as string | null, draftHash: r.draft_hash as string,
  status: r.status as ProposalStatus, reason: r.reason as string | null, review: unjson(r.review as string | null),
  createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});

const toApproval = (r: Row): Approval => ({
  id: r.id as string, proposalId: r.proposal_id as string, draftHash: r.draft_hash as string,
  approvedBy: r.approved_by as string, createdAt: r.created_at as string, expiresAt: r.expires_at as string,
  claimedAt: r.claimed_at as string | null, usedAt: r.used_at as string | null,
});

const toLedger = (r: Row): LedgerEntry => ({
  id: r.id as string, invoiceId: r.invoice_id as string, source: r.source as LedgerEntry["source"],
  proposalId: r.proposal_id as string | null, approvalId: r.approval_id as string | null,
  subject: r.subject as string | null, note: r.note as string | null, actor: r.actor as string, sentAt: r.sent_at as string,
});

const toAudit = (r: Row): AuditEvent => ({
  id: r.id as number, at: r.at as string, actor: r.actor as string, event: r.event as string,
  entityType: r.entity_type as string | null, entityId: r.entity_id as string | null, data: unjson(r.data as string | null),
});

export function openSqliteStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }

  const insertAudit = db.prepare(
    "INSERT INTO audit_log (at, actor, event, entity_type, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const writeAudit = (e: Omit<AuditEvent, "id" | "at">) =>
    insertAudit.run(now(), e.actor, e.event, e.entityType, e.entityId, json(e.data));

  const getProposalRow = db.prepare("SELECT * FROM proposals WHERE id = ?");

  const store: Store = {
    async createRun(sweep) {
      const run = { id: id("run"), startedAt: now() };
      db.prepare("INSERT INTO runs (id, started_at, status, sweep) VALUES (?, ?, 'running', ?)").run(run.id, run.startedAt, json(sweep));
      return toRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as Row);
    },

    async finishRun(runId, status, report) {
      const res = db.prepare("UPDATE runs SET status = ?, report = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .run(status, json(report), now(), runId);
      if (res.changes !== 1) throw new Error(`run ${runId} is not running`);
    },

    async getRun(runId) {
      const r = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row | undefined;
      return r ? toRun(r) : null;
    },

    async listRuns(limit = 20) {
      return (db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map(toRun);
    },

    async createProposal(input) {
      const content = { invoiceId: input.invoiceId, kind: input.kind, tone: input.tone, subject: input.subject, note: input.note };
      const parent = input.parentId ? (getProposalRow.get(input.parentId) as Row | undefined) : undefined;
      if (input.parentId && !parent) throw new Error(`parent proposal ${input.parentId} not found`);
      if (parent && parent.invoice_id !== input.invoiceId) throw new Error("a revision must target the same invoice as its parent");
      const ts = now();
      const pid = id("prp");
      db.prepare(`INSERT INTO proposals
        (id, run_id, parent_id, revision, invoice_id, kind, tone, subject, note, draft_hash, status, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        pid, input.runId, input.parentId ?? null, parent ? (parent.revision as number) + 1 : 0,
        content.invoiceId, content.kind, content.tone, content.subject, content.note, hashDraft(content),
        input.status ?? "pending_review", input.reason ?? null, ts, ts,
      );
      return toProposal(getProposalRow.get(pid) as Row);
    },

    async updateProposalStatus(pid, patch, expected) {
      const sets = ["status = @status", "updated_at = @ts"];
      if (patch.reason !== undefined) sets.push("reason = @reason");
      if (patch.review !== undefined) sets.push("review = @review");
      let sql = `UPDATE proposals SET ${sets.join(", ")} WHERE id = @id`;
      const params: Record<string, unknown> = { id: pid, status: patch.status, ts: now(), reason: patch.reason ?? null, review: json(patch.review) };
      if (expected?.length) {
        sql += ` AND status IN (${expected.map((_, i) => `@e${i}`).join(", ")})`;
        expected.forEach((s, i) => (params[`e${i}`] = s));
      }
      return db.prepare(sql).run(params).changes === 1;
    },

    async getProposal(pid) {
      const r = getProposalRow.get(pid) as Row | undefined;
      return r ? toProposal(r) : null;
    },

    async listProposals(filter = {}) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.status?.length) {
        where.push(`status IN (${filter.status.map((_, i) => `@s${i}`).join(", ")})`);
        filter.status.forEach((s, i) => (params[`s${i}`] = s));
      }
      if (filter.runId) { where.push("run_id = @runId"); params.runId = filter.runId; }
      if (filter.invoiceId) { where.push("invoice_id = @invoiceId"); params.invoiceId = filter.invoiceId; }
      const sql = `SELECT * FROM proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
      return (db.prepare(sql).all(params) as Row[]).map(toProposal);
    },

    async createApproval(input) {
      const ts = clockNow();
      const aid = id("apr");
      db.prepare(`INSERT INTO approvals (id, proposal_id, token_hash, draft_hash, approved_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        aid, input.proposalId, input.tokenHash, input.draftHash, input.approvedBy,
        ts.toISOString(), new Date(ts.getTime() + input.ttlMs).toISOString(),
      );
      return toApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(aid) as Row);
    },

    async claimApproval(tokenHash, at = clockNow()) {
      return db.transaction((): ClaimResult => {
        const r = db.prepare("SELECT * FROM approvals WHERE token_hash = ?").get(tokenHash) as Row | undefined;
        if (!r) return { ok: false, reason: "not_found" };
        const a = toApproval(r);
        if (a.usedAt) return { ok: false, reason: "already_used" };
        if (a.expiresAt <= at.toISOString()) return { ok: false, reason: "expired" };
        // A stale claim is never auto-released: we can't know whether PayPal accepted the send.
        if (a.claimedAt) return { ok: false, reason: "in_progress" };
        const res = db.prepare("UPDATE approvals SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND used_at IS NULL")
          .run(at.toISOString(), a.id);
        if (res.changes !== 1) return { ok: false, reason: "in_progress" };
        return { ok: true, approval: { ...a, claimedAt: at.toISOString() } };
      }).immediate();
    },

    async releaseApproval(approvalId) {
      db.prepare("UPDATE approvals SET claimed_at = NULL WHERE id = ? AND used_at IS NULL").run(approvalId);
    },

    async recordAgentSend(input) {
      return db.transaction(() => {
        const ts = now();
        const burned = db.prepare(
          "UPDATE approvals SET used_at = ? WHERE id = ? AND proposal_id = ? AND claimed_at IS NOT NULL AND used_at IS NULL",
        ).run(ts, input.approvalId, input.proposalId);
        if (burned.changes !== 1) throw new Error("approval is not claimed, already used, or belongs to another proposal");

        const moved = db.prepare("UPDATE proposals SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'approved' AND invoice_id = ?")
          .run(ts, input.proposalId, input.invoiceId);
        if (moved.changes !== 1) throw new Error("proposal is not in 'approved' state for this invoice");

        const lid = id("snd");
        db.prepare(`INSERT INTO send_ledger (id, invoice_id, source, proposal_id, approval_id, subject, note, actor, sent_at)
          VALUES (?, ?, 'agent', ?, ?, ?, ?, 'executor', ?)`).run(lid, input.invoiceId, input.proposalId, input.approvalId, input.subject, input.note, ts);
        writeAudit({ actor: "executor", event: "ledger.send", entityType: "invoice", entityId: input.invoiceId,
          data: { ledgerId: lid, proposalId: input.proposalId, approvalId: input.approvalId, source: "agent" } });
        return toLedger(db.prepare("SELECT * FROM send_ledger WHERE id = ?").get(lid) as Row);
      }).immediate();
    },

    async recordManualSend(input) {
      return db.transaction(() => {
        const lid = id("snd");
        db.prepare(`INSERT INTO send_ledger (id, invoice_id, source, subject, note, actor, sent_at)
          VALUES (?, ?, 'manual', ?, ?, ?, ?)`).run(lid, input.invoiceId, input.subject, input.note, input.actor, now());
        writeAudit({ actor: input.actor, event: "ledger.send", entityType: "invoice", entityId: input.invoiceId,
          data: { ledgerId: lid, source: "manual" } });
        return toLedger(db.prepare("SELECT * FROM send_ledger WHERE id = ?").get(lid) as Row);
      }).immediate();
    },

    async lastSendFor(invoiceId) {
      const r = db.prepare("SELECT * FROM send_ledger WHERE invoice_id = ? ORDER BY sent_at DESC LIMIT 1").get(invoiceId) as Row | undefined;
      return r ? toLedger(r) : null;
    },

    async countSendsSince(since) {
      return (db.prepare("SELECT COUNT(*) n FROM send_ledger WHERE sent_at >= ?").get(since.toISOString()) as { n: number }).n;
    },

    async listLedger(filter = {}) {
      const rows = filter.invoiceId
        ? db.prepare("SELECT * FROM send_ledger WHERE invoice_id = ? ORDER BY sent_at DESC LIMIT ?").all(filter.invoiceId, filter.limit ?? 100)
        : db.prepare("SELECT * FROM send_ledger ORDER BY sent_at DESC LIMIT ?").all(filter.limit ?? 100);
      return (rows as Row[]).map(toLedger);
    },

    async recordModelCall(c) {
      db.prepare(`INSERT INTO model_calls (at, run_id, purpose, model, request_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(now(), c.runId, c.purpose, c.model, c.requestId, c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens, c.costUsd);
    },

    async modelSpendSince(since) {
      return (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) s FROM model_calls WHERE at >= ?").get(since.toISOString()) as { s: number }).s;
    },

    async modelSpendForRun(runId) {
      const rows = db.prepare(`SELECT purpose, COUNT(*) calls, SUM(cost_usd) cost, SUM(input_tokens) i, SUM(output_tokens) o
        FROM model_calls WHERE run_id = ? GROUP BY purpose`).all(runId) as { purpose: string; calls: number; cost: number; i: number; o: number }[];
      const byPurpose = Object.fromEntries(rows.map((r) => [r.purpose, { calls: r.calls, costUsd: r.cost, inputTokens: r.i, outputTokens: r.o }]));
      return { totalUsd: rows.reduce((s, r) => s + r.cost, 0), byPurpose };
    },

    async audit(e) {
      writeAudit(e);
    },

    async listAudit(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.entityType) { where.push("entity_type = ?"); params.push(filter.entityType); }
      if (filter.entityId) { where.push("entity_id = ?"); params.push(filter.entityId); }
      params.push(filter.limit ?? 200);
      const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
      return (db.prepare(sql).all(...params) as Row[]).map(toAudit);
    },

    async close() {
      db.close();
    },
  };
  return store;
}
