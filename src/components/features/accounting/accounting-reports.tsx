"use client";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  ChevronRight,
  Download,
  Landmark,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import { CustomSelect } from "@/components/ui/select";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import type { BooksMetadata } from "./types";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import {
  reportFilterSchema,
  type ReportData,
  type ReportFilter,
} from "@/lib/accounting/reports";
import {
  buildReportModel,
  reportCatalog,
  ratioPercent,
  type ReportId,
  type ReportModel,
  type ReportRow,
} from "@/lib/accounting/report-model";
import {
  supportReportCatalog,
  type SupportReportId,
} from "@/lib/accounting/support-reports";
import { AccountingSupportReport } from "./accounting-support-report";
import { AccountingBooksPackage } from "./accounting-books-package";
import { booksPackageCatalog } from "@/lib/accounting/books-package";
import { AccountingPicker } from "./accounting-picker";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import {
  AccountingReportDetail,
  ReportMoney,
} from "./accounting-report-detail";
import {
  dateLabel,
  money,
  monthLabel,
  timestampLabel,
  todayInBooks,
  monthShortLabel,
} from "./format";

const iso = (d: Date) => d.toISOString().slice(0, 10);
function datePresets(today: string) {
  const date = new Date(`${today}T12:00:00Z`),
    y = date.getUTCFullYear(),
    m = date.getUTCMonth();
  return [
    { value: "year", label: "This year", from: `${y}-01-01`, to: today },
    {
      value: "quarter",
      label: "This quarter",
      from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))),
      to: today,
    },
    {
      value: "month",
      label: "This month",
      from: iso(new Date(Date.UTC(y, m, 1))),
      to: today,
    },
    {
      value: "last-month",
      label: "Last month",
      from: iso(new Date(Date.UTC(y, m - 1, 1))),
      to: iso(new Date(Date.UTC(y, m, 0))),
    },
    {
      value: "last-year",
      label: "Last year",
      from: `${y - 1}-01-01`,
      to: `${y - 1}-12-31`,
    },
  ];
}
function priorPeriod(filter: ReportFilter) {
  const start = new Date(`${filter.from}T12:00:00Z`),
    end = new Date(`${filter.to}T12:00:00Z`),
    duration = end.getTime() - start.getTime() + 86400000;
  return {
    compare_from: iso(new Date(start.getTime() - duration)),
    compare_to: iso(new Date(start.getTime() - 86400000)),
  };
}
function initialFilter(
  raw: string | null,
  from: string,
  to: string,
  ledger: boolean,
): ReportFilter {
  try {
    const value = reportFilterSchema.parse(JSON.parse(raw ?? "null"));
    return {
      ...value,
      account_ids: ledger ? value.account_ids : undefined,
      account_types: undefined,
      cash_class: undefined,
      offset: 0,
    };
  } catch {
    /* A broken link must not change the report scope. */
  }
  return { from, to, mode: "posted", offset: 0 };
}
const REPORT_GROUPS: {
  name: string;
  icon: typeof Landmark;
  description: string;
}[] = [
  {
    name: "Financial statements",
    icon: Landmark,
    description: "The core view of profit, financial position and cash.",
  },
  {
    name: "Business performance",
    icon: BarChart3,
    description: "Customers, vendors and the costs behind your income.",
  },
  {
    name: "Detailed accounting",
    icon: BookOpen,
    description: "Balances, journal activity and owner transactions.",
  },
  {
    name: "Customers & receivables",
    icon: BookOpen,
    description: "Unpaid invoices, customer advances and deposit policies.",
  },
  {
    name: "Payroll & year end",
    icon: BookOpen,
    description:
      "Payroll registers, contractor totals and the year-end package.",
  },
];

export function AccountingReports({
  from,
  to,
  revision,
  manage,
  accounts,
  onEntry,
  demo = false,
}: {
  from: string;
  to: string;
  revision: string;
  manage: BooksMetadata;
  accounts: AccountingAccount[];
  onEntry: (id: string) => void;
  demo?: boolean;
}) {
  const params = useSearchParams(),
    candidate = params.get("report");
  const report = reportCatalog.find((r) => r.id === candidate);
  const applied = initialFilter(
    params.get("report_filter"),
    from,
    to,
    report?.id === "general-ledger",
  );
  const signature = JSON.stringify(applied);
  const [draft, setDraft] = useState(applied),
    [advanced, setAdvanced] = useState(false),
    [error, setError] = useState(""),
    [data, setData] = useState<ReportData | null>(null),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0),
    [showZero, setShowZero] = useState(false),
    [detail, setDetail] = useState(true),
    [drill, setDrill] = useState<{
      title: string;
      filter: ReportFilter;
    } | null>(null);
  const exportCommand = useAccountingCommand();
  const [exporting, setExporting] = useState(false);
  const capture = useRef<{
    signature: string;
    id: string;
    saved: boolean;
  } | null>(null);
  const presets = datePresets(todayInBooks());
  const model =
    data && report ? buildReportModel(report.id, data, showZero) : null;
  const reportId = report?.id;
  const activeFilters = draft.payee ? 1 : 0;
  useEffect(() => {
    setDraft(JSON.parse(signature));
  }, [signature]);
  useEffect(() => {
    if (!reportId || demo) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    accountingGet<ReportData>(
      { view: "report", report: reportId, filter: signature },
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [signature, reportId, revision, refresh, demo]);
  function navigate(id?: ReportId | SupportReportId | "books-package") {
    setDrill(null);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "reports");
    if (id) url.searchParams.set("report", id);
    else url.searchParams.delete("report");
    window.history.pushState(null, "", url);
  }
  function apply() {
    const parsed = reportFilterSchema.safeParse(draft);
    if (!parsed.success) {
      setError("Choose a valid date range and comparison period.");
      return;
    }
    setError("");
    setDrill(null);
    const url = new URL(window.location.href);
    url.searchParams.set("report_filter", JSON.stringify(parsed.data));
    window.history.pushState(null, "", url);
    if (JSON.stringify(parsed.data) === signature) setRefresh((x) => x + 1);
  }
  function openDetail(title: string, filter: Partial<ReportFilter>) {
    const parsed = reportFilterSchema.safeParse(filter);
    if (!parsed.success) {
      setError("This report row has no valid journal range.");
      return;
    }
    setDrill({ title, filter: parsed.data });
  }
  async function exportReport(format: "csv" | "pdf") {
    if (!data || !model || exporting) return;
    setExporting(true);
    setError("");
    const options = {
      report_id: model.id,
      show_zero: showZero,
      details: detail,
    };
    const signature = JSON.stringify({
      revision: data.revision,
      filter: data.filter,
      options,
    });
    if (capture.current?.signature !== signature)
      capture.current = { signature, id: crypto.randomUUID(), saved: false };
    try {
      if (!capture.current.saved) {
        const result = await exportCommand.execute({
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
        throw new Error(
          body.error ?? "Unable to download the retained report.",
        );
      }
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${model.id}-${data.filter.from}-${data.filter.to}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to export this report.",
      );
    } finally {
      setExporting(false);
    }
  }
  const support = supportReportCatalog.find((r) => r.id === candidate);
  if (candidate === "books-package" && !demo)
    return (
      <AccountingBooksPackage
        to={to}
        revision={revision}
        onBack={() => navigate()}
      />
    );
  if (support && !demo)
    return (
      <AccountingSupportReport
        id={support.id}
        from={from}
        to={to}
        revision={revision}
        onBack={() => navigate()}
      />
    );
  if (!report)
    return (
      <div className="mx-auto max-w-6xl space-y-7 pb-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Reports</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Understand the business, then follow any number back to the books.
          </p>
        </div>
        {REPORT_GROUPS.filter((g) => {
          if (g.name === "Customers & receivables") return false;
          if (demo && g.name === "Payroll & year end") return false;
          if (
            g.name === "Business performance" &&
            !manage.parties.some((p) => p.kind !== "vendor")
          )
            return false;
          return true;
        }).map((g) => {
          const group = g.name;
          const Icon = g.icon;
          return (
            <section
              key={group}
              className="glass-card overflow-hidden rounded-xl md:grid md:grid-cols-[240px_1fr]"
            >
              <div className="border-b border-border bg-secondary/20 p-6 md:border-b-0 md:border-r">
                <Icon
                  size={20}
                  aria-hidden="true"
                  className="mb-3 text-teal-light"
                />
                <h3 className="font-semibold">{group}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {g.description}
                </p>
              </div>
              <div className="divide-y divide-border">
                {[
                  ...reportCatalog,
                  ...(demo
                    ? []
                    : [booksPackageCatalog, ...supportReportCatalog]),
                ]
                  .filter((r) => r.group === group)
                  .map((r) => (
                    <Button
                      key={r.id}
                      variant="ghost"
                      onClick={() => navigate(r.id)}
                      className="group h-auto w-full justify-between gap-5 rounded-none p-5 text-left font-normal whitespace-normal focus-visible:ring-inset focus-visible:ring-offset-0"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium group-hover:text-teal-light">
                          {r.title}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {r.description}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-teal-light"
                      />
                    </Button>
                  ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Button
            variant="link"
            size="sm"
            onClick={() => navigate()}
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
          <Button
            variant="outline"
            onClick={() => void exportReport("csv")}
            disabled={
              !data || loading || exporting || !!data.quality.incomplete_imports
            }
          >
            <Download aria-hidden="true" />
            {exporting ? "Preparing..." : "CSV"}
          </Button>
          <Button
            variant="outline"
            onClick={() => void exportReport("pdf")}
            disabled={
              !data || loading || exporting || !!data.quality.incomplete_imports
            }
          >
            <Download aria-hidden="true" />
            PDF
          </Button>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        className="glass-card space-y-4 rounded-xl p-4 sm:p-5"
      >
        <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[180px_1fr_1fr_200px_auto]">
          <CustomSelect
            id="report-period"
            label="Date range"
            value={
              presets.find((p) => p.from === draft.from && p.to === draft.to)
                ?.value ?? "custom"
            }
            onChange={(value) => {
              const preset = presets.find((p) => p.value === value);
              if (preset)
                setDraft({ ...draft, from: preset.from, to: preset.to });
            }}
            options={[
              { value: "custom", label: "Custom range" },
              ...presets.map((p) => ({ value: p.value, label: p.label })),
            ]}
          />
          <Input
            label={report.id === "balance-sheet" ? "Activity from" : "From"}
            type="date"
            min="1900-01-01"
            max="2100-12-31"
            required
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
          <Input
            label={report.id === "balance-sheet" ? "As of" : "Through"}
            type="date"
            min="1900-01-01"
            max="2100-12-31"
            required
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
          <CustomSelect
            id="report-mode"
            label="Book mode"
            value={draft.mode}
            onChange={(value) =>
              setDraft({ ...draft, mode: value as ReportFilter["mode"] })
            }
            options={[
              { value: "posted", label: "Posted books" },
              { value: "working", label: "Working preview" },
            ]}
          />
          <Button type="submit" disabled={loading || demo}>
            {loading ? "Updating..." : "Update report"}
          </Button>
        </div>
        {report.id === "general-ledger" && (
          <div className="max-w-lg">
            <AccountingPicker
              label="General ledger account"
              visibleLabel="Account"
              triggerId="accounting-general-ledger-account"
              value={draft.account_ids?.[0] ?? ""}
              options={[
                { value: "", label: "All accounts" },
                ...accounts.map((a) => ({
                  value: a.id,
                  label: `${a.code ? a.code + " · " : ""}${a.name}${a.is_archived ? " (archived)" : ""}`,
                })),
              ]}
              onChange={(id) =>
                setDraft({ ...draft, account_ids: id ? [id] : undefined })
              }
            />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox
              size="sm"
              checked={!!draft.compare_from}
              onChange={(checked) =>
                setDraft(
                  checked
                    ? { ...draft, ...priorPeriod(draft) }
                    : {
                        ...draft,
                        compare_from: undefined,
                        compare_to: undefined,
                      },
                )
              }
              label="Compare a period"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
              className="h-8 px-2 text-muted-foreground hover:text-foreground"
            >
              <SlidersHorizontal aria-hidden="true" />
              Filter by payee
              {activeFilters > 0 && <Badge size="sm">{activeFilters}</Badge>}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            Cash-basis books · USD
          </span>
        </div>
        {!!draft.compare_from && (
          <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <Input
              label="Compare from"
              type="date"
              required
              value={draft.compare_from}
              onChange={(e) =>
                setDraft({ ...draft, compare_from: e.target.value })
              }
            />
            <Input
              label="Compare through"
              type="date"
              required
              value={draft.compare_to ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, compare_to: e.target.value })
              }
            />
            <Button
              variant="ghost"
              type="button"
              size="sm"
              onClick={() => setDraft({ ...draft, ...priorPeriod(draft) })}
            >
              Previous period
            </Button>
            {![
              "profit-loss",
              "balance-sheet",
              "customer-income",
              "vendor-expenses",
            ].includes(report.id) && (
              <p className="text-xs text-muted-foreground">
                This report presents one period. Comparison dates are preserved
                for the other reports.
              </p>
            )}
          </div>
        )}
        {advanced && (
          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <AccountingPicker
              label="Payee"
              visibleLabel="Payee"
              value={draft.payee ?? ""}
              options={[
                { value: "", label: "All payees" },
                { value: "unassigned", label: "Unassigned" },
                ...manage.parties.map((p) => ({
                  value: p.id,
                  label: p.name,
                })),
              ]}
              onChange={(v) => setDraft({ ...draft, payee: v || undefined })}
            />
          </div>
        )}
      </form>
      {(error || exportCommand.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-4 text-sm text-error"
        >
          {error || exportCommand.error}
        </p>
      )}
      {demo && (
        <p className="p-8 text-center text-sm text-muted-foreground">
          Detailed reports are available in configured accounting books.
        </p>
      )}
      {loading && (
        <div role="status" className="glass-card space-y-4 rounded-xl p-8">
          <p className="text-sm text-muted-foreground">
            Preparing report from the ledger...
          </p>
          <div className="h-7 max-w-sm animate-pulse rounded bg-secondary" />
          <div className="h-40 animate-pulse rounded bg-secondary/40" />
        </div>
      )}
      {data && model && !loading && (
        <>
          {(data.filter.mode === "working" ||
            data.quality.incomplete_imports > 0 ||
            data.quality.uncategorized_lines > 0) && (
            <div className="rounded-lg border border-copper/30 bg-copper/5 px-4 py-3 text-xs leading-relaxed">
              <span className="font-medium">
                {data.filter.mode === "working" ? "Working preview. " : ""}
              </span>
              {data.filter.mode === "working"
                ? `${data.quality.draft_count - data.quality.unbalanced_drafts} balanced drafts are included. ${data.quality.unbalanced_drafts} incomplete drafts are excluded. `
                : ""}
              {data.quality.incomplete_imports > 0
                ? `${data.quality.incomplete_imports} imports need completion. Report export is unavailable until the import review is complete. `
                : ""}
              {data.quality.uncategorized_lines > 0
                ? `${data.quality.uncategorized_lines} posted lines still need categorization.`
                : ""}
            </div>
          )}
          <ReportHighlights id={report.id} data={data} />
          {report.id === "profit-loss" && <MonthlyResults data={data} />}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              {data.legal_name} · {dateLabel(data.filter.from)} to{" "}
              {dateLabel(data.filter.to)}
              {model.comparison && (
                <span className="mt-1 block">
                  Compared with {dateLabel(data.filter.compare_from)} to{" "}
                  {dateLabel(data.filter.compare_to)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Checkbox
                size="sm"
                checked={showZero}
                onChange={setShowZero}
                label="Show zero balances"
              />
              {["profit-loss", "balance-sheet"].includes(report.id) && (
                <div
                  role="group"
                  aria-label="Statement detail level"
                  className="seg-track seg-sm"
                >
                  {[false, true].map((v) => (
                    <button
                      key={String(v)}
                      type="button"
                      aria-pressed={detail === v}
                      onClick={() => setDetail(v)}
                      className={cn(
                        "seg-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        detail === v && "is-active",
                      )}
                    >
                      {v ? "Details" : "Summary"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {report.id === "general-ledger" ? (
            <AccountingReportDetail
              key={signature}
              title="General ledger"
              inline
              filter={applied}
              revision={data.revision}
              onClose={() => {}}
              onEntry={onEntry}
              onChanged={() => setRefresh((x) => x + 1)}
            />
          ) : (
            <StatementTable
              model={model}
              detail={detail}
              onDrill={openDetail}
            />
          )}
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            {model.footnotes.map((note) => (
              <p key={note}>{note}</p>
            ))}
            <p>
              Revision {data.revision} · Report definition{" "}
              {data.definition_version} ·{" "}
              {data.filter.mode === "posted"
                ? `${data.quality.draft_count} drafts excluded`
                : "Working preview includes balanced drafts"}
            </p>
          </div>
          <details className="glass-card rounded-xl px-4 py-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Data coverage & reconciliation
            </summary>
            <div className="mt-4 space-y-3 text-xs text-muted-foreground">
              <p>
                Reconciliation dates below are account-specific. A balanced
                ledger alone does not establish that all historical transactions
                have been imported.
              </p>
              {data.accounts
                .filter((a) => ["bank", "cash", "card"].includes(a.cash_kind))
                .map((a) => (
                  <div
                    key={a.id}
                    className="flex justify-between gap-4 border-t border-border pt-2"
                  >
                    <span>{a.name}</span>
                    <span>
                      {dateLabel(
                        data.quality.reconciliations.find(
                          (r) => r.account_id === a.id,
                        )?.through,
                      ) || "Not yet reconciled"}
                    </span>
                  </div>
                ))}
              {data.quality.feeds.map((f, i) => (
                <div key={i} className="flex justify-between gap-4">
                  <span>{f.name}</span>
                  <span>
                    {f.last_success_at
                      ? `Last sync ${timestampLabel(f.last_success_at)}`
                      : "No successful sync"}{" "}
                    · {f.status}
                  </span>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRefresh((x) => x + 1)}
              >
                <RefreshCw aria-hidden="true" />
                Refresh coverage
              </Button>
            </div>
          </details>
        </>
      )}
      {drill && data && (
        <AccountingReportDetail
          key={JSON.stringify(drill)}
          title={drill.title}
          filter={drill.filter}
          revision={data.revision}
          onClose={() => setDrill(null)}
          onEntry={(id) => {
            setDrill(null);
            onEntry(id);
          }}
          onChanged={() => setRefresh((x) => x + 1)}
        />
      )}
    </div>
  );
}

function StatementTable({
  model,
  detail,
  onDrill,
}: {
  model: ReportModel;
  detail: boolean;
  onDrill: (title: string, filter: Partial<ReportFilter>) => void;
}) {
  const hasTotals =
    ["profit-loss", "balance-sheet"].includes(model.id) &&
    model.rows.some((r) => r.kind === "total" || r.kind === "subtotal");
  const rows = model.rows.filter(
    (r) => detail || !hasTotals || r.kind !== "account",
  );
  const label = (r: ReportRow) =>
    r.entryFilter ? (
      <button
        type="button"
        className="inline-flex items-center gap-2 text-left text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onDrill(r.label, r.entryFilter!)}
      >
        {r.code && (
          <span className="font-mono text-xs text-muted-foreground">
            {r.code}
          </span>
        )}
        {r.label}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    ) : (
      <span>
        {r.code && (
          <span className="mr-2 font-mono text-xs text-muted-foreground">
            {r.code}
          </span>
        )}
        {r.label}
      </span>
    );
  const amount = (r: ReportRow, i: number) =>
    r.detail?.[i] ? (
      <button
        type="button"
        onClick={() => onDrill(r.label, r.detail![i]!)}
        aria-label={`View ${r.label}, ${model.columns[i]}, journal detail`}
        className="rounded-sm underline-offset-4 hover:text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ReportMoney value={r.values[i]} />
      </button>
    ) : (
      <ReportMoney value={r.values[i]} />
    );
  /* Row tints read on desktop rows and on the mobile card wrappers alike. */
  const rowClass = (r: ReportRow) =>
    r.kind === "heading"
      ? "rounded-xl bg-[rgba(var(--ink),0.03)]"
      : r.kind === "total"
        ? "rounded-xl bg-teal-dark/[0.07] font-semibold"
        : r.kind === "subtotal"
          ? "rounded-xl bg-secondary/20 font-medium"
          : undefined;
  const columns: DataTableColumn<ReportRow>[] = [
    {
      key: "label",
      header: "Account / category",
      className: "max-w-md",
      render: (r) =>
        r.kind === "heading" ? (
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {r.label}
          </span>
        ) : (
          <span className={cn("block", r.indent && "pl-4")}>{label(r)}</span>
        ),
    },
    ...model.columns.map(
      (c, i): DataTableColumn<ReportRow> => ({
        key: `col-${i}`,
        header: c,
        align: "right",
        numeric: true,
        className: "whitespace-nowrap",
        render: (r) => (r.kind === "heading" ? null : amount(r, i)),
      }),
    ),
  ];
  return (
    <>
      <p className="sr-only">
        {model.title}. {model.comparison ? "Includes period comparison." : ""}
      </p>
      <DataTable
        columns={columns}
        data={rows}
        keyExtractor={(r) => r.key}
        rowClassName={rowClass}
        emptyState="No account activity in this period."
        mobileCard={(r) =>
          r.kind === "heading" ? (
            <p className="px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {r.label}
            </p>
          ) : (
            <div
              className={cn("glass-card rounded-xl p-4", r.indent && "ml-4")}
            >
              <div className="text-sm">{label(r)}</div>
              <dl className="mt-2 space-y-1">
                {r.values.map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <dt className="text-xs font-normal text-muted-foreground">
                      {model.columns[i]}
                    </dt>
                    <dd className="tabular-nums">{amount(r, i)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )
        }
      />
    </>
  );
}
function ReportHighlights({ id, data }: { id: ReportId; data: ReportData }) {
  const t = data.totals;
  const values =
    id === "profit-loss"
      ? [
          ["Income", t.income_cents],
          ["Cost of sales", t.cogs_cents],
          [
            "Operating expenses",
            (BigInt(t.expense_cents) - BigInt(t.cogs_cents)).toString(),
          ],
          ["Net profit", t.net_cents],
        ]
      : id === "balance-sheet"
        ? [
            ["Assets", t.assets_cents],
            ["Liabilities", t.liabilities_cents],
            [
              "Equity",
              (
                BigInt(t.equity_cents) +
                BigInt(t.prior_cents) +
                BigInt(t.year_cents)
              ).toString(),
            ],
          ]
        : id === "cash-flow"
          ? [
              ["Opening cash", t.cash_opening_cents],
              [
                "Net movement",
                (
                  BigInt(t.cash_ending_cents) - BigInt(t.cash_opening_cents)
                ).toString(),
              ],
              ["Closing cash", t.cash_ending_cents],
            ]
          : [];
  if (!values.length) return null;
  return (
    <div
      className={cn(
        "grid gap-3 lg:gap-4",
        values.length === 4 ? "grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3",
      )}
    >
      {values.map(([label, value], i) => (
        <div key={label} className="glass-card rounded-xl p-4 lg:p-5">
          <p className="text-xs font-medium text-muted-foreground lg:text-sm">
            {label}
          </p>
          <div
            className={cn(
              "mt-1 text-xl font-semibold tracking-tight lg:text-2xl",
              i === values.length - 1 && "text-teal-light",
            )}
          >
            <MaskedValue value={money(value)} className="tabular-nums" />
          </div>
          {id === "profit-loss" && i === 3 && (
            <p className="mt-1 text-xs text-muted-foreground">
              <MaskedValue
                value={`${ratioPercent(value, t.income_cents) ?? "No revenue"}${BigInt(t.income_cents) !== BigInt(0) ? " margin" : ""}`}
              />
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
function MonthlyResults({ data }: { data: ReportData }) {
  const { isHidden } = usePrivacy();
  const [hover, setHover] = useState<number | null>(null);
  if (isHidden)
    return (
      <div className="glass-card rounded-xl p-5 text-xs text-muted-foreground">
        Monthly chart hidden while privacy mode is on.
      </div>
    );
  const abs = (s: string) => {
      const b = BigInt(s);
      return b < BigInt(0) ? -b : b;
    },
    max = data.monthly.reduce(
      (m, v) =>
        [abs(v.income_cents), abs(v.expense_cents), abs(v.net_cents), m].reduce(
          (a, b) => (a > b ? a : b),
        ),
      BigInt(1),
    );
  const width = Math.max(640, data.monthly.length * 56),
    step = (width - 64) / Math.max(1, data.monthly.length),
    height = (s: string) => Number((BigInt(s) * BigInt(6500)) / max) / 100;
  return (
    <section className="glass-card rounded-xl p-5">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="text-sm font-medium">Monthly performance</h3>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-sm bg-teal-light"
            />
            Income
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-copper" />
            Expenses
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-3 bg-foreground/60" />
            Net profit
          </span>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <svg
          role="img"
          aria-label="Monthly income, expenses and net profit. Exact amounts are available by focusing each month."
          width={width}
          height="210"
          className="min-w-full"
        >
          <line
            x1="24"
            x2={width - 24}
            y1="90"
            y2="90"
            stroke="var(--border)"
          />
          {data.monthly.map((m, i) => {
            const x = 32 + step * i + step / 2,
              ih = height(m.income_cents),
              eh = height(m.expense_cents),
              nh = height(m.net_cents);
            return (
              <g
                key={m.month}
                tabIndex={0}
                role="img"
                aria-label={`${monthLabel(m.month)}: income ${money(m.income_cents)}, expenses ${money(m.expense_cents)}, net ${money(m.net_cents)}`}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <rect
                  x={x - step / 2}
                  y="5"
                  width={step}
                  height="178"
                  fill={hover === i ? "var(--secondary)" : "transparent"}
                  opacity="0.5"
                />
                <rect
                  x={x - 14}
                  y={ih >= 0 ? 90 - ih : 90}
                  width="11"
                  height={Math.max(1, Math.abs(ih))}
                  rx="2"
                  fill="var(--teal-light)"
                />
                <rect
                  x={x + 2}
                  y={eh >= 0 ? 90 - eh : 90}
                  width="11"
                  height={Math.max(1, Math.abs(eh))}
                  rx="2"
                  fill="var(--copper)"
                />
                <circle cx={x} cy={90 - nh} r="3" fill="var(--foreground)" />
                <text
                  x={x}
                  y="178"
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--muted-foreground)"
                >
                  {monthShortLabel(m.month, data.monthly.length > 12)}
                </text>
              </g>
            );
          })}
          <polyline
            points={data.monthly
              .map(
                (m, i) =>
                  `${32 + step * i + step / 2},${90 - height(m.net_cents)}`,
              )
              .join(" ")}
            fill="none"
            stroke="var(--foreground)"
            strokeOpacity="0.5"
            strokeWidth="1.5"
            pointerEvents="none"
          />
        </svg>
      </div>
      <p className="min-h-5 text-xs text-muted-foreground">
        {hover === null
          ? "Hover or focus a month for exact figures."
          : `${monthLabel(data.monthly[hover].month)} · Income ${money(data.monthly[hover].income_cents)} · Expenses ${money(data.monthly[hover].expense_cents)} · Net ${money(data.monthly[hover].net_cents)}`}
      </p>
    </section>
  );
}
