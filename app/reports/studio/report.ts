/** The built-in Kairos report, as AG Studio report state. Field ids refer to ./sources.ts. */
import type { AgPageState, AgReportState, AgResponsiveLayoutBreakpoint, AgWidgetLayoutState } from "ag-studio";

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string) => ({ title: { enabled: true, text } });
const sum = (id: string) => ({ id, aggregation: "sum" as const });
// Kairos's custom widget types (./widgets.tsx) aren't in Studio's default registry type.
type WidgetState = NonNullable<NonNullable<AgPageState["widgets"]>[string]>;
const kairos = (type: string) => ({ type }) as unknown as WidgetState;

const overview: AgPageState = {
  id: "overview",
  widgets: {
    cash: kairos("kairos-cash"),
    forecast: kairos("kairos-forecast"),
    reminders: kairos("kairos-reminders"),
    aging: {
      type: "column-chart-grouped",
      dataMapping: { categoryKey: [{ id: "aging.bucket" }], valueKey: [sum("aging.amount")] },
      sort: [{ field: { id: "aging.order", aggregation: "min" }, direction: "asc" }],
      format: title("Aging of open invoices"),
    },
    owing: {
      type: "bar-chart-grouped",
      dataMapping: { categoryKey: [{ id: "owing.customer" }], valueKey: [sum("owing.owes")] },
      sort: [{ field: sum("owing.owes"), direction: "desc" }],
      format: title("Top customers owing"),
    },
    pressure: kairos("kairos-pressure"),
    expected: {
      type: "bar-chart-grouped",
      dataMapping: { categoryKey: [{ id: "forecastInvoices.invoice" }], valueKey: [sum("forecastInvoices.expectedAmount"), sum("forecastInvoices.amountDue")] },
      sort: [{ field: sum("forecastInvoices.expectedAmount"), direction: "desc" }],
      format: { ...title("Forecast by invoice: expected vs due"), style: { theme: { common: { legend: { enabled: true } } } } },
    },
  },
  widgetLayout: {
    cash: at(0, 0, 8, 19),
    forecast: at(8, 0, 8, 19),
    reminders: at(16, 0, 8, 19),
    aging: at(0, 19, 12, 18),
    owing: at(12, 19, 12, 18),
    pressure: at(0, 37, 12, 26),
    expected: at(12, 37, 12, 26),
  },
};

const invoices: AgPageState = {
  id: "invoices",
  widgets: {
    grid: {
      type: "grid",
      dataMapping: {
        cols: [
          { id: "invoices.number" },
          { id: "invoices.customer" },
          { id: "invoices.status" },
          { id: "invoices.dueDate" },
          { id: "invoices.daysOverdue" },
          sum("invoices.amountDue"),
          { id: "invoices.pressure" },
          { id: "invoices.nextMove" },
        ],
      },
      sort: [{ field: { id: "invoices.daysOverdue" }, direction: "desc" }],
      format: title("Invoices, most overdue first"),
    },
    "by-customer": {
      type: "pivot-grid",
      dataMapping: {
        rows: [{ id: "openInvoices.customer" }, { id: "openInvoices.number" }],
        columns: [{ id: "openInvoices.agingBucket" }],
        values: [sum("openInvoices.amountDue")],
      },
      format: { ...title("Open invoices: amount due by customer and aging"), style: { totalColumns: true, grandTotalRow: { enabled: true } } },
    },
  },
  widgetLayout: {
    grid: at(0, 0, 24, 28),
    "by-customer": at(0, 28, 24, 24),
  },
};

export const PAGE_TITLES: Record<string, string> = { overview: "Overview", invoices: "Invoices" };

export const kairosReport: AgReportState = { selectedPageId: overview.id, pages: [overview, invoices] } as AgReportState;

/** The filters panel starts collapsed in both modes (the canvas, and in edit mode Compose, Data and the assistant, need the width); one click opens it. */
export const withFiltersPanelFor = (mode: "view" | "edit", state: AgReportState): AgReportState => ({
  ...state,
  panels: { ...state.panels, filters: { ...state.panels?.filters, collapsed: mode === "view" || mode === "edit" } },
});

/** Phones: one widget per row, full width, in reading order. */
export const RESPONSIVE: AgResponsiveLayoutBreakpoint[] = [
  {
    maxWidth: 720,
    layout(candidates, state) {
      let y = 0;
      return [...candidates]
        .map((c, i) => ({ c, i }))
        .sort((a, b) => a.c.layout.yTrack - b.c.layout.yTrack || a.c.layout.xTrack - b.c.layout.xTrack)
        .map(({ c, i }) => {
          // A little taller than on desktop: text wraps more at phone width.
          const ySpan = Math.max(c.minSize.ySpan, c.layout.ySpan + 5);
          const out = { i, layout: { xTrack: 0, yTrack: y, xSpan: state.columns, ySpan } };
          y += ySpan;
          return out;
        })
        .sort((a, b) => a.i - b.i)
        .map((o) => o.layout);
    },
  },
];
