"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import {
  supportReportCatalog,
  supportReportFilterSchema,
  type SupportReportData,
  type SupportReportFilter,
  type SupportReportId,
} from "@/lib/accounting/support-reports";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { ReportMoney } from "./accounting-report-detail";
import { countLabel, dateLabel } from "./format";
import { cn } from "@/lib/utils";

type SupportRow = SupportReportData["rows"][number];
type ControlRow = NonNullable<SupportReportData["controls"]>["rows"][number];
const PAGE_SIZE = 100;
/** Link target for a first-column cell, or null when the row has no drill target. */
function rowHref(r: SupportRow, to: string): string | null {
  if (r.run_id)
    return `/accounting?view=manage&section=payroll&run=${r.run_id}`;
  if (r.tax_kind)
    return `/accounting?view=manage&section=tax&tax_year=${to.slice(0, 4)}&tax_through=${to}&tax_tab=${r.tax_kind === "account" ? "accounts" : "adjustments"}`;
  if ("contractor_party_id" in r)
    return `/accounting?view=manage&section=contractors&contractor_filter=${encodeURIComponent(
      JSON.stringify({
        year: Number(to.slice(0, 4)),
        through: to,
        offset: 0,
        query: "",
        ...(r.contractor_party_id ? { party: r.contractor_party_id } : {}),
      }),
    )}`;
  if (r.register_id)
    return `/accounting?view=manage&section=${r.register_kind === "asset" ? "assets" : "loans"}&register=${r.register_id}`;
  return null;
}
const controlColumns: DataTableColumn<ControlRow>[] = [
  { key: "account", header: "Account", render: (r) => r.name },
  {
    key: "register",
    header: "Register",
    align: "right",
    numeric: true,
    render: (r) => <ReportMoney value={r.register_cents} />,
  },
  {
    key: "books",
    header: "Books",
    align: "right",
    numeric: true,
    render: (r) => <ReportMoney value={r.book_cents} />,
  },
  {
    key: "difference",
    header: "Difference",
    align: "right",
    numeric: true,
    render: (r) => (
      <span className={cn(r.difference_cents !== "0" && "text-error")}>
        <ReportMoney value={r.difference_cents} />
      </span>
    ),
  },
];
const controlCard = (r: ControlRow) => (
  <div className="glass-card rounded-xl p-4">
    <p className="text-sm font-medium">{r.name}</p>
    <dl className="mt-2 space-y-1">
      {(
        [
          ["Register", r.register_cents, false],
          ["Books", r.book_cents, false],
          ["Difference", r.difference_cents, r.difference_cents !== "0"],
        ] as const
      ).map(([label, cents, flag]) => (
        <div
          key={label}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className={cn("tabular-nums", flag && "text-error")}>
            <ReportMoney value={cents} />
          </dd>
        </div>
      ))}
    </dl>
  </div>
);

export function AccountingSupportReport({
  id,
  from,
  to,
  revision,
  onBack,
}: {
  id: SupportReportId;
  from: string;
  to: string;
  revision: string;
  onBack: () => void;
}) {
  const params = useSearchParams();
  let applied: SupportReportFilter = { report_id: id, from, to, offset: 0 };
  try {
    const p = supportReportFilterSchema.safeParse(
      JSON.parse(params.get("support_filter") ?? "{}"),
    );
    if (p.success) applied = { ...p.data, report_id: id };
  } catch {
    /* Use the page period for an invalid saved filter. */
  }
  if (id === "contractor-worksheet" || id === "tax-workpapers")
    applied = { ...applied, from: applied.to.slice(0, 4) + "-01-01" };
  const signature = JSON.stringify(applied),
    report = supportReportCatalog.find((r) => r.id === id)!;
  const [draft, setDraft] = useState(applied),
    [data, setData] = useState<SupportReportData | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0),
    [exporting, setExporting] = useState(false);
  const capture = useRef<{
      signature: string;
      id: string;
      saved: boolean;
    } | null>(null),
    command = useAccountingCommand();
  useEffect(() => setDraft(JSON.parse(signature)), [signature]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    accountingGet<SupportReportData>(
      { view: "support-report", filter: signature },
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [signature, revision, tick]);
  function apply(f: SupportReportFilter) {
    const p = supportReportFilterSchema.safeParse(f);
    if (!p.success) {
      setError("Choose a valid report period.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("support_filter", JSON.stringify(p.data));
    window.history.pushState(null, "", url);
    if (JSON.stringify(p.data) === signature) setTick((n) => n + 1);
  }
  async function download(format: "csv" | "pdf") {
    if (!data || exporting) return;
    setExporting(true);
    setError("");
    try {
      const filter = { ...data.filter, offset: 0 },
        key = JSON.stringify({ filter, revision: data.revision });
      if (capture.current?.signature !== key)
        capture.current = {
          signature: key,
          id: crypto.randomUUID(),
          saved: false,
        };
      if (!capture.current.saved) {
        if (
          !(await command.execute({
            type: "report.support.capture",
            id: capture.current.id,
            expected_revision: data.revision,
            filter,
          }))
        )
          return;
        capture.current.saved = true;
      }
      const response = await fetch(
        `/api/accounting/reports/${capture.current.id}?format=${format}`,
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).error ?? "Unable to export this report.",
        );
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = `${id}-${data.filter.to}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const asOfReport =
    id !== "payroll-register" &&
    id !== "contractor-worksheet" &&
    id !== "tax-workpapers";
  const cell = (
    r: SupportRow,
    i: number,
    column: { label: string; numeric: boolean },
    to: string,
  ) => {
    const href = i === 0 ? rowHref(r, to) : null;
    return href ? (
      <a className="text-teal-light hover:underline" href={href}>
        {r.cells[i]}
      </a>
    ) : column.numeric ? (
      <ReportMoney value={r.cells[i]} />
    ) : (
      r.cells[i]
    );
  };
  const columns = (data?.columns ?? []).map(
    (column, i): DataTableColumn<SupportRow> => ({
      key: `col-${i}`,
      header: column.label,
      align: column.numeric ? "right" : "left",
      numeric: column.numeric,
      className: cn(
        i === 0 && "min-w-[230px]",
        !column.numeric && "whitespace-pre-line",
      ),
      render: (r) => cell(r, i, column, data!.filter.to),
    }),
  );
  const mobileCard = (r: SupportRow) => (
    <div className="glass-card rounded-xl p-4">
      <div className="text-sm font-medium whitespace-pre-line">
        {data && cell(r, 0, data.columns[0], data.filter.to)}
      </div>
      <dl className="mt-3 space-y-1.5">
        {data?.columns.slice(1).map((column, i) => (
          <div
            key={column.label}
            className="flex items-start justify-between gap-3 text-sm"
          >
            <dt className="shrink-0 text-xs text-muted-foreground">
              {column.label}
            </dt>
            <dd
              className={cn(
                "text-right",
                column.numeric ? "tabular-nums" : "whitespace-pre-line",
              )}
            >
              {cell(r, i + 1, column, data.filter.to)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button
            variant="link"
            size="sm"
            onClick={onBack}
            className="mb-3 h-auto px-0 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" />
            All reports
          </Button>
          <h2 className="text-2xl font-semibold tracking-tight">
            {report.title}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {report.description}
          </p>
        </div>
        <div className="flex gap-2">
          {(["csv", "pdf"] as const).map((f) => (
            <Button
              key={f}
              variant="outline"
              disabled={!data || loading || exporting}
              onClick={() => void download(f)}
            >
              <Download aria-hidden="true" />
              {exporting ? "Preparing..." : f.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>
      <form
        className="glass-card flex flex-wrap items-end gap-3 rounded-xl p-4"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ ...draft, offset: 0 });
        }}
      >
        {id === "payroll-register" && (
          <DateInput
            label="From"
            required
            value={draft.from}
            onChange={(nextValue) =>
              setDraft((d) => ({ ...d, from: nextValue }))
            }
          />
        )}
        <DateInput
          label={asOfReport ? "As of" : "Through"}
          required
          value={draft.to}
          onChange={(nextValue) =>
            setDraft((d) => ({
              ...d,
              to: nextValue,
              ...(id !== "payroll-register"
                ? { from: nextValue.slice(0, 4) + "-01-01" }
                : {}),
            }))
          }
        />
        <Button type="submit" disabled={loading}>
          Update report
        </Button>
        <Tooltip content="Refresh report">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh report"
            disabled={loading}
            onClick={() => setTick((n) => n + 1)}
          >
            <RefreshCw
              aria-hidden="true"
              className={loading ? "animate-spin" : ""}
            />
          </Button>
        </Tooltip>
      </form>
      {(error || command.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-3 text-sm text-error"
        >
          {error || command.error}
        </p>
      )}
      {data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{data.legal_name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {asOfReport
                  ? `As of ${dateLabel(data.filter.to)}`
                  : `${dateLabel(data.filter.from)} to ${dateLabel(data.filter.to)}`}{" "}
                · USD · Recorded books
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {countLabel(data.count, "record")}
            </span>
          </div>
          <DataTable
            columns={columns}
            data={data.rows}
            keyExtractor={(r) => r.id}
            mobileCard={mobileCard}
            emptyState="No records in this scope."
            footer={data.total_cells.map((v, i) => (
              <td
                key={i}
                className={cn(
                  "px-4 py-3",
                  data.columns[i].numeric && "text-right tabular-nums",
                )}
              >
                {data.columns[i].numeric ? <ReportMoney value={v} /> : v}
              </td>
            ))}
            after={
              <Pagination
                offset={data.filter.offset}
                limit={PAGE_SIZE}
                total={data.count}
                onChange={(offset) => apply({ ...data.filter, offset })}
                noun="records"
                busy={loading}
              />
            }
          />
          {data.count > 0 && (
            <div className="glass-card rounded-xl p-4 lg:hidden">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Totals
              </p>
              <dl className="mt-2 space-y-1.5">
                {data.columns.map((column, i) =>
                  column.numeric ? (
                    <div
                      key={column.label}
                      className="flex items-center justify-between gap-3 text-sm font-medium"
                    >
                      <dt className="text-xs font-normal text-muted-foreground">
                        {column.label}
                      </dt>
                      <dd className="tabular-nums">
                        <ReportMoney value={data.total_cells[i]} />
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Totals cover the full report.
          </p>
          {data.controls && data.controls.rows.length > 0 && (
            <details
              className="glass-card rounded-xl p-4"
              open={!data.controls.ready}
            >
              <summary className="cursor-pointer text-sm font-medium">
                Register account controls{" "}
                {data.controls.ready ? "· Agreed" : "· Needs review"}
              </summary>
              <div className="mt-4">
                <DataTable
                  columns={controlColumns}
                  data={data.controls.rows}
                  keyExtractor={(r) => r.account_id}
                  framed={false}
                  mobileCard={controlCard}
                />
              </div>
            </details>
          )}
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            {data.notes.map((note, i) => (
              <p key={i}>{note}</p>
            ))}
          </div>
        </>
      ) : (
        loading && (
          <div
            role="status"
            aria-label="Loading report..."
            className="glass-card rounded-xl p-4"
          >
            <TableSkeleton rows={8} />
          </div>
        )
      )}
    </div>
  );
}
