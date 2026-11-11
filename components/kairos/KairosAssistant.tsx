"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InsightCards, { type InsightCard } from "./InsightCards";
import "./kairos.css";

/**
 * The Kairos assistant as a self-contained React component that a host business dashboard can
 * mount. No framework imports (only React and fetch): the host passes navigation and refresh
 * callbacks. Styles are scoped under .kairos-root (./kairos.css) and neutral by default.
 *
 * It talks to the Kairos API with the browser's Kairos session cookie:
 *   GET  {apiBase}/api/chat/briefing           the opening briefing + insight cards
 *   GET  {apiBase}/api/chat?sessionId=…         restore a conversation
 *   POST {apiBase}/api/chat/stream              a chat turn (server-sent events)
 *   POST {apiBase}/api/insights/actions         "Offer payment plan" / "Hold reminder"
 * Replies render as plain text, never as HTML or links. Nothing here can send, approve or
 * change an invoice: only the owner does that, on the Approvals page.
 */

export type KairosAssistantProps = {
  /** Where the Kairos API is served. "" = same origin (the default; see README for cross-origin hosts). */
  apiBase?: string;
  /** The invoice the user is looking at in the host, if any ("this invoice" in questions). */
  context?: { invoiceId: string; invoiceNumber?: string | null } | null;
  /** "docked": a sidebar beside the page (a drawer on phones). "inline": fills its container. */
  layout?: "docked" | "inline";
  /** Host routing for Kairos pages ("/approvals", "/director"). Default: a full page load of apiBase + path. */
  onNavigate?: (path: string) => void;
  /** Called after the assistant created drafts, so the host can refresh its own counts. */
  onDraftsCreated?: () => void;
  /** localStorage key for resuming the conversation (per browser). */
  storageKey?: string;
  /** Force a theme; default follows the system. */
  theme?: "light" | "dark";
  title?: string;
  className?: string;
};

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "activity"; id: string; text: string; state: "running" | "ok" | "failed" }
  | { kind: "drafts"; created: number; alreadyWaiting: number; needsYou: number; notDrafted: number }
  | { kind: "error"; text: string };

type Outcome = { invoiceNumber: string | null; outcome: string };
type BriefingChip = { label: string; ask?: string; href?: string };
type Briefing = { text: string; chips: BriefingChip[]; cards?: InsightCard[] };

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

export default function KairosAssistant({
  apiBase = "", context = null, layout = "docked", onNavigate, onDraftsCreated,
  storageKey = "kairos.chat.session", theme, title = "Kairos", className = "",
}: KairosAssistantProps) {
  const invoiceId = context?.invoiceId ?? null;
  const invoiceNumber = context?.invoiceNumber ?? null;
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false); // phone drawer (docked layout)
  const sessionId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [briefing, setBriefing] = useState<Briefing | null | "loading" | "failed">(null);

  const readSession = useCallback(() => { try { return localStorage.getItem(storageKey); } catch { return null; } }, [storageKey]);
  const writeSession = useCallback((v: string | null) => {
    try { if (v) localStorage.setItem(storageKey, v); else localStorage.removeItem(storageKey); } catch { /* private mode */ }
  }, [storageKey]);
  const navigate = useCallback((path: string) => (onNavigate ? onNavigate(path) : window.location.assign(`${apiBase}${path}`)), [onNavigate, apiBase]);
  const api = useCallback((path: string, init?: RequestInit) => fetch(`${apiBase}${path}`, { credentials: "include", ...init }), [apiBase]);

  // Restore the conversation (per-browser convenience; the server owns the transcript).
  useEffect(() => {
    const sid = readSession();
    if (!sid) return;
    sessionId.current = sid;
    api(`/api/chat?sessionId=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages: { role: string; text: string; outcomes?: Outcome[] }[] }) => {
        setItems(d.messages.map((m, n): Item => m.role === "user" ? { kind: "user", text: m.text }
          : m.role === "activity" ? { kind: "activity", id: `h${n}`, text: m.text, state: "ok" }
          : m.role === "drafts" ? draftsCard(m.outcomes ?? [])
          : { kind: "assistant", text: m.text }));
      })
      .catch(() => {});
  }, [api, readSession]);

  // Empty conversation: show the briefing (numbers from code; the server caches the wording).
  const empty = items.length === 0;
  useEffect(() => {
    if (!empty) return;
    let cancelled = false;
    setBriefing("loading");
    api("/api/chat/briefing")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b: Briefing) => { if (!cancelled) setBriefing(b); })
      .catch(() => { if (!cancelled) setBriefing("failed"); });
    return () => { cancelled = true; };
  }, [empty, api]);

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
    const outcomes: Outcome[] = [];

    try {
      const res = await api("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId: sessionId.current, invoiceId }),
      });
      if (!res.ok || !res.body) throw new Error(res.status === 401 ? "Your Kairos session expired. Sign in again." : "Kairos couldn't answer just now.");
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
      onDraftsCreated?.();
    }
    setBusy(false);
  }, [busy, invoiceId, api, writeSession, onDraftsCreated]);

  const newConversation = () => { sessionId.current = null; writeSession(null); setItems([]); };

  const chips = [
    ...(invoiceId ? [`Explain this invoice${invoiceNumber ? ` (${invoiceNumber})` : ""}`] : []),
    "Who owes me money?",
    "Who should I focus on this week, and why?",
    "Draft reminders for overdue invoices",
  ];

  return (
    <div className={`kairos-root kairos-${layout} ${className}`.trim()} data-kairos-theme={theme}>
      {layout === "docked" && <button className="kairos-fab" onClick={() => setOpen(true)} aria-label={`Ask ${title}`}>Ask {title}</button>}
      <aside className={`kairos-panel ${open ? "open" : ""}`} aria-label={`${title} assistant`}>
        <header className="kp-head">
          <span className="kp-mark" aria-hidden>K</span>
          <div className="kp-title">
            <strong>{title}</strong>
            <span>{invoiceNumber ? `Looking at ${invoiceNumber}` : "Your invoicing assistant"}</span>
          </div>
          {items.length > 0 && <button className="kp-link" onClick={newConversation} disabled={busy}>New chat</button>}
          {layout === "docked" && <button className="kp-close" onClick={() => setOpen(false)} aria-label="Close">×</button>}
        </header>

        <div className="kp-list" ref={listRef} aria-live="polite">
          {items.length === 0 && briefing && typeof briefing === "object" && (
            <div className="kp-welcome kp-briefing">
              <p className="kp-briefing-label">Today&apos;s briefing</p>
              <p>{briefing.text}</p>
              <div className="kp-chips">
                {briefing.chips.map((c) => c.href
                  ? <button key={c.label} className="kp-chip" title={c.label} onClick={() => navigate(c.href!)}>{c.label}</button>
                  : <button key={c.label} className="kp-chip" title={c.label} onClick={() => send(c.ask ?? c.label)} disabled={busy}>{c.label}</button>)}
              </div>
              <InsightCards cards={briefing.cards ?? []} onAsk={(q) => send(q)} apiBase={apiBase} disabled={busy} />
            </div>
          )}
          {items.length === 0 && briefing === "loading" && <div className="kp-activity running"><span className="dot" aria-hidden />Catching up on your invoices…</div>}
          {items.length === 0 && (briefing === "failed" || briefing === null) && (
            <div className="kp-welcome">
              <p>Hi, I&apos;m {title}. Ask me about your invoices: who owes you, what&apos;s overdue, or what happened to a reminder. I can draft reminders for you to approve.</p>
              <div className="kp-chips">
                {chips.map((c) => <button key={c} className="kp-chip" title={c} onClick={() => send(c.replace(/ \(.*\)$/, ""))} disabled={busy}>{c}</button>)}
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
                <button className="kp-button" onClick={() => navigate("/approvals")}>Review</button>
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
            aria-label={`Message ${title}`}
            rows={2}
            maxLength={2000}
            disabled={busy}
          />
          <button className="kp-button" disabled={busy || !input.trim()}>Send</button>
        </form>
        <p className="kp-foot">{title} drafts. Only you approve and send.</p>
      </aside>
      {layout === "docked" && open && <div className="kp-scrim" onClick={() => setOpen(false)} />}
    </div>
  );
}
