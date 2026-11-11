import "server-only";
/**
 * Loads the /reports tables through the exact code paths the chat and briefing use:
 * get_report (this month) through the chat's own tool handler, and the Director plan, names and
 * 14-day forecast through loadInsights. One ToolContext, so the invoice list is read once.
 * Read-only: no PayPal client of its own, no queue/executor, no store writes.
 */
import { ToolContext, runTool } from "@/lib/chat/tools";
import { loadInsights } from "@/lib/insights/load";
import { buildReportsData, type ReportData, type ReportsData } from "./build";

export async function loadReportsData(): Promise<ReportsData> {
  const ctx = new ToolContext();
  const { invoices } = await ctx.listAll();
  const [report, loaded] = await Promise.all([
    runTool("get_report", { period: "this_month" }, ctx),
    loadInsights({ invoices, today: ctx.today }),
  ]);
  return buildReportsData({ invoices, report: report.data as ReportData, plan: loaded.plan, names: loaded.names });
}
