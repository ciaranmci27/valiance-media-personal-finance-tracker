import { readAccounting } from "@/lib/accounting/server/read";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { documentCsv, reportDocument } from "@/lib/accounting/report-document";
import type { DetailedReportSnapshot } from "@/lib/accounting/reports";
import {
  supportReportDocument,
  type SupportReportSnapshot,
} from "@/lib/accounting/support-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let client;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  try {
    const { id } = await params,
      format = req.nextUrl.searchParams.get("format") ?? "pdf";
    if (!z.uuid().safeParse(id).success || !["pdf", "csv"].includes(format))
      return NextResponse.json(
        { error: "Choose a saved report and a supported format." },
        { status: 400 },
      );
    const { data, error } = await readAccounting(client, "snapshot", {
      p_id: id,
    });
    if (error) throw error;
    const snapshot = data as
      | DetailedReportSnapshot
      | SupportReportSnapshot
      | null;
    if (
      !snapshot ||
      !["detailed_report", "support_report"].includes(snapshot.payload.type) ||
      snapshot.payload.export_definition !== 1
    )
      return NextResponse.json(
        { error: "This report export is unavailable." },
        { status: 404 },
      );

    const support = snapshot.payload.type === "support_report";
    const doc = support
      ? supportReportDocument(snapshot as SupportReportSnapshot)
      : reportDocument(snapshot as DetailedReportSnapshot);
    const filename = support
      ? `${(snapshot as SupportReportSnapshot).payload.data.report_id}-${(snapshot as SupportReportSnapshot).payload.data.filter.to}.${format}`
      : `${(snapshot as DetailedReportSnapshot).payload.options.report_id}-${(snapshot as DetailedReportSnapshot).payload.data.filter.from}-${(snapshot as DetailedReportSnapshot).payload.data.filter.to}.${format}`;
    if (format === "pdf" && doc.rows.length > 10000)
      return NextResponse.json(
        {
          error: "Choose a shorter period for PDF, or export the complete CSV.",
        },
        { status: 413 },
      );
    const body =
      format === "csv"
        ? documentCsv(doc)
        : new Uint8Array(
            await (
              await import("@/lib/accounting/server/report-pdf")
            ).reportPdf(doc),
          );
    return new NextResponse(body, {
      headers: {
        "Content-Type":
          format === "csv" ? "text/csv;charset=utf-8" : "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Accounting-Snapshot": id,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: accountingError(
          error instanceof Error ? error.message : String(error),
        ),
      },
      { status: 500 },
    );
  }
}
