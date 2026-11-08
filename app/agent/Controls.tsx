"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
  return data;
}

type Step = { name: string; ok: boolean; detail: string };
type Execution = {
  outcome: "sent" | "dry_run" | "deferred" | "skipped" | "failed" | "unknown" | "rejected" | "blocked";
  reason: string;
  steps: Step[];
  request: { method: string; path: string; body: { subject: string; note: string } } | null;
  tokenReleased: boolean;
  debugId?: string;
};

const OUTCOME: Record<Execution["outcome"], { label: string; cls: string }> = {
  sent: { label: "Sent", cls: "ok" },
  dry_run: { label: "Dry run: not sent", cls: "warn" },
  deferred: { label: "Deferred: not sent", cls: "warn" },
  skipped: { label: "Skipped: not sent", cls: "" },
  failed: { label: "Failed: not sent", cls: "stale" },
  unknown: { label: "Outcome UNKNOWN", cls: "stale" },
  rejected: { label: "Token rejected", cls: "stale" },
  blocked: { label: "Blocked", cls: "stale" },
};

export function ApproveControls({ proposalId, inFlight, live, stale }: {
  proposalId: string;
  /** The executor holds a claimed token: a send in progress, or one whose outcome is unknown. */
  inFlight: boolean;
  /** KAIROS_EXECUTOR_ENABLED=1 */
  live: boolean;
  stale: { made: string | null; current: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Execution | null>(null);

  async function approve() {
    if (live && !confirm("Send this reminder to the customer through PayPal now?")) return;
    setBusy("approve"); setError(null); setResult(null);
    try {
      // One click: the server mints the token and hands it to the executor; it never reaches the browser.
      const r = await post(`/api/agent/proposals/${proposalId}/approve`);
      setResult(r.execution);
      // Outcomes that move the card out of the queue: refresh after the user has seen them.
      if (["sent", "skipped", "unknown", "blocked"].includes(r.execution.outcome)) setTimeout(() => router.refresh(), 4000);
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  }

  async function reject() {
    const note = prompt("Reject this draft? Optional note for the audit log:");
    if (note === null) return;
    setBusy("reject"); setError(null);
    try { await post(`/api/agent/proposals/${proposalId}/reject`, { note }); router.refresh(); }
    catch (e) { setError((e as Error).message); setBusy(null); }
  }

  if (stale) {
    return (
      <div className="controls">
        <span className="pill stale">Stale: re-run</span>
        <span className="muted">Drafted under rules {stale.made ?? "(unversioned)"}; current rules are {stale.current}. It can't be approved. Reject it, then run the agent again.</span>
        <button className="button danger" disabled={!!busy} onClick={reject}>Reject</button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }
  if (inFlight) {
    return (
      <div className="controls">
        <span className="pill stale">Send in progress or outcome unknown</span>
        <span className="muted">The executor holds this draft&apos;s token. If this persists, check the invoice&apos;s history in PayPal; the token expires on its own.</span>
      </div>
    );
  }
  const finalOutcome = result && ["sent", "skipped", "unknown", "blocked"].includes(result.outcome);
  return (
    <div className="controls-wrap">
      {!finalOutcome && (
        <div className="controls">
          <button className="button primary" disabled={!!busy} onClick={approve}>
            {busy === "approve" ? (live ? "Sending…" : "Checking…") : live ? "Approve & send" : "Approve (dry run)"}
          </button>
          <button className="button danger" disabled={!!busy} onClick={reject}>Reject</button>
        </div>
      )}
      {result && (
        <div className="execution">
          <div className="execution-head">
            <span className={`pill ${OUTCOME[result.outcome].cls}`}>{OUTCOME[result.outcome].label}</span>
            <span>{result.reason}</span>
          </div>
          <ol className="steps">
            {result.steps.map((s, i) => (
              <li key={i} className={s.ok ? "ok-step" : "fail-step"}><strong>{s.ok ? "✓" : "✗"} {s.name.replaceAll("_", " ")}</strong> <span className="muted">{s.detail}</span></li>
            ))}
          </ol>
          {result.request && result.outcome === "dry_run" && (
            <details className="request" open>
              <summary>The request the executor would send</summary>
              <pre>{`${result.request.method} ${result.request.path}\n${JSON.stringify(result.request.body, null, 2)}`}</pre>
            </details>
          )}
          <div className="muted">Token {result.tokenReleased ? "released (nothing was sent)" : result.outcome === "sent" ? "used and burned" : "kept claimed"}{result.debugId ? ` · PayPal debug_id ${result.debugId}` : ""}</div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function ResolveControls({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"resolved" | "dismissed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "resolved" | "dismissed") {
    setBusy(action); setError(null);
    try { await post(`/api/agent/proposals/${proposalId}/resolve`, { action, note: note.trim() || undefined }); router.refresh(); }
    catch (e) { setError((e as Error).message); setBusy(null); }
  }

  return (
    <div className="controls resolve">
      <input placeholder="Note for the audit log (optional), e.g. called the customer" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      <button className="button primary" disabled={!!busy} onClick={() => act("resolved")} title="You handled it outside Kairos">
        {busy === "resolved" ? "Saving…" : "Resolve"}
      </button>
      <button className="button" disabled={!!busy} onClick={() => act("dismissed")} title="No action needed">
        {busy === "dismissed" ? "Saving…" : "Dismiss"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
