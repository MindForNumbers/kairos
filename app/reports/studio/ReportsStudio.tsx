"use client";
/**
 * The /reports dashboard: one AG Studio instance over Kairos's read-only tables. Loaded only on
 * this page (see ../ReportsLoader.tsx), so AG Studio's bundle never reaches the rest of the app.
 * "Customize" switches Studio to edit mode: layout and widget changes live in this browser tab
 * only. Nothing here writes to Kairos or PayPal.
 */
import { useMemo, useRef, useState } from "react";
import { enableStudioDevValidations, type AgStudioApi, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import type { ReportsData } from "@/lib/reports/build";
import { buildSources } from "./sources";
import { KAIROS_WIDGETS, KAIROS_WIDGET_IDS } from "./widgets";
import { PAGE_TITLES, RESPONSIVE, kairosReport, withFiltersPanelFor } from "./report";
import { kairosStudioTheme } from "./theme";
import "./reports.css";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

export default function ReportsStudio({ data, licenseKey }: { data: ReportsData; licenseKey?: string }) {
  const apiRef = useRef<AgStudioApi | null>(null);
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [page, setPage] = useState(kairosReport.selectedPageId ?? "overview");
  const sources = useMemo(() => buildSources(data), [data]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom widget ids aren't in the default registry type
  const widgets = useMemo(() => (cfg: any) => createWidgets<any>({
    additionalTypes: KAIROS_WIDGETS,
    menu: [{ label: "Kairos", widgetIds: KAIROS_WIDGET_IDS }, ...cfg.menu],
  }), []);

  const go = (id: string) => {
    const api = apiRef.current;
    if (!api) return;
    api.setState({ ...api.getState(), selectedPageId: id });
    setPage(id);
  };
  const reset = () => {
    apiRef.current?.setState(withFiltersPanelFor(mode, { ...kairosReport, selectedPageId: page }));
    apiRef.current?.clearHistory();
  };
  const toggleMode = () => {
    const next = mode === "edit" ? "view" : "edit";
    const api = apiRef.current;
    if (api) api.setState(withFiltersPanelFor(next, api.getState()));
    setMode(next);
  };
  const [initialState] = useState(() => withFiltersPanelFor("view", kairosReport));

  return (
    <div className="kr-shell">
      <div className="kr-toolbar">
        <div className="kr-tabs" role="tablist" aria-label="Report pages">
          {Object.entries(PAGE_TITLES).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={page === id} className={`kr-tab ${page === id ? "active" : ""}`} onClick={() => go(id)}>{label}</button>
          ))}
        </div>
        <div className="kr-actions">
          {mode === "edit" && <button className="kr-btn" onClick={reset}>Reset layout</button>}
          <button className="kr-btn" aria-pressed={mode === "edit"} onClick={toggleMode}>
            {mode === "edit" ? "Done" : "Customize"}
          </button>
        </div>
      </div>
      <div className="kr-canvas">
        <AgStudioProvider licenseKey={licenseKey}>
          <AgStudio
            style={{ height: "100%", width: "100%" }}
            theme={kairosStudioTheme}
            data={sources}
            context={data}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            widgets={widgets as any}
            initialState={initialState}
            mode={mode}
            layout={{ widgetBorderEnabled: true, minWidth: 320 }}
            responsiveLayoutBreakpoints={RESPONSIVE}
            onApiReady={(e) => { apiRef.current = e.api as AgStudioApi; }}
          />
        </AgStudioProvider>
      </div>
    </div>
  );
}
