import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createSessionValue, checkPassword, passwordConfigured, safeNext, sameOrigin, verifySessionValue } from "../lib/auth";
import { APPROVAL_TTL_MS, QueueError, approveProposal, hashToken, rejectProposal, resolveProposal } from "../lib/queue/actions";
import { setClockForTesting } from "../lib/clock";
import { holdingProposal } from "../lib/agent/sweep";
import { RULES_VERSION as CODE_RULES_VERSION, rulesVersionFor } from "../lib/agent/rules-version";
import { OFFERS_OFF } from "../lib/agent/policy";
/** The current rules version with no policy saved (offers off). */
const RULES_VERSION = rulesVersionFor(OFFERS_OFF);
import { isolate, loadReplay, reset } from "./helpers";

const fx = loadReplay();
afterEach(() => { reset(); delete process.env.KAIROS_ADMIN_PASSWORD; });

async function seedQueue() {
  const store = isolate("2026-11-07T17:00:00Z");
  const run = await store.createRun(fx.sweep);
  const mk = (n: string, status: "passed" | "blocked" | "escalated") => {
    const r = fx.sweep.candidates.find((c) => c.invoiceNumber === n)!;
    return store.createProposal(status === "escalated"
      ? { runId: run.id, invoiceId: r.invoiceId, kind: "escalate", tone: null, subject: null, note: null, status, reason: "Policy: 75 days", rulesVersion: RULES_VERSION }
      : { runId: run.id, invoiceId: r.invoiceId, kind: "reminder", tone: "firm", subject: `Re ${n}`, note: `Pay ${n}`, status, rulesVersion: RULES_VERSION });
  };
  return { store, passed: await mk("DEMO-08", "passed"), blocked: await mk("DEMO-05", "blocked"), escalated: await mk("DEMO-07", "escalated") };
}

test("auth: password must be 12+ chars; constant-time check", () => {
  process.env.KAIROS_ADMIN_PASSWORD = "short";
  assert.equal(passwordConfigured(), false);
  assert.equal(checkPassword("short"), false, "too-short password never authenticates");
  process.env.KAIROS_ADMIN_PASSWORD = "correct horse battery";
  assert.equal(checkPassword("correct horse battery"), true);
  assert.equal(checkPassword("correct horse batterY"), false);
});

test("auth: signed sessions; tampering, expiry and password change invalidate them", () => {
  process.env.KAIROS_ADMIN_PASSWORD = "correct horse battery";
  const v = createSessionValue();
  assert.equal(verifySessionValue(v), true);
  assert.equal(verifySessionValue(v.replace(/^\d/, (d) => String((Number(d) + 1) % 10))), false, "edited expiry");
  assert.equal(verifySessionValue(`${v}x`), false);
  assert.equal(verifySessionValue(undefined), false);
  const [, nonce] = v.split(".");
  assert.equal(verifySessionValue(`1.${nonce}.${v.split(".")[2]}`), false, "expired or re-signed");
  process.env.KAIROS_ADMIN_PASSWORD = "a different password";
  assert.equal(verifySessionValue(v), false, "password change signs everyone out");
});

test("auth: same-origin rule for state-changing requests; safe redirects", () => {
  const r = (method: string, headers: Record<string, string>) => new Request("http://localhost:3000/api/x", { method, headers });
  assert.equal(sameOrigin(r("GET", { host: "localhost:3000" })), true);
  assert.equal(sameOrigin(r("POST", { host: "localhost:3000", origin: "http://localhost:3000" })), true);
  assert.equal(sameOrigin(r("POST", { host: "localhost:3000", origin: "https://evil.example" })), false);
  assert.equal(sameOrigin(r("POST", { host: "localhost:3000" })), false, "no Origin/Referer");
  assert.equal(safeNext("/agent?x=1"), "/agent?x=1");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
});

test("approve: mints a token bound to the draft hash; only the hash is stored", async () => {
  const { store, passed } = await seedQueue();
  const { token, approval } = await approveProposal(passed.id, "user:admin");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.equal(approval.draftHash, passed.draftHash);
  assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), APPROVAL_TTL_MS);
  assert.equal((await store.getProposal(passed.id))!.status, "approved");
  const claim = await store.claimApproval(hashToken(token));
  assert.equal(claim.ok, true, "executor can claim with the hash of the token");
  const events = await store.listAudit({ entityType: "proposal", entityId: passed.id });
  assert.ok(events.some((e) => e.event === "approval.minted"));
  assert.ok(!JSON.stringify(events).includes(token), "raw token never reaches the audit log");
});

test("approve: no second approval while the executor holds a claim; escalations and blocked can't be approved", async () => {
  const { store, passed, blocked, escalated } = await seedQueue();
  const first = await approveProposal(passed.id, "user:admin");
  // An unclaimed approval has no holder (one-click: the token never left the server), so it doesn't block.
  const second = await approveProposal(passed.id, "user:admin");
  assert.ok(second.token);
  // A claimed one does: a send is in flight or its outcome is unknown.
  assert.equal((await store.claimApproval(hashToken(first.token))).ok, true);
  await assert.rejects(approveProposal(passed.id, "user:admin"), (e: QueueError) => e.code === "ALREADY_APPROVED");
  await assert.rejects(approveProposal(blocked.id, "user:admin"), (e: QueueError) => e.code === "NOT_APPROVABLE");
  await assert.rejects(approveProposal(escalated.id, "user:admin"), (e: QueueError) => e.code === "NOT_APPROVABLE");
  await assert.rejects(approveProposal("prp_missing", "user:admin"), (e: QueueError) => e.status === 404);
});

test("reject: refused while a send is in flight; allowed once the claim is released", async () => {
  const { store, passed } = await seedQueue();
  const { token, approval } = await approveProposal(passed.id, "user:admin");
  await store.claimApproval(hashToken(token));
  await assert.rejects(rejectProposal(passed.id, "user:admin", null), (e: QueueError) => e.code === "LIVE_APPROVAL");
  await store.releaseApproval(approval.id);
  await rejectProposal(passed.id, "user:admin", "tone is off");
  const p = (await store.getProposal(passed.id))!;
  assert.equal(p.status, "rejected");
  assert.equal(p.reason, "Rejected: tone is off");
});

test("resolve/dismiss: once, only for blocked/escalated; frees the invoice for the next sweep", async () => {
  const { store, passed, blocked, escalated } = await seedQueue();
  await assert.rejects(resolveProposal(passed.id, "resolved", "user:admin", null), /only blocked or escalated/);
  const r = await resolveProposal(escalated.id, "resolved", "user:admin", "Called the customer");
  assert.deepEqual([r.resolution?.action, r.resolution?.note], ["resolved", "Called the customer"]);
  await assert.rejects(resolveProposal(escalated.id, "dismissed", "user:admin", null), /already resolved/);
  await resolveProposal(blocked.id, "dismissed", "user:admin", null);
  assert.equal((await store.getProposal(blocked.id))!.status, "blocked", "history keeps the original status");
  const raw = (store as unknown as { listProposals: typeof store.listProposals });
  assert.equal((await raw.listProposals({ status: ["blocked", "escalated"] })).filter((p) => !p.resolution).length, 0);
});

test("sweep hold: queued and unresolved items hold their invoice; resolved/dismissed/rejected free it", async () => {
  const { passed, blocked, escalated } = await seedQueue();
  assert.equal((await holdingProposal(passed.invoiceId))?.reason, "in_queue");
  assert.equal((await holdingProposal(escalated.invoiceId))?.reason, "needs_human");
  assert.equal((await holdingProposal(blocked.invoiceId))?.reason, "needs_human");

  await resolveProposal(escalated.id, "dismissed", "user:admin", null);
  assert.equal(await holdingProposal(escalated.invoiceId), null);
  await resolveProposal(blocked.id, "resolved", "user:admin", "handled by phone");
  assert.equal(await holdingProposal(blocked.invoiceId), null);
  await rejectProposal(passed.id, "user:admin", null);
  assert.equal(await holdingProposal(passed.invoiceId), null);
});

test("rules version: stable fingerprint; proposals made under other rules can't be approved", async () => {
  assert.match(CODE_RULES_VERSION, /^r-[0-9a-f]{12}$/);
  assert.match(RULES_VERSION, /^r-[0-9a-f]{12}\.p-[0-9a-f]{8}$/);
  const { store } = await seedQueue();
  const run = (await store.listRuns(1))[0];
  const r = fx.sweep.candidates.find((c) => c.invoiceNumber === "DEMO-04")!;
  const old = await store.createProposal({ runId: run.id, invoiceId: r.invoiceId, kind: "reminder", tone: "friendly", subject: "S", note: "N", status: "passed", rulesVersion: "r-000000000000" });
  const unversioned = await store.createProposal({ runId: run.id, invoiceId: r.invoiceId, kind: "reminder", tone: "friendly", subject: "S2", note: "N2", status: "passed" });
  await assert.rejects(approveProposal(old.id, "user:admin"), (e: QueueError) => e.code === "STALE_RULES");
  await assert.rejects(approveProposal(unversioned.id, "user:admin"), (e: QueueError) => e.code === "STALE_RULES");
  assert.equal((await store.getProposal(old.id))!.status, "passed", "a refused approval changes nothing");
  await rejectProposal(old.id, "user:admin", "stale");
});
