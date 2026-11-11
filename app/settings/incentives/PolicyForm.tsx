"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Policy = { enabled: boolean; minInvoiceAmount: number; minDaysOverdue: number; maxParts: number; minPaymentAmount: number };

export default function PolicyForm({ initial, minDays, maxDays }: { initial: Policy; minDays: number; maxDays: number }) {
  const router = useRouter();
  const [p, setP] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const num = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value === "" ? NaN : Number(e.target.value) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/settings/incentives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentPlan: p }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const issues = (data.issues as { path: string[]; message: string }[] | undefined)?.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
        throw new Error(issues || data.message || data.error || `HTTP ${res.status}`);
      }
      setMsg({ ok: true, text: `Saved as version ${data.version}.${data.draftsMadeStale ? " Reminders waiting for approval are now stale; re-run the agent." : ""}` });
      router.refresh();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
    setBusy(false);
  }

  return (
    <form onSubmit={save} className="policy-form">
      <div className="field">
        <label className="checkbox"><input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} /> Offer to let customers pay in parts</label>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="minInvoiceAmount">Minimum amount due ($)</label><input id="minInvoiceAmount" type="number" min={0} step="0.01" value={Number.isNaN(p.minInvoiceAmount) ? "" : p.minInvoiceAmount} onChange={num("minInvoiceAmount")} required /></div>
        <div className="field"><label htmlFor="minDaysOverdue">Minimum days overdue</label><input id="minDaysOverdue" type="number" min={minDays} max={maxDays} step={1} value={Number.isNaN(p.minDaysOverdue) ? "" : p.minDaysOverdue} onChange={num("minDaysOverdue")} required /></div>
        <div className="field"><label htmlFor="maxParts">Maximum number of parts</label><input id="maxParts" type="number" min={2} max={12} step={1} value={Number.isNaN(p.maxParts) ? "" : p.maxParts} onChange={num("maxParts")} required /></div>
        <div className="field"><label htmlFor="minPaymentAmount">Minimum payment per part ($)</label><input id="minPaymentAmount" type="number" min={1} step="0.01" value={Number.isNaN(p.minPaymentAmount) ? "" : p.minPaymentAmount} onChange={num("minPaymentAmount")} required /></div>
      </div>
      <p className="muted">Invoices over {maxDays} days overdue always go to a human, so offers apply between {minDays} and {maxDays} days.</p>
      <button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save new version"}</button>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
    </form>
  );
}
