"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ClearHoldButton({ holdId }: { holdId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function clear() {
    if (!confirm("Clear this hold? Kairos may draft reminders for this invoice again.")) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/holds/${encodeURIComponent(holdId)}/clear`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }
  return (
    <>
      <button className="button" onClick={clear} disabled={busy}>{busy ? "Clearing…" : "Clear hold"}</button>
      {error && <span className="error"> {error}</span>}
    </>
  );
}
