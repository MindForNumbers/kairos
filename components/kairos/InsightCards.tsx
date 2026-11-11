"use client";

import { useState } from "react";

export type InsightCard = {
  id: string;
  kind: string;
  title: string;
  text: string;
  moneyAtStake: string;
  ask: string | null;
  action: { type: "offer_plan" | "hold"; invoiceId: string; label: string } | null;
};

type State = { busy: boolean; done: string | null; error: string | null };

/**
 * The briefing's insight cards. Numbers and names come from the server (code); the only
 * actions are drafting a reminder for approval and a Kairos-side hold. Nothing is sent.
 */
export default function InsightCards({ cards, onAsk, apiBase = "", disabled }: {
  cards: InsightCard[];
  onAsk: (question: string) => void;
  /** Where the Kairos API lives (empty = same origin). */
  apiBase?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<Record<string, State>>({});
  if (!cards.length) return null;

  async function act(c: InsightCard) {
    if (!c.action) return;
    setState((s) => ({ ...s, [c.id]: { busy: true, done: null, error: null } }));
    try {
      const res = await fetch(`${apiBase}/api/insights/actions`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: c.action.type, invoiceId: c.action.invoiceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
      const done = c.action.type === "hold"
        ? "On hold: Kairos won't draft or send reminders for this invoice until you clear it (Director page)."
        : `${data.result.detail}${data.result.offerIncluded ? " It includes your pay-in-parts offer." : ""}`;
      setState((s) => ({ ...s, [c.id]: { busy: false, done, error: null } }));
    } catch (err) {
      setState((s) => ({ ...s, [c.id]: { busy: false, done: null, error: (err as Error).message } }));
    }
  }

  return (
    <div className="kp-insights" aria-label="Insights">
      {cards.map((c) => {
        const st = state[c.id];
        return (
          <section key={c.id} className="kp-insight" data-kind={c.kind}>
            <div className="kp-insight-head"><strong>{c.title}</strong><span className="kp-insight-money">{c.moneyAtStake}</span></div>
            <p>{c.text}</p>
            {st?.done ? <p className="kp-insight-done" role="status">{st.done}</p> : (
              <div className="kp-chips">
                {c.action && <button className="kp-chip kp-chip-primary" onClick={() => act(c)} disabled={disabled || st?.busy}>{st?.busy ? "Working…" : c.action.label}</button>}
                {c.ask && <button className="kp-chip" title={c.ask} onClick={() => onAsk(c.ask!)} disabled={disabled}>{c.ask}</button>}
              </div>
            )}
            {st?.error && <p className="kp-insight-error" role="alert">{st.error}</p>}
          </section>
        );
      })}
    </div>
  );
}
