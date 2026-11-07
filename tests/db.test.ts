import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDraft, openStoreForTesting } from "../lib/db";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tempDb = () => join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kairos-db-")), "test.db");

async function seed() {
  const path = tempDb();
  const store = openStoreForTesting(path);
  const run = await store.createRun({ invoices: ["INV2-A"] });
  const p = await store.createProposal({
    runId: run.id, invoiceId: "INV2-A", kind: "reminder", tone: "friendly", subject: "Reminder", note: "Invoice 0001 is overdue.",
  });
  return { path, store, run, p };
}

test("migrations are idempotent across reopen", async () => {
  const { path, store } = await seed();
  await store.close();
  const again = openStoreForTesting(path);
  assert.equal((await again.listRuns()).length, 1);
  await again.close();
});

test("proposal draft hash matches hashDraft and content is immutable", async () => {
  const { path, store, p } = await seed();
  assert.equal(p.draftHash, hashDraft(p));
  assert.equal(p.status, "pending_review");

  const raw = new Database(path);
  assert.throws(() => raw.prepare("UPDATE proposals SET note = 'Take 20% off!' WHERE id = ?").run(p.id), /immutable/);
  assert.throws(() => raw.prepare("DELETE FROM proposals WHERE id = ?").run(p.id), /cannot be deleted/);
  raw.close();

  // Status may change, with compare-and-set.
  assert.equal(await store.updateProposalStatus(p.id, { status: "passed", review: { ok: true } }, ["pending_review"]), true);
  assert.equal(await store.updateProposalStatus(p.id, { status: "passed" }, ["pending_review"]), false);
  await store.close();
});

test("revision is a new row for the same invoice", async () => {
  const { store, run, p } = await seed();
  const r1 = await store.createProposal({ runId: run.id, parentId: p.id, invoiceId: "INV2-A", kind: "reminder", tone: "firm", subject: "S", note: "N" });
  assert.equal(r1.revision, 1);
  assert.notEqual(r1.draftHash, p.draftHash);
  await assert.rejects(
    store.createProposal({ runId: run.id, parentId: p.id, invoiceId: "INV2-OTHER", kind: "reminder", tone: "x", subject: "S", note: "N" }),
    /same invoice/,
  );
  await store.close();
});

test("reminder proposals require subject and note", async () => {
  const { store, run } = await seed();
  await assert.rejects(store.createProposal({ runId: run.id, invoiceId: "INV2-A", kind: "reminder", tone: null, subject: null, note: null }));
  const esc = await store.createProposal({ runId: run.id, invoiceId: "INV2-A", kind: "escalate", tone: null, subject: null, note: null, status: "escalated", reason: "dispute mentioned" });
  assert.equal(esc.status, "escalated");
  await store.close();
});

test("approval tokens: stored hashed, single claim, expiry, burn once", async () => {
  const { path, store, p } = await seed();
  await store.updateProposalStatus(p.id, { status: "approved" });
  const token = randomBytes(32).toString("base64url");
  const a = await store.createApproval({ proposalId: p.id, tokenHash: sha(token), draftHash: p.draftHash, approvedBy: "user:test", ttlMs: 15 * 60_000 });

  const raw = new Database(path);
  const rawTokenRows = raw.prepare("SELECT COUNT(*) n FROM approvals WHERE token_hash = ?").get(token) as { n: number };
  assert.equal(rawTokenRows.n, 0, "raw token must never be stored");

  assert.deepEqual(await store.claimApproval(sha("wrong")), { ok: false, reason: "not_found" });
  const claim = await store.claimApproval(sha(token));
  assert.equal(claim.ok, true);
  assert.deepEqual(await store.claimApproval(sha(token)), { ok: false, reason: "in_progress" });

  // Release (send failed), then reclaim.
  await store.releaseApproval(a.id);
  assert.equal((await store.claimApproval(sha(token))).ok, true);

  const entry = await store.recordAgentSend({ approvalId: a.id, proposalId: p.id, invoiceId: "INV2-A", subject: p.subject, note: p.note });
  assert.equal(entry.source, "agent");
  assert.equal((await store.getProposal(p.id))!.status, "sent");
  assert.deepEqual(await store.claimApproval(sha(token)), { ok: false, reason: "already_used" });
  await assert.rejects(store.recordAgentSend({ approvalId: a.id, proposalId: p.id, invoiceId: "INV2-A", subject: null, note: null }));

  assert.throws(() => raw.prepare("UPDATE approvals SET used_at = NULL WHERE id = ?").run(a.id), /already used/);
  assert.throws(() => raw.prepare("UPDATE approvals SET expires_at = '2999-01-01' WHERE id = ?").run(a.id), /immutable/);
  raw.close();
  await store.close();
});

test("expired tokens cannot be claimed", async () => {
  const { store, p } = await seed();
  const token = "t-expired";
  await store.createApproval({ proposalId: p.id, tokenHash: sha(token), draftHash: p.draftHash, approvedBy: "user:test", ttlMs: 15 * 60_000 });
  const later = new Date(Date.now() + 15 * 60_000 + 1);
  assert.deepEqual(await store.claimApproval(sha(token), later), { ok: false, reason: "expired" });
  await store.close();
});

test("recordAgentSend is atomic: nothing is written if the proposal isn't approved", async () => {
  const { store, p } = await seed(); // still pending_review
  const a = await store.createApproval({ proposalId: p.id, tokenHash: sha("t2"), draftHash: p.draftHash, approvedBy: "user:test", ttlMs: 60_000 });
  await store.claimApproval(sha("t2"));
  await assert.rejects(store.recordAgentSend({ approvalId: a.id, proposalId: p.id, invoiceId: "INV2-A", subject: null, note: null }), /approved/);
  assert.equal((await store.listLedger()).length, 0);
  assert.equal(await store.claimApproval(sha("t2")).then((r) => r.ok || r.reason), "in_progress", "token must not be burned by a failed send");
  await store.close();
});

test("ledger and audit log are append-only; ledger queries", async () => {
  const { path, store } = await seed();
  const t0 = new Date();
  await store.recordManualSend({ invoiceId: "INV2-A", subject: null, note: "manual", actor: "user:test" });
  await store.recordManualSend({ invoiceId: "INV2-B", subject: null, note: null, actor: "user:test" });
  assert.equal(await store.countSendsSince(t0), 2);
  assert.equal(await store.countSendsSince(new Date(Date.now() + 1000)), 0);
  assert.equal((await store.lastSendFor("INV2-A"))!.note, "manual");
  assert.equal(await store.lastSendFor("INV2-NONE"), null);

  await store.audit({ actor: "system", event: "test.event", entityType: "invoice", entityId: "INV2-A", data: { n: 1 } });
  const events = await store.listAudit({ entityType: "invoice", entityId: "INV2-A" });
  assert.deepEqual(events.map((e) => e.event), ["test.event", "ledger.send"]);

  const raw = new Database(path);
  assert.throws(() => raw.prepare("UPDATE send_ledger SET note = 'x'").run(), /append-only/);
  assert.throws(() => raw.prepare("DELETE FROM send_ledger").run(), /append-only/);
  assert.throws(() => raw.prepare("UPDATE audit_log SET event = 'x'").run(), /append-only/);
  assert.throws(() => raw.prepare("DELETE FROM audit_log").run(), /append-only/);
  raw.close();
  await store.close();
});

test("run lifecycle", async () => {
  const { store, run } = await seed();
  await store.finishRun(run.id, "completed", { proposals: 1 });
  const done = await store.getRun(run.id);
  assert.equal(done!.status, "completed");
  assert.deepEqual(done!.report, { proposals: 1 });
  await assert.rejects(store.finishRun(run.id, "failed", null), /not running/);
  await store.close();
});
