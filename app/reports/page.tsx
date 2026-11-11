import { requirePageSession } from "@/lib/auth-server";
import { loadReportsData } from "@/lib/reports/load";
import ReportsLoader from "./ReportsLoader";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  await requirePageSession("/reports");
  let data;
  try {
    data = await loadReportsData();
  } catch (err) {
    return (
      <>
        <h1>Reports</h1>
        <div className="card error">Couldn&apos;t load the reports: {(err as Error).message}</div>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted subtitle">
            Read-only. The same numbers as the chat and the briefing, as of {data.today}{data.truncated ? " (invoice list truncated)" : ""}.
            Customize rearranges this view in your browser only; it never changes invoices.
          </p>
        </div>
      </div>
      {/* The licence key is public by design (AG Studio validates it in the browser). */}
      <ReportsLoader data={data} licenseKey={process.env.AG_STUDIO_LICENSE_KEY || undefined} />
    </>
  );
}
