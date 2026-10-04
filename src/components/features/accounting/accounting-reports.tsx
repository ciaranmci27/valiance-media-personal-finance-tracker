"use client";
import { Disclosure } from "@/components/ui/disclosure";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
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
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { MaskedValue } from "@/components/ui/masked-value";
import { Select } from "@/components/ui/inputs/Select";
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
  type ReportId,
  type ReportModel,
  type ReportRow,
} from "@/lib/accounting/report-model";
import {
  supportReportCatalog,
  type SupportReportId,
} from "@/lib/accounting/support-reports";
import { AccountingSupportReport } from "./accounting-support-report";
import { AccountingProfitLoss } from "./accounting-profit-loss";
import { AccountingBalanceSheet } from "./accounting-balance-sheet";
import { useReportExport } from "./use-report-export";
import { AccountingBooksPackage } from "./accounting-books-package";
import { booksPackageCatalog } from "@/lib/accounting/books-package";
import { AccountingPicker } from "./accounting-picker";
import { useAccountingRead } from "./use-accounting-read";
import { useAccountingCache } from "./accounting-cache";
import { defaultReportFilter, reportQuery } from "@/lib/accounting/preload";
import { uncategorizedCents } from "@/lib/accounting/account-balances";
import { StatementSkeleton } from "./accounting-skeletons";
import {
  AccountingReportDetail,
  ReportMoney,
} from "./accounting-report-detail";
import {
  countLabel,
  dateLabel,
  money,
  timestampLabel,
  todayInBooks,
} from "./format";
import {
  AccountingPageHeader,
  accountingHeader,
} from "./accounting-page-header";

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
  return defaultReportFilter(from, to);
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
  onReview,
  demo = false,
}: {
  from: string;
  to: string;
  revision: string;
  manage: BooksMetadata;
  accounts: AccountingAccount[];
  onEntry: (id: string) => void;
  onReview: () => void;
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
    [showZero, setShowZero] = useState(false),
    [detail, setDetail] = useState(true),
    [drill, setDrill] = useState<{
      title: string;
      filter: ReportFilter;
    } | null>(null);
  const exporter = useReportExport();
  const exporting = !!exporter.exporting;
  const presets = datePresets(todayInBooks());
  const reportId = report?.id;
  const cache = useAccountingCache();
  // The statement comes from the shared cache: a card that was pointed at
  // has it ready, and a write elsewhere refreshes it behind the reader.
  const reportRead = useAccountingRead<ReportData>(
    reportId && reportId !== "profit-loss" && reportId !== "balance-sheet"
      ? reportQuery(reportId, applied)
      : null,
    { enabled: !demo },
  );
  const data = reportRead.data ?? null;
  const loading = reportRead.loading;
  const model =
    data && report
      ? buildReportModel(report.id, data, showZero, manage.parties)
      : null;
  // What the banner says about scope: the count awaiting review and the
  // amount still parked in the uncategorized accounts for these dates.
  const allActivity = data?.filter.mode === "working";
  const awaiting = data
    ? allActivity
      ? data.quality.draft_count - data.quality.unbalanced_drafts
      : data.quality.draft_count
    : 0;
  const uncategorized =
    data && allActivity
      ? uncategorizedCents(
          data.accounts,
          (a) => a.purpose,
          (a) => a.period_cents,
        )
      : BigInt(0);
  const warm = (id: string) => {
    if (demo || !reportCatalog.some((r) => r.id === id)) return;
    void cache
      .read(reportQuery(id, defaultReportFilter(from, to)))
      .catch(() => undefined);
  };
  const activeFilters = draft.payee ? 1 : 0;
  useEffect(() => {
    setDraft(JSON.parse(signature));
  }, [signature]);
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
    if (JSON.stringify(parsed.data) === signature) void reportRead.reload();
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
    setError("");
    await exporter.run(
      data,
      { report_id: model.id, show_zero: showZero, details: detail },
      format,
    );
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
  if (report?.id === "profit-loss")
    return (
      <AccountingProfitLoss
        from={from}
        to={to}
        manage={manage}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "balance-sheet")
    return (
      <AccountingBalanceSheet
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
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
      <div className="space-y-5 lg:space-y-6">
        <AccountingPageHeader {...accountingHeader("reports", "")} />
        {REPORT_GROUPS.filter((g) => {
          if (g.name === "Customers & receivables") return false;
          if (demo && g.name === "Payroll & year end") return false;
          if (
            g.name === "Business performance" &&
            !manage.parties.some((p) => p.roles?.includes("client"))
          )
            return false;
          return true;
        }).map((g) => {
          const group = g.name;
          const Icon = g.icon;
          return (
            <Fragment key={group}>
              <section className="glass-card overflow-hidden rounded-xl md:grid md:grid-cols-[240px_1fr]">
                <div className="border-b border-border bg-secondary/20 p-6 md:border-b-0 md:border-r">
                  <Icon
                    size={20}
                    aria-hidden="true"
                    className="mb-3 text-teal-light"
                  />
                  <h2 className="font-semibold">{group}</h2>
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
                        onPointerEnter={() => warm(r.id)}
                        onFocus={() => warm(r.id)}
                        className="group h-auto w-full justify-between gap-5 rounded-none p-5 text-left font-normal whitespace-normal focus-visible:-outline-offset-2"
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
            </Fragment>
          );
        })}
      </div>
    );
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: () => navigate() }}
        title={report.title}
        subtitle={report.description}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportReport("csv")}
              disabled={!data || loading || exporting}
            >
              <Download aria-hidden="true" />
              {exporting ? "Preparing..." : "CSV"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportReport("pdf")}
              disabled={!data || loading || exporting}
            >
              <Download aria-hidden="true" />
              PDF
            </Button>
          </>
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        className="glass-card space-y-4 rounded-xl p-4 sm:p-5"
      >
        <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-[180px_1fr_1fr_auto]">
          <Select
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
          <DateInput
            label="From"
            minDate="1900-01-01"
            maxDate="2100-12-31"
            required
            value={draft.from}
            onChange={(nextValue) => setDraft({ ...draft, from: nextValue })}
          />
          <DateInput
            label="Through"
            minDate="1900-01-01"
            maxDate="2100-12-31"
            required
            value={draft.to}
            onChange={(nextValue) => setDraft({ ...draft, to: nextValue })}
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
            <Checkbox
              size="sm"
              id="report-reviewed-only"
              checked={draft.mode === "posted"}
              onChange={(checked) =>
                setDraft({ ...draft, mode: checked ? "posted" : "working" })
              }
              label="Reviewed only"
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
              Filter by contact
              {activeFilters > 0 && <Badge size="sm">{activeFilters}</Badge>}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            Cash-basis books · USD
          </span>
        </div>
        {!!draft.compare_from && (
          <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <DateInput
              label="Compare from"
              required
              value={draft.compare_from}
              onChange={(nextValue) =>
                setDraft({ ...draft, compare_from: nextValue })
              }
            />
            <DateInput
              label="Compare through"
              required
              value={draft.compare_to ?? ""}
              onChange={(nextValue) =>
                setDraft({ ...draft, compare_to: nextValue })
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
              label="Contact"
              visibleLabel="Contact"
              value={draft.payee ?? ""}
              options={[
                { value: "", label: "All contacts" },
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
      {(error || exporter.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-4 text-sm text-error"
        >
          {error || exporter.error}
        </p>
      )}
      {demo && (
        <p className="p-8 text-center text-sm text-muted-foreground">
          Detailed reports are available in configured accounting books.
        </p>
      )}
      {loading && <StatementSkeleton />}
      {data && model && !loading && (
        <>
          {(awaiting > 0 ||
            uncategorized > BigInt(0) ||
            (allActivity && data.quality.unbalanced_drafts > 0) ||
            data.quality.uncategorized_lines > 0) && (
            <div className="rounded-lg border border-copper/30 bg-copper/5 px-4 py-3 text-xs leading-relaxed">
              {allActivity && (awaiting > 0 || uncategorized > BigInt(0)) && (
                <>
                  {awaiting > 0
                    ? `Includes ${countLabel(awaiting, "transaction")} awaiting review`
                    : ""}
                  {uncategorized > BigInt(0) && (
                    <>
                      {awaiting > 0 ? ", " : ""}
                      <MaskedValue value={money(uncategorized)} /> still
                      uncategorized
                    </>
                  )}
                  {". "}
                  <button
                    type="button"
                    onClick={onReview}
                    className="inline-flex items-center gap-1 font-medium text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Review all
                  </button>{" "}
                </>
              )}
              {allActivity && data.quality.unbalanced_drafts > 0
                ? `${countLabel(data.quality.unbalanced_drafts, "incomplete transaction")} ${data.quality.unbalanced_drafts === 1 ? "is" : "are"} not included. `
                : ""}
              {!allActivity && awaiting > 0
                ? `${countLabel(awaiting, "transaction")} awaiting review ${awaiting === 1 ? "is" : "are"} not included. `
                : ""}
              {data.quality.uncategorized_lines > 0
                ? `${data.quality.uncategorized_lines} reviewed lines still need a category.`
                : ""}
            </div>
          )}
          <ReportHighlights id={report.id} data={data} />
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
            <div className="flex flex-wrap items-center gap-3">
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
                        "seg-item",
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
              onChanged={() => void reportRead.reload()}
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
              {data.filter.mode === "posted" ? "Reviewed only" : "All activity"}
            </p>
          </div>
          <Disclosure
            summary="Data coverage & reconciliation"
            contentClassName="space-y-3 text-xs text-muted-foreground"
          >
            <p>
              Reconciliation dates below are account-specific. A balanced ledger
              alone does not establish that all historical transactions have
              been imported.
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
              onClick={() => void reportRead.reload()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh coverage
            </Button>
          </Disclosure>
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
          onChanged={() => void reportRead.reload()}
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
  // Profit and loss and the balance sheet have their own screens.
  const values =
    id === "cash-flow"
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
        values.length === 4
          ? "grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-4"
          : "grid-cols-1 sm:grid-cols-3",
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
        </div>
      ))}
    </div>
  );
}
