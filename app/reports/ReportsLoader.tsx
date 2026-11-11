"use client";
// AG Studio is browser-only and large: load it here, on /reports alone, never during SSR.
import dynamic from "next/dynamic";
import type { ReportsData } from "@/lib/reports/build";

const ReportsStudio = dynamic(() => import("./studio/ReportsStudio"), {
  ssr: false,
  loading: () => <div className="card muted">Loading reports…</div>,
});

export default function ReportsLoader(props: { data: ReportsData; licenseKey?: string; aiEnabled?: boolean }) {
  return <ReportsStudio {...props} />;
}
