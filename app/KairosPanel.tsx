"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The Kairos assistant, docked beside the page (a slide-up drawer on phones).
 * Replies stream in; tool activity shows as small lines; draft requests show a card
 * linking to Approvals. Text is rendered as plain text, never as HTML or links.
 */

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "activity"; id: string; text: string; state: "running" | "ok" | "failed" }
  | { kind: "drafts"; created: number; alreadyWaiting: number; needsYou: number; notDrafted: number }
  | { kind: "error"; text: string };

type Outcome = { invoiceNumber: string | null; outcome: string };
type BriefingChip = { label: string; ask?: string; href?: string };
type Briefing = { text: string; chips: BriefingChip[] };

const SESSION_KEY = "kairos.chat.session";
const readSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } };
const writeSession = (v: string | null) => { try { if (v) localStorage.setItem(SESSION_KEY, v); else localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } };

function draftsCard(outcomes: Outcome[]): Item {
  return {
    kind: "drafts",
    created: outcomes.filter((o) => o.outcome === "passed").length,
    alreadyWaiting: outcomes.filter((o) => o.outcome === "not_drafted:in_queue").length,
    needsYou: outcomes.filter((o) => o.outcome === "blocked" || o.outcome === "escalated" || o.outcome === "not_drafted:needs_human").length,
    notDrafted: outcomes.filter((o) => o.outcome.startsWith("not_drafted:") && !["not_drafted:in_queue", "not_drafted:needs_human"].includes(o.outcome)).length,
  };
}

/** Parse a server-sent-events stream: calls onEvent(name, data) per event. */
async function readSse(res: Response, onEvent: (event: string, data: Record<string, unknown>) => void) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = chunk.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

export default function KairosPanel({ invoiceId = null, invoiceNumber = null }: { invoiceId?: string | null; invoiceNumber?: string | null }) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false); // phone drawer
  const sessionId = useRef<string | null>(null);
  const router = useRouter();
  const listRef = useRef<HTMLDivElement>(null);
  const [briefing, setBriefing] = useState<Briefing | null | "loading" | "failed">(null);

  // Restore the conversation across pages (per-browser convenience; the server owns the transcript).
  useEffect(() => {
    const sid = readSession();
    if (!sid) return;
    sessionId.current = sid;
    fetch(`/api/chat?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages: { role: string; text: string; outcomes?: Outcome[] }[] }) => {
        setItems(d.messages.map((m, n): Item => m.role === "user" ? { kind: "user", text: m.text }
          : m.role === "activity" ? { kind: "activity", id: `h${n}`, text: m.text, state: "ok" }
          : m.role === "drafts" ? draftsCard(m.outcomes ?? [])
          : { kind: "assistant", text: m.text }));
      })
      .catch(() => {});
  }, []);

  // Empty conversation: show the briefing (numbers from code; the server caches the wording).
  const empty = items.length === 0;
  useEffect(() => {
    if (!empty) return;
    let cancelled = false;
    setBriefing("loading");
    fetch("/api/chat/briefing")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b: Briefing) => { if (!cancelled) setBriefing(b); })
      .catch(() => { if (!cancelled) setBriefing("failed"); });
    return () => { cancelled = true; };
  }, [empty]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setInput("");
    setItems((xs) => [...xs, { kind: "user", text: message }]);

    const appendText = (delta: string) => setItems((xs) => {
      const last = xs[xs.length - 1];
      if (last?.kind === "assistant" && last.streaming) return [...xs.slice(0, -1), { ...last, text: last.text + delta }];
      return [...xs, { kind: "assistant", text: delta, streaming: true }];
    });
    const endText = () => setItems((xs) => xs.map((x) => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)));
    // Draft outcomes are shown after Kairos's reply, where the user is looking.
    const outcomes: Outcome[] = [];

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId: sessionId.current, invoiceId }),
      });
      if (!res.ok || !res.body) throw new Error(res.status === 401 ? "Your session expired. Sign in again." : "Kairos couldn't answer just now.");
      await readSse(res, (event, data) => {
        if (event === "text") appendText(String(data.delta));
        else if (event === "tool_start") { endText(); setItems((xs) => [...xs, { kind: "activity", id: String(data.id), text: String(data.summary), state: "running" }]); }
        else if (event === "tool_done") setItems((xs) => xs.map((x) => (x.kind === "activity" && x.id === data.id ? { ...x, state: data.ok ? "ok" : "failed" } : x)));
        else if (event === "proposals") outcomes.push(...(data.items as Outcome[]));
        else if (event === "done") { endText(); sessionId.current = String(data.sessionId); writeSession(sessionId.current); }
        else if (event === "error") setItems((xs) => [...xs, { kind: "error", text: String(data.message) }]);
      });
    } catch (e) {
      setItems((xs) => [...xs, { kind: "error", text: (e as Error).message }]);
    }
    endText();
    if (outcomes.length) {
      setItems((xs) => [...xs, draftsCard(outcomes)]);
      router.refresh(); // home tiles and the Approvals badge pick up the new drafts
    }
    setBusy(false);
  }, [busy, invoiceId, router]);

  const newConversation = () => { sessionId.current = null; writeSession(null); setItems([]); };

  const chips = [
    ...(invoiceId ? [`Explain this invoice${invoiceNumber ? ` (${invoiceNumber})` : ""}`] : []),
    "Who owes me money?",
    "What's overdue?",
    "Draft reminders for overdue invoices",
  ];

  return (
    <>
      <button className="kairos-fab" onClick={() => setOpen(true)} aria-label="Ask Kairos">Ask Kairos</button>
      <aside className={`kairos-panel ${open ? "open" : ""}`} aria-label="Kairos assistant">
        <header className="kp-head">
          <span className="kp-mark" aria-hidden>K</span>
          <div className="kp-title">
            <strong>Kairos</strong>
            <span>{invoiceNumber ? `Looking at ${invoiceNumber}` : "Your invoicing assistant"}</span>
          </div>
          {items.length > 0 && <button className="kp-link" onClick={newConversation} disabled={busy}>New chat</button>}
          <button className="kp-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
        </header>

        <div className="kp-list" ref={listRef} aria-live="polite">
          {items.length === 0 && briefing && typeof briefing === "object" && (
            <div className="kp-welcome kp-briefing">
              <p className="kp-briefing-label">Today&apos;s briefing</p>
              <p>{briefing.text}</p>
              <div className="kp-chips">
                {briefing.chips.map((c) => c.href
                  ? <Link key={c.label} href={c.href} className="kp-chip">{c.label}</Link>
                  : <button key={c.label} className="kp-chip" onClick={() => send(c.ask ?? c.label)} disabled={busy}>{c.label}</button>)}
              </div>
            </div>
          )}
          {items.length === 0 && briefing === "loading" && <div className="kp-activity running"><span className="dot" aria-hidden />Catching up on your invoices…</div>}
          {items.length === 0 && (briefing === "failed" || briefing === null) && (
            <div className="kp-welcome">
              <p>Hi, I&apos;m Kairos. Ask me about your invoices: who owes you, what&apos;s overdue, or what happened to a reminder. I can draft reminders for you to approve.</p>
              <div className="kp-chips">
                {chips.map((c) => <button key={c} className="kp-chip" onClick={() => send(c.replace(/ \(.*\)$/, ""))} disabled={busy}>{c}</button>)}
              </div>
            </div>
          )}
          {items.map((it, n) => {
            if (it.kind === "user") return <div key={n} className="kp-msg kp-user">{it.text}</div>;
            if (it.kind === "assistant") return <div key={n} className={`kp-msg kp-bot ${it.streaming ? "streaming" : ""}`}>{it.text}</div>;
            if (it.kind === "activity") return <div key={n} className={`kp-activity ${it.state}`}><span className="dot" aria-hidden />{it.text}{it.state === "running" ? "…" : it.state === "failed" ? " (failed)" : ""}</div>;
            if (it.kind === "error") return <div key={n} className="kp-msg kp-error">{it.text}</div>;
            const waiting = it.created + it.alreadyWaiting;
            return (
              <div key={n} className="kp-card">
                <div className="kp-card-main">
                  <strong>{waiting} draft{waiting === 1 ? "" : "s"} waiting in Approvals</strong>
                  <span>
                    {it.created > 0 && `${it.created} new`}{it.created > 0 && it.alreadyWaiting > 0 && " · "}{it.alreadyWaiting > 0 && `${it.alreadyWaiting} already there`}
                    {it.needsYou > 0 && ` · ${it.needsYou} need${it.needsYou === 1 ? "s" : ""} you`}{it.notDrafted > 0 && ` · ${it.notDrafted} not drafted`}
                  </span>
                  <span className="kp-card-note">Nothing is sent until you approve.</span>
                </div>
                <Link href="/approvals" className="button primary">Review</Link>
              </div>
            );
          })}
          {busy && items[items.length - 1]?.kind === "user" && <div className="kp-activity running"><span className="dot" aria-hidden />Thinking…</div>}
        </div>

        <form className="kp-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder={invoiceNumber ? `Ask about ${invoiceNumber}…` : "Ask about your invoices…"}
            rows={2}
            maxLength={2000}
            disabled={busy}
          />
          <button className="button primary" disabled={busy || !input.trim()}>Send</button>
        </form>
        <p className="kp-foot">Kairos drafts. Only you approve and send.</p>
      </aside>
      {open && <div className="kp-scrim" onClick={() => setOpen(false)} />}
    </>
  );
}
