"use client";
import { useRef, useState } from "react";
import type { ReportData } from "@/lib/accounting/reports";
import type { reportOptionsSchema } from "@/lib/accounting/reports";
import type { z } from "zod";
import { useAccountingCommand } from "./use-accounting-command";

type ReportOptions = z.infer<typeof reportOptionsSchema>;

/**
 * Downloads a report: the books retain a snapshot of exactly what is on
 * screen (report.capture, once per revision, filter and options), then the
 * server renders that snapshot as CSV or PDF. A second format of the same
 * view reuses the snapshot instead of capturing again.
 */
export function useReportExport() {
  const command = useAccountingCommand();
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [error, setError] = useState("");
  const capture = useRef<{
    signature: string;
    id: string;
    saved: boolean;
  } | null>(null);

  async function run(
    data: ReportData,
    options: ReportOptions,
    format: "csv" | "pdf",
  ) {
    if (exporting) return;
    setExporting(format);
    setError("");
    const signature = JSON.stringify({
      revision: data.revision,
      filter: data.filter,
      options,
    });
    if (capture.current?.signature !== signature)
      capture.current = { signature, id: crypto.randomUUID(), saved: false };
    try {
      if (!capture.current.saved) {
        const result = await command.execute({
          type: "report.capture",
          id: capture.current.id,
          expected_revision: data.revision,
          filter: data.filter,
          options,
        });
        if (!result) return;
        capture.current.saved = true;
      }
      const response = await fetch(
        `/api/accounting/reports/${capture.current.id}?format=${format}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? "Unable to download the retained report.");
      }
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${options.report_id}-${data.filter.from}-${data.filter.to}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to export this report.");
    } finally {
      setExporting(null);
    }
  }

  return { run, exporting, error: error || command.error || "" };
}
