"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Item = { name: string; description: string; quantity: string; unitAmount: string; taxPercent: string };
const emptyItem = (): Item => ({ name: "", description: "", quantity: "1", unitAmount: "", taxPercent: "" });

const TERMS = ["DUE_ON_RECEIPT", "NET_10", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90"] as const;

export default function InvoiceForm() {
  const router = useRouter();
  // One key per form instance: a double-click or retry can't create two invoices.
  const [idemKey] = useState(() => crypto.randomUUID());

  // Fixed per form: PayPal rejects a reused number, which is what makes resubmits safe.
  const [invoiceNumber, setInvoiceNumber] = useState("");
  useEffect(() => {
    fetch("/api/invoices/next-number")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.invoiceNumber && setInvoiceNumber((cur) => cur || d.invoiceNumber))
      .catch(() => {});
  }, []);

  const [email, setEmail] = useState("");
  const [givenName, setGivenName] = useState("");
  const [surname, setSurname] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [termType, setTermType] = useState<(typeof TERMS)[number]>("NET_30");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [allowPartialPayment, setAllowPartial] = useState(false);
  const [minimumAmountDue, setMinimum] = useState("");
  const [allowTip, setAllowTip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Display-only estimate; PayPal computes the authoritative total.
  const subtotal = useMemo(
    () => items.reduce((sum, it) => {
      const line = (Number(it.quantity) || 0) * (Number(it.unitAmount) || 0);
      return sum + line * (1 + (Number(it.taxPercent) || 0) / 100);
    }, 0),
    [items],
  );

  const updateItem = (i: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  async function submit(send: boolean) {
    setBusy(true);
    setError(null);
    const opt = (s: string) => (s.trim() ? s.trim() : undefined);
    try {
      const res = await fetch(`/api/invoices${send ? "?send=true" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey },
        body: JSON.stringify({
          currency,
          invoiceNumber: opt(invoiceNumber),
          termType,
          note: opt(note),
          recipient: { email: email.trim(), givenName: opt(givenName), surname: opt(surname) },
          items: items.map((it) => ({
            name: it.name.trim(),
            description: opt(it.description),
            quantity: it.quantity.trim(),
            unitAmount: it.unitAmount.trim(),
            taxPercent: opt(it.taxPercent),
          })),
          allowPartialPayment,
          minimumAmountDue: allowPartialPayment ? opt(minimumAmountDue) : undefined,
          allowTip,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        const msg = body.issues
          ? body.issues.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("\n")
          : `${body.error}: ${body.message ?? ""}${body.debug_id ? `\ndebug_id: ${body.debug_id}` : ""}`;
        throw new Error(msg);
      }
      router.push(`/invoices/${body.id}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      <h2 style={{ marginTop: 0 }}>Bill to</h2>
      <div className="row">
        <div className="field"><label>Email *</label><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label>First name</label><input value={givenName} onChange={(e) => setGivenName(e.target.value)} /></div>
        <div className="field"><label>Last name</label><input value={surname} onChange={(e) => setSurname(e.target.value)} /></div>
      </div>

      <h2>Line items</h2>
      {items.map((it, i) => (
        <div className="row" key={i}>
          <div className="field" style={{ flex: "3 1 200px" }}><label>Item *</label><input required value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} /></div>
          <div className="field"><label>Qty *</label><input required inputMode="decimal" value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })} /></div>
          <div className="field"><label>Unit price *</label><input required inputMode="decimal" placeholder="0.00" value={it.unitAmount} onChange={(e) => updateItem(i, { unitAmount: e.target.value })} /></div>
          <div className="field"><label>Tax %</label><input inputMode="decimal" value={it.taxPercent} onChange={(e) => updateItem(i, { taxPercent: e.target.value })} /></div>
          {items.length > 1 && (
            <div className="field" style={{ flex: "0 0 auto", alignSelf: "end" }}>
              <button type="button" className="button danger" onClick={() => setItems((p) => p.filter((_, j) => j !== i))}>Remove</button>
            </div>
          )}
        </div>
      ))}
      <button type="button" className="button" onClick={() => setItems((p) => [...p, emptyItem()])}>+ Add item</button>

      <h2>Terms</h2>
      <div className="row">
        <div className="field"><label>Invoice #</label><input value={invoiceNumber} placeholder="Auto" onChange={(e) => setInvoiceNumber(e.target.value)} /></div>
        <div className="field"><label>Currency</label><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
        <div className="field">
          <label>Payment terms</label>
          <select value={termType} onChange={(e) => setTermType(e.target.value as (typeof TERMS)[number])}>
            {TERMS.map((t) => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label>Note to recipient</label><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="field"><label className="check"><input type="checkbox" checked={allowTip} onChange={(e) => setAllowTip(e.target.checked)} /> Allow tip</label></div>
      <div className="field"><label className="check"><input type="checkbox" checked={allowPartialPayment} onChange={(e) => setAllowPartial(e.target.checked)} /> Allow partial payments</label></div>
      {allowPartialPayment && (
        <div className="field" style={{ maxWidth: 220 }}><label>Minimum amount due</label><input inputMode="decimal" value={minimumAmountDue} onChange={(e) => setMinimum(e.target.value)} /></div>
      )}

      <p className="muted">Estimated total: {new Intl.NumberFormat("en-US", { style: "currency", currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD" }).format(subtotal)}</p>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" className="button" disabled={busy}>Save draft</button>
        <button type="button" className="button primary" disabled={busy} onClick={(e) => { if (e.currentTarget.form?.reportValidity()) submit(true); }}>Create &amp; send</button>
      </div>
    </form>
  );
}
