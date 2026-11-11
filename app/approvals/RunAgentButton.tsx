"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Summary = {
  candidates: number; passed: number; blocked: number; escalated: number; rounds: number; costUsd: number;
  excluded: { invoiceNumber: string | null; reason: string }[];
  halted: { cap: string; message: string } | null;
};

const REASON: Record<string, string> = { in_queue: "already awaiting approval", needs_human: "waiting on you", grace_period: "in the 3-day grace period", cooldown: "reminded in the last 7 days", director_wait: "the Director says wait", director_scheduled: "the Director scheduled it for a later day" };

export default function RunAgentButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch("/api/agent/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      setResult(data);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const byReason = result ? Object.entries(result.excluded.reduce<Record<string, string[]>>((m, e) => ((m[e.reason] ??= []).push(e.invoiceNumber ?? "?"), m), {})) : [];
  return (
    <div className="run-agent">
      <button className="button primary" onClick={run} disabled={busy}>{busy ? "Running… (drafting and reviewing)" : "Run agent"}</button>
      {result && (
        <div className="run-result">
          {result.halted ? <span className="pill stale">Halted: {result.halted.cap} spend cap</span>
            : result.candidates === 0 ? <span className="pill">Nothing new to draft</span>
            : <span className="pill ok">Done</span>}
          <span>
            {result.candidates > 0 && <>{result.passed} ready for approval · {result.blocked} blocked · {result.escalated} escalated · </>}
            {result.rounds > 1 && <>{result.rounds} rounds · </>}${result.costUsd.toFixed(4)}
          </span>
          {byReason.length > 0 && <span className="muted">Skipped: {byReason.map(([r, ns]) => `${ns.join(", ")} (${REASON[r] ?? r})`).join("; ")}</span>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
