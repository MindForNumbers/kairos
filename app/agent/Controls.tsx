"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
  return data;
}

function useCountdown(expiresAt: string | null) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Date.parse(expiresAt) - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function ApproveControls({ proposalId, status, liveExpiresAt, hadExpiredApproval, stale }: {
  proposalId: string; status: string; liveExpiresAt: string | null; hadExpiredApproval: boolean;
  stale: { made: string | null; current: string } | null;
}) {
  const router = useRouter();
  // The bearer token lives only in this component's memory (Stage 6 hands it to the executor).
  const token = useRef<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(liveExpiresAt);
  const [mintedHere, setMintedHere] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = useCountdown(expiresAt);
  const expired = left === 0;

  async function approve() {
    setBusy("approve"); setError(null);
    try {
      const r = await post(`/api/agent/proposals/${proposalId}/approve`);
      token.current = r.token;
      setExpiresAt(r.expiresAt);
      setMintedHere(true);
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

  const approved = expiresAt && !expired;
  if (stale && !approved) {
    return (
      <div className="controls">
        <span className="pill stale">Stale: re-run</span>
        <span className="muted">Drafted under rules {stale.made ?? "(unversioned)"}; current rules are {stale.current}. It can't be approved. Reject it, then run the agent again.</span>
        <button className="button danger" disabled={!!busy} onClick={reject}>Reject</button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }
  return (
    <div className="controls">
      {approved ? (
        <div className="approved">
          <span className="pill ok">Approved</span>
          <span>Token expires in <strong>{left === null ? "…" : mmss(left)}</strong>{mintedHere ? "" : " (minted in another tab)"}</span>
          <span className="muted">Bound to this exact draft · single use · nothing has been sent (executor arrives in Stage 6)</span>
        </div>
      ) : (
        <>
          <button className="button primary" disabled={!!busy} onClick={approve}>
            {busy === "approve" ? "Approving…" : expired || hadExpiredApproval ? "Approve again" : "Approve"}
          </button>
          <button className="button danger" disabled={!!busy} onClick={reject}>Reject</button>
          {(expired || (hadExpiredApproval && status === "approved")) && <span className="muted">Previous approval expired unused.</span>}
        </>
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
