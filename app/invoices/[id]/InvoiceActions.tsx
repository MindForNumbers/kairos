"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const OPEN = ["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING"];
const METHODS = ["BANK_TRANSFER", "CHECK", "CASH", "WIRE_TRANSFER", "CREDIT_CARD", "DEBIT_CARD", "PAYPAL", "OTHER"];

export default function InvoiceActions({ id, status, dueAmount }: { id: string; status: string; dueAmount?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [payment, setPayment] = useState({
    method: "BANK_TRANSFER",
    amount: dueAmount ?? "",
    paymentDate: new Date().toISOString().slice(0, 10),
    note: "",
  });

  async function call(action: string, init: RequestInit, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(action === "delete" ? `/api/invoices/${id}` : `/api/invoices/${id}/${action}`, {
        ...init,
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        // Manual reminders: limits warn, the human decides.
        if (action === "remind" && b.error === "NEEDS_CONFIRMATION") {
          if (confirm(`Send anyway?\n\n• ${b.warnings.join("\n• ")}`)) {
            setBusy(null);
            return call(action, post({ ...JSON.parse(String(init.body ?? "{}")), confirm: true }));
          }
          return;
        }
        throw new Error(`${b.error ?? res.status}: ${b.message ?? ""}${b.debug_id ? `\ndebug_id: ${b.debug_id}` : ""}`);
      }
      if (action === "delete") {
        router.push("/");
      } else {
        setShowPayment(false);
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

  return (
    <>
      <div className="actions">
        {status === "DRAFT" && (
          <>
            <button className="button primary" disabled={!!busy} onClick={() => call("send", post())}>{busy === "send" ? "Sending…" : "Send invoice"}</button>
            <button className="button danger" disabled={!!busy} onClick={() => call("delete", { method: "DELETE" }, "Delete this draft?")}>Delete draft</button>
          </>
        )}
        {OPEN.includes(status) && (
          <>
            <button className="button" disabled={!!busy} onClick={() => call("remind", post())}>{busy === "remind" ? "Sending…" : "Send reminder"}</button>
            <button className="button" disabled={!!busy} onClick={() => setShowPayment((v) => !v)}>Record payment</button>
            <button className="button danger" disabled={!!busy} onClick={() => call("cancel", post(), "Cancel this invoice? The recipient will be notified.")}>Cancel invoice</button>
          </>
        )}
      </div>

      {showPayment && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); call("payments", post({ ...payment, note: payment.note || undefined })); }}>
          <div className="row">
            <div className="field">
              <label>Method</label>
              <select value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}>
                {METHODS.map((m) => <option key={m} value={m}>{m.replaceAll("_", " ")}</option>)}
              </select>
            </div>
            <div className="field"><label>Amount</label><input required inputMode="decimal" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} /></div>
            <div className="field"><label>Date</label><input required type="date" value={payment.paymentDate} onChange={(e) => setPayment({ ...payment, paymentDate: e.target.value })} /></div>
          </div>
          <div className="field"><label>Note</label><input value={payment.note} onChange={(e) => setPayment({ ...payment, note: e.target.value })} /></div>
          <button className="button primary" disabled={!!busy}>{busy === "payments" ? "Saving…" : "Save payment"}</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
