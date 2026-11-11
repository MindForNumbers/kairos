"use client";
/**
 * Kairos's custom AG Studio widgets. Each one renders numbers Kairos already computed (passed in
 * through Studio's `context` property as ReportsData), so they match the chat and briefing to the
 * cent. Read-only: no fetch, no actions. Customer names are customer-entered text; React renders
 * them as text, never HTML.
 */
import type { AgWidgetParams } from "ag-studio";
import type { AgWidgetDefinition } from "ag-studio-react";
import type { ReportsData } from "@/lib/reports/build";

type Params = AgWidgetParams<never, unknown, ReportsData>;

export const usd = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="kr-widget">
      <div className="kr-title">{title}</div>
      {sub && <div className="kr-sub">{sub}</div>}
      <div className="kr-body">{children}</div>
    </div>
  );
}

function Bar({ value, max, tone = "accent", label }: { value: number; max: number; tone?: "accent" | "warn" | "danger" | "muted"; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="kr-bar" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span className={`kr-bar-fill kr-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ForecastWidget({ context: d }: Params) {
  const f = d.forecast;
  const max = Math.max(f.expected, f.target, 1);
  const short = f.target > 0 && f.shortfall > 0;
  return (
    <Shell title={`Cash forecast, next ${f.horizonDays} days`} sub="Probability-weighted, from the Director">
      <div className="kr-big">{usd(f.expected, f.currency)}</div>
      <ul className="kr-list">
        <li>
          <div className="kr-line"><span>Expected</span><span className="kr-num">{usd(f.expected, f.currency)}</span></div>
          <Bar value={f.expected} max={max} label="Expected inflow" />
        </li>
        {f.target > 0 && (
          <li>
            <div className="kr-line"><span>Your target</span><span className="kr-num">{usd(f.target, f.currency)}</span></div>
            <Bar value={f.target} max={max} tone="muted" label="Cash target" />
          </li>
        )}
      </ul>
      <p className={`kr-note ${short ? "kr-warn-text" : "kr-ok-text"}`}>
        {f.target <= 0 ? "No cash target set (Incentives)." : short ? `${usd(f.shortfall, f.currency)} short of your ${usd(f.target, f.currency)} target.` : `On track for your ${usd(f.target, f.currency)} target.`}
      </p>
      <p className="kr-note">Confidence: <strong>{f.confidence}</strong>. {f.note}</p>
    </Shell>
  );
}

const toneFor = (p: number) => (p >= 60 ? "danger" : p >= 45 ? "warn" : "accent") as "danger" | "warn" | "accent";

export function PressureWidget({ context: d }: Params) {
  const rows = d.pressure.slice(0, 8);
  return (
    <Shell title="Director pressure by customer" sub="0–100; hard rules still win">
      {rows.length === 0 ? <p className="kr-note">No customers with open overdue invoices.</p> : (
        <ul className="kr-list">
          {rows.map((r) => (
            <li key={r.customerEmail}>
              <div className="kr-line"><span className="kr-name">{r.customer}</span><span className="kr-num">{r.pressure}</span></div>
              <Bar value={r.pressure} max={100} tone={toneFor(r.pressure)} label={`Pressure for ${r.customer}`} />
              <div className="kr-meta">{r.nextMove}{r.suggestedDay ? ` · ${r.suggestedDay}` : ""} · owes {usd(r.owes)}</div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function CashWidget({ context: d }: Params) {
  const max = Math.max(...d.cash.map((c) => c.amount), 1);
  const tone = ["muted", "accent", "warn"] as const;
  return (
    <Shell title="Collected vs outstanding" sub={`${d.period.from} to ${d.period.to}`}>
      <ul className="kr-list">
        {d.cash.map((c, i) => (
          <li key={c.metric}>
            <div className="kr-line"><span>{c.metric}</span><span className="kr-num">{usd(c.amount, c.currency)}</span></div>
            <Bar value={c.amount} max={max} tone={tone[i] ?? "accent"} label={c.metric} />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

export function RemindersWidget({ context: d }: Params) {
  return (
    <Shell title="Reminder activity" sub="This month">
      <div className="kr-tiles">
        {d.reminders.map((r) => (
          <div key={r.activity} className="kr-tile"><div className="kr-tile-n">{r.count}</div><div className="kr-tile-l">{r.activity}</div></div>
        ))}
      </div>
      <p className="kr-note">{d.paidAfterReminderSummary}</p>
    </Shell>
  );
}

// Menu icons: static, hand-written SVG (AG Studio parses a string icon as HTML, so never customer text).
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${body}</svg>`;
const ICONS: Record<string, string> = {
  "kairos-forecast": svg('<path d="M3 17l5-5 4 3 6-7"/><path d="M3 6h18" stroke-dasharray="2 3"/>'),
  "kairos-pressure": svg('<path d="M4 7h10M4 12h14M4 17h7"/>'),
  "kairos-cash": svg('<rect x="4" y="5" width="16" height="4" rx="1"/><rect x="4" y="11" width="11" height="4" rx="1"/><rect x="4" y="17" width="6" height="3" rx="1"/>'),
  "kairos-reminders": svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
};

const custom = (id: string, label: string, comp: React.ComponentType<Params>, description: string): AgWidgetDefinition => ({
  id, label, icon: ICONS[id], comp: comp as AgWidgetDefinition["comp"],
  form: (p) => p.createDefaults({}),
  defaultSize: { width: 420, height: 300 },
  minSize: { width: 240, height: 180 },
  ai: { description },
});

export const KAIROS_WIDGETS: AgWidgetDefinition[] = [
  custom("kairos-forecast", "Cash forecast vs target", ForecastWidget, "Kairos's 14-day probability-weighted cash forecast against the owner's cash target, with a confidence note. Needs no data mapping."),
  custom("kairos-pressure", "Director pressure", PressureWidget, "The Kairos Director's pressure score (0-100) per customer with the next move and suggested day. Needs no data mapping."),
  custom("kairos-cash", "Collected vs outstanding", CashWidget, "This month's invoiced and collected totals against today's outstanding balance, as computed by Kairos's report. Needs no data mapping."),
  custom("kairos-reminders", "Reminder activity", RemindersWidget, "This month's reminder activity: sent, waiting for approval, needing the owner, and reminded invoices paid since. Needs no data mapping."),
];
export const KAIROS_WIDGET_IDS = KAIROS_WIDGETS.map((w) => w.id);
