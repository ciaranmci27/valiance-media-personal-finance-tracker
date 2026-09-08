import { NextRequest, NextResponse } from "next/server";
import { accountingClient } from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedForm } from "@/lib/accounting/server/request-body";
import { waveReportControls } from "@/lib/accounting/imports/wave";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 5 * 1024 * 1024;

/**
 * Reads Wave profit and loss or balance sheet exports into the totals they
 * state, so the owner never retypes a report. Nothing is stored here: the
 * caller keeps the files and uploads them as evidence when a comparison is
 * recorded.
 */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req))
    return NextResponse.json(
      { error: "Invalid request origin." },
      { status: 403 },
    );
  let client;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  if (Number(req.headers.get("content-length") ?? 0) > LIMIT + 1024)
    return NextResponse.json(
      { error: "Report files are limited to 5 MB together." },
      { status: 413 },
    );
  try {
    const form = await boundedForm(req, LIMIT + 1024);
    const files = form
      .getAll("file")
      .filter((f): f is File => f instanceof File);
    if (files.length === 0 || files.length > 2)
      throw new Error("Choose one or two Wave report exports for one year.");
    const { data, error } = await client.rpc("context", {
      view: "manage",
      params: {},
    });
    if (error) throw new Error("Unable to load the books history boundary.");
    const earliest = String(
      (
        data as {
          preferences?: {
            business_profile?: { earliest_history_date?: string };
          };
        } | null
      )?.preferences?.business_profile?.earliest_history_date ?? "2022-12-31",
    );
    const reports = [];
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".csv"))
        throw new Error(`${file.name} is not a CSV export.`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      try {
        reports.push({
          file_name: file.name,
          ...waveReportControls(text, earliest),
        });
      } catch (cause) {
        throw new Error(
          `${file.name}: ${cause instanceof Error ? cause.message : "unreadable Wave report."}`,
        );
      }
    }
    return NextResponse.json(
      { earliest_history_date: earliest, reports },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to read these Wave reports.",
      },
      { status: 400 },
    );
  }
}
