"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { FileInput } from "@/components/ui/inputs/FileInput";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ShieldCheck, ArrowUpRight, Upload } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Select } from "@/components/ui/inputs/Select";
import { parseUsd } from "@/lib/accounting/money";
import type {
  HistoryControls,
  HistoryPreview,
  HistoryTotalKey,
  HistoryTotals,
  HistoryTotalsPreview,
  HistoryView,
} from "@/lib/accounting/history";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { uploadEvidence } from "./accounting-documents";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import {
  dateLabel,
  dateShortLabel,
  enumLabel,
  money,
  monthLabel,
} from "./format";

const emptyTotals = {
  assets_cents: "0",
  liabilities_cents: "0",
  equity_total_cents: "0",
};
const credit = (type: string) =>
  ["income", "liability", "equity"].includes(type);
async function compareHistory(
  controls: HistoryControls,
  signal?: AbortSignal,
): Promise<HistoryPreview> {
  const response = await fetch("/api/accounting/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(controls),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Unable to compare these reports.");
  return result;
}
/** Report-level comparison: the books against totals a source report states. */
async function compareTotals(
  controls: HistoryTotals,
): Promise<HistoryTotalsPreview> {
  const response = await fetch("/api/accounting/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(controls),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Unable to compare these reports.");
  return result;
}
/** Totals one Wave report states, as read by the server. */
type LoadedReport = {
  file_name: string;
  fiscal_year: number;
  kind: "opening_balances" | "annual_totals";
  report_kind: "profit_loss" | "balance_sheet";
  from: string;
  to: string;
  expected: Record<string, string>;
  source_report_type: string;
};
type MergedReports = HistoryTotals & {
  fiscal_year: number;
  source_report_type: string;
  report_kinds: LoadedReport["report_kind"][];
};
async function readWaveReports(files: File[]): Promise<LoadedReport[]> {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  const response = await fetch("/api/accounting/history/reports", {
    method: "POST",
    body: form,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Unable to read these Wave reports.");
  return result.reports;
}
/**
 * One year's reports become one comparison: the profit and loss and the
 * year-end balance sheet together, or the opening balance sheet alone.
 */
function mergeReports(reports: LoadedReport[]): MergedReports {
  const years = new Set(reports.map((r) => r.fiscal_year));
  if (years.size !== 1)
    throw new Error("Load the reports for one year at a time.");
  const kinds = reports.map((r) => r.report_kind);
  if (new Set(kinds).size !== kinds.length)
    throw new Error("Load one profit and loss and one balance sheet at most.");
  const opening = reports.some((r) => r.kind === "opening_balances");
  if (opening && kinds.includes("profit_loss"))
    throw new Error(
      "The first year on the books is verified from its opening balance sheet alone.",
    );
  const bounds = reports.flatMap((r) => [r.from, r.to]).sort();
  return {
    from: bounds[0]!,
    to: bounds[bounds.length - 1]!,
    kind: opening ? "opening_balances" : "annual_totals",
    expected: Object.assign(
      {},
      ...reports.map((r) => r.expected),
    ) as HistoryTotals["expected"],
    fiscal_year: reports[0]!.fiscal_year,
    source_report_type: reports[0]!.source_report_type,
    report_kinds: kinds,
  };
}
const totalLabels: Record<HistoryTotalKey, string> = {
  income_cents: "Total income",
  cost_of_goods_sold_cents: "Cost of goods sold",
  gross_profit_cents: "Gross profit",
  operating_expense_cents: "Operating expenses",
  expense_cents: "Total expenses",
  net_income_cents: "Net income",
  assets_cents: "Total assets",
  liabilities_cents: "Total liabilities",
  equity_total_cents: "Total equity",
};
const totalKeys = Object.keys(totalLabels) as HistoryTotalKey[];
const reportKindLabel = {
  profit_loss: "profit and loss",
  balance_sheet: "balance sheet",
} as const;
const kindLabel = (kind: string) =>
  kind === "opening_balances" ? "Opening balances" : "Annual totals";
const checkVariant: Record<
  HistoryView["checks"][number]["status"],
  BadgeVariant
> = { matches: "success", explained: "info", mismatch: "warning" };
const checkLabel: Record<HistoryView["checks"][number]["status"], string> = {
  matches: "Matches source",
  explained: "Explained",
  mismatch: "Mismatch",
};
function Money({ value }: { value: string | bigint }) {
  return (
    <MaskedValue value={money(value)} className="font-mono tabular-nums" />
  );
}
type MonthRow = HistoryPreview["monthly"][number];
const monthKeys = [
  "income_cents",
  "expense_cents",
  "net_income_cents",
] as const;
const monthFields = ["income", "expenses", "net income"];
const monthHeaders = ["Source income", "Source expenses", "Source net income"];

export function AccountingHistory({
  date,
  demo,
  onRefresh,
}: {
  date: string;
  demo: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [from, setFrom] = useState(`${date.slice(0, 4)}-01-01`),
    [to, setTo] = useState(date),
    [data, setData] = useState<HistoryPreview | null>(null),
    [history, setHistory] = useState<HistoryView | null>(null),
    [tick, setTick] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [monthly, setMonthly] = useState<Record<string, string>>({}),
    [accounts, setAccounts] = useState<Record<string, string>>({}),
    [totals, setTotals] = useState<Record<string, string>>({}),
    [doc, setDoc] = useState(""),
    [reason, setReason] = useState(""),
    [basis, setBasis] = useState(false);
  const [compared, setCompared] = useState<{
      controls: HistoryControls;
      result: HistoryPreview;
    } | null>(null),
    [verifyId, setVerifyId] = useState(() => crypto.randomUUID()),
    [lock, setLock] = useState<HistoryView["checks"][number] | null>(null);
  // What the source report proves: the opening balances of the first year on
  // the books, or a later year's annual totals.
  const [kind, setKind] = useState<"opening_balances" | "annual_totals">(
      "annual_totals",
    ),
    [explanation, setExplanation] = useState("");
  const refresh = async () => {
    setTick((t) => t + 1);
    await onRefresh();
  };
  const command = useAccountingCommand(refresh);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    setCompared(null);
    setData(null);
    Promise.all([
      compareHistory(
        { from, to, monthly: [], accounts: [], totals: emptyTotals },
        abort.signal,
      ),
      accountingGet<HistoryView>({ view: "history" }, abort.signal),
    ])
      .then(([p, h]) => {
        setData(p);
        setHistory(h);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [from, to, tick, demo]);
  function dirty() {
    setCompared(null);
    setError("");
  }
  function resetScope() {
    dirty();
    setMonthly({});
    setAccounts({});
    setTotals({});
    setDoc("");
    setBasis(false);
    setReason("");
    setExplanation("");
  }
  async function compare() {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      const controls: HistoryControls = {
        from,
        to,
        monthly: data.monthly.map((m) => ({
          from: m.from,
          to: m.to,
          income_cents: parseUsd(
            monthly[`${m.from}:income_cents`] ?? "",
          ).toString(),
          expense_cents: parseUsd(
            monthly[`${m.from}:expense_cents`] ?? "",
          ).toString(),
          net_income_cents: parseUsd(
            monthly[`${m.from}:net_income_cents`] ?? "",
          ).toString(),
        })),
        accounts: data.accounts
          .filter((a) => a.required || accounts[a.account_id]?.trim())
          .map((a) => ({
            account_id: a.account_id,
            amount_cents: (
              parseUsd(accounts[a.account_id] ?? "") *
              (credit(a.account_type) ? -BigInt(1) : BigInt(1))
            ).toString(),
          })),
        totals: {
          assets_cents: parseUsd(totals.assets_cents ?? "").toString(),
          liabilities_cents: parseUsd(
            totals.liabilities_cents ?? "",
          ).toString(),
          equity_total_cents: parseUsd(
            totals.equity_total_cents ?? "",
          ).toString(),
        },
      };
      const result = await compareHistory(controls);
      setData(result);
      setCompared({ controls, result });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Enter every required source control, including zero.",
      );
    } finally {
      setBusy(false);
    }
  }
  const monthField = (m: MonthRow, i: number, id?: string) => {
    const key = monthKeys[i];
    return (
      <>
        <TextInput
          id={id}
          label={id ? monthHeaders[i] : undefined}
          aria-label={
            id ? undefined : `${monthLabel(m.from)} source ${monthFields[i]}`
          }
          inputMode="decimal"
          placeholder="Enter source amount"
          value={monthly[`${m.from}:${key}`] ?? ""}
          onChange={(nextValue) => {
            setMonthly((v) => ({
              ...v,
              [`${m.from}:${key}`]: nextValue,
            }));
            dirty();
          }}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Books: <Money value={m.actual[key]} />
        </p>
      </>
    );
  };
  const monthlyColumns: DataTableColumn<MonthRow>[] = [
    {
      key: "period",
      header: "Period",
      className: "whitespace-nowrap align-top",
      render: (m) => (
        <>
          <p className="font-medium">{monthLabel(m.from)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {dateShortLabel(m.from)} through {dateShortLabel(m.to)}
          </p>
        </>
      ),
    },
    ...monthHeaders.map((header, i) => ({
      key: monthKeys[i],
      header,
      className: "min-w-44",
      render: (m: MonthRow) => monthField(m, i),
    })),
  ];
  const monthlyCard = (m: MonthRow) => (
    <div className="glass-card rounded-xl p-4">
      <p className="text-sm font-medium">{monthLabel(m.from)}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {dateShortLabel(m.from)} through {dateShortLabel(m.to)}
      </p>
      <div className="mt-3 space-y-3">
        {monthKeys.map((key, i) => (
          <div key={key}>{monthField(m, i, `${m.from}-${key}`)}</div>
        ))}
      </div>
    </div>
  );
  if (demo)
    return (
      <div className="glass-card rounded-xl p-6 text-sm text-muted-foreground">
        Historical verification is available in the owner books.
      </div>
    );
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Verify historical books</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Compare imported books with independent source reports before
          accepting their coverage.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => {
            command.setError("");
            setTick((t) => t + 1);
          }}
        >
          Refresh book controls
        </Button>
      </div>
      <WaveReportCheck
        onScope={(nextFrom, nextTo) => {
          setFrom(nextFrom);
          setTo(nextTo);
          resetScope();
        }}
        onRecorded={refresh}
      />
      <h3 className="pt-2 font-semibold">Or enter source controls by hand</h3>
      <section className="glass-card rounded-xl p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <DateInput
            label="Source report starts"
            value={from}
            onChange={(nextValue) => {
              if (nextValue) {
                setFrom(nextValue);
                resetScope();
              }
            }}
          />
          <DateInput
            label="Source report ends"
            minDate={from}
            value={to}
            onChange={(nextValue) => {
              if (nextValue) {
                setTo(nextValue);
                resetScope();
              }
            }}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Use one calendar-year scope. A partial year remains labeled partial;
          it does not stand in for missing earlier activity.
        </p>
      </section>
      {(error || command.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/10 p-4 text-sm text-error"
        >
          {error || command.error}
        </p>
      )}
      {!data && !error && (
        <p className="text-sm text-muted-foreground">Loading book controls…</p>
      )}
      {data && history && (
        <>
          <section className="glass-card rounded-xl p-5">
            <h3 className="font-semibold">1. Source evidence and entity</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Keep the source P&amp;L and balance sheet together in one
              supporting file. Enter the amounts from that file into the source
              fields below.
            </p>
            <div className="mt-4">
              <AccountingDocumentPicker
                value={doc}
                onChange={(id) => {
                  setDoc(id);
                  dirty();
                }}
                label="Independent source reports"
              />
            </div>
            <div className="mt-4">
              <Select
                id="history-kind"
                label="What the report proves"
                value={kind}
                onChange={(v) => {
                  setKind(
                    v === "opening_balances"
                      ? "opening_balances"
                      : "annual_totals",
                  );
                  dirty();
                }}
                options={[
                  {
                    value: "annual_totals",
                    label: "Annual totals for this year",
                  },
                  {
                    value: "opening_balances",
                    label: "Opening balances of the first year on the books",
                  },
                ]}
              />
            </div>
            <Checkbox
              className="mt-4 items-start text-left"
              checked={basis}
              onChange={(checked) => {
                setBasis(checked);
                dirty();
              }}
              label="I confirmed that these reports use cash-basis accounting and the exact dates selected above."
            />
          </section>
          <section className="glass-card overflow-hidden rounded-xl">
            <div className="border-b border-border p-5">
              <h3 className="font-semibold">2. Monthly P&amp;L controls</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Source fields stay empty until you enter them. Equal annual
                totals cannot hide a difference between months.
              </p>
            </div>
            <DataTable
              columns={monthlyColumns}
              data={data.monthly}
              keyExtractor={(m) => m.from}
              framed={false}
              className="max-lg:p-4"
              mobileCard={monthlyCard}
            />
          </section>
          <section className="glass-card overflow-hidden rounded-xl">
            <div className="border-b border-border p-5">
              <h3 className="font-semibold">3. Mapped account controls</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Use period totals for income and expense categories, ending
                balances for the balance-sheet accounts. Income, liability, and
                equity credits appear as positive report amounts. Enter zero
                explicitly where required.
              </p>
            </div>
            <div className="max-h-[520px] overflow-y-auto">
              {data.accounts
                .filter((a) => a.required)
                .map((a) => (
                  <div
                    key={a.account_id}
                    className="grid grid-cols-[1fr_150px] items-center gap-4 border-b border-border p-4 text-sm last:border-0"
                  >
                    <div>
                      <p className="font-medium">
                        {a.code} {a.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {enumLabel(a.account_type)} · Books:{" "}
                        <Money
                          value={
                            BigInt(a.actual_cents) *
                            (credit(a.account_type) ? -BigInt(1) : BigInt(1))
                          }
                        />
                      </p>
                    </div>
                    <TextInput
                      aria-label={`Source amount for ${a.name}`}
                      inputMode="decimal"
                      placeholder="Source amount"
                      value={accounts[a.account_id] ?? ""}
                      onChange={(nextValue) => {
                        setAccounts((v) => ({
                          ...v,
                          [a.account_id]: nextValue,
                        }));
                        dirty();
                      }}
                    />
                  </div>
                ))}
            </div>
          </section>
          <section className="glass-card rounded-xl p-5">
            <h3 className="font-semibold">4. Balance-sheet totals</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {[
                [
                  "assets_cents",
                  "Source total assets",
                  data.reports.assets_cents,
                ],
                [
                  "liabilities_cents",
                  "Source total liabilities",
                  data.reports.liabilities_cents,
                ],
                [
                  "equity_total_cents",
                  "Source total equity",
                  (
                    BigInt(data.reports.equity_cents) +
                    BigInt(data.reports.retained_cents) +
                    BigInt(data.reports.year_income_cents)
                  ).toString(),
                ],
              ].map(([key, label, actual]) => (
                <div key={key}>
                  <TextInput
                    label={label}
                    inputMode="decimal"
                    value={totals[key] ?? ""}
                    placeholder="Enter source amount"
                    onChange={(nextValue) => {
                      setTotals((v) => ({ ...v, [key]: nextValue }));
                      dirty();
                    }}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Books: <Money value={actual} />
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Total equity includes accumulated prior earnings and current-year
              profit. The books continue across years without posting annual
              closing entries.
            </p>
            <div className="mt-5">
              <TextInput
                label="Coverage and comparison notes"
                required
                maxLength={3000}
                value={reason}
                onChange={(nextValue) => setReason(nextValue)}
                placeholder="Identify the source report, scope, and reviewed mappings"
              />
            </div>
            <Button
              className="mt-5"
              loading={busy}
              disabled={busy || command.busy}
              onClick={() => void compare()}
            >
              Compare source reports
            </Button>
          </section>
          {compared && (
            <section
              className={`glass-card rounded-xl p-5 ${compared.result.ready ? "border-teal-light/30" : ""}`}
            >
              <div className="flex items-start gap-3">
                <ShieldCheck
                  className={
                    compared.result.ready
                      ? "text-teal-light"
                      : "text-muted-foreground"
                  }
                  size={22}
                  aria-hidden="true"
                />
                <div>
                  <h3 className="font-semibold">
                    {compared.result.ready
                      ? "Source controls agree"
                      : "Review the remaining differences"}
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {compared.result.differences} control differences ·{" "}
                    {compared.result.source_errors} source exceptions ·{" "}
                    {compared.result.drafts} drafts ·{" "}
                    {compared.result.unclassified_accounts} unclassified
                    accounts
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {!compared.result.scope_ended &&
                      "The selected scope extends beyond today. "}
                    {compared.result.partial_year
                      ? "Partial-year coverage"
                      : "Full calendar-year coverage"}{" "}
                    · {dateLabel(from)} to {dateLabel(to)}
                  </p>
                </div>
              </div>
              {compared.result.ready && (
                <Button
                  className="mt-4"
                  disabled={!doc || !basis || !reason.trim() || command.busy}
                  loading={command.busy}
                  onClick={async () => {
                    if (
                      await command.execute({
                        type: "history.verify",
                        id: verifyId,
                        expected_revision: compared.result.revision,
                        ...compared.controls,
                        document_id: doc,
                        cash_basis_confirmed: true,
                        reason,
                      })
                    ) {
                      setCompared(null);
                      setVerifyId(crypto.randomUUID());
                    }
                  }}
                >
                  <CheckCircle2 size={15} aria-hidden="true" />
                  Accept verified coverage
                </Button>
              )}
              {!compared.result.ready && (
                <div className="mt-4 space-y-4">
                  <TextInput
                    label="Explanation for the differences"
                    maxLength={3000}
                    value={explanation}
                    onChange={(nextValue) => setExplanation(nextValue)}
                    placeholder="Why the books and the source report differ"
                  />
                  <p className="text-xs text-muted-foreground">
                    Records this comparison with its evidence. With an
                    explanation and no drafts or source exceptions it is saved
                    as explained; otherwise it is saved as a mismatch.
                  </p>
                  <Button
                    variant="outline"
                    disabled={!doc || !reason.trim() || command.busy}
                    loading={command.busy}
                    onClick={async () => {
                      const note = explanation.trim();
                      if (
                        await command.execute({
                          type: "history.check",
                          id: verifyId,
                          expected_revision: compared.result.revision,
                          fiscal_year: Number(
                            compared.controls.from.slice(0, 4),
                          ),
                          kind,
                          from: compared.controls.from,
                          to: compared.controls.to,
                          document_id: doc,
                          reason,
                          ...(note ? { explanation: note } : {}),
                          expected: {
                            monthly: compared.controls.monthly,
                            accounts: compared.controls.accounts,
                            totals: compared.controls.totals,
                          },
                        })
                      ) {
                        setCompared(null);
                        setVerifyId(crypto.randomUUID());
                      }
                    }}
                  >
                    Record this comparison
                  </Button>
                </div>
              )}
            </section>
          )}
          <section className="glass-card overflow-hidden rounded-xl">
            <div className="border-b border-border p-5">
              <h3 className="font-semibold">Recorded comparisons</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                The latest comparison per year and kind is the one that counts.
                Record again after correcting the books.
              </p>
            </div>
            {!history.checks.length ? (
              <p className="p-5 text-sm text-muted-foreground">
                Recorded comparisons will appear here with their original
                evidence.
              </p>
            ) : (
              history.checks.map((h) => {
                const stated = totalKeys.filter(
                  (k) => typeof h.expected[k] === "string",
                );
                const off = stated.filter(
                  (k) => String(h.difference[k] ?? "0") !== "0",
                );
                const legacy = Number(h.difference.differences ?? 0);
                return (
                  <div
                    key={h.id}
                    className="border-b border-border p-5 last:border-0"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {h.fiscal_year} · {kindLabel(h.kind)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {dateLabel(String(h.expected.from ?? h.from_date))} to{" "}
                          {dateLabel(String(h.expected.to ?? h.to_date))} ·
                          checked {dateLabel(h.checked_at.slice(0, 10))}
                        </p>
                      </div>
                      <Badge variant={checkVariant[h.status]}>
                        {checkLabel[h.status]}
                      </Badge>
                    </div>
                    {h.explanation && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {h.explanation}
                      </p>
                    )}
                    {off.length > 0 && (
                      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                        {off.map((k) => (
                          <li key={k}>
                            {totalLabels[k]}: source{" "}
                            <Money value={String(h.expected[k])} />, books{" "}
                            <Money value={String(h.actual[k] ?? "0")} />
                          </li>
                        ))}
                      </ul>
                    )}
                    {!stated.length && legacy > 0 && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        {legacy} control differences.
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-4">
                      <a
                        className="inline-flex items-center gap-1 text-sm text-teal-light"
                        href={`/api/accounting/documents?id=${h.source_document_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Source reports
                        <ArrowUpRight size={13} aria-hidden="true" />
                      </a>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={h.status === "mismatch"}
                        onClick={() => setLock(h)}
                      >
                        Lock the covered months
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
      {lock && history && (
        <HistoryLock
          value={lock}
          revision={history.revision}
          onClose={() => setLock(null)}
          onSaved={async () => {
            setLock(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
type TotalRow = {
  key: HistoryTotalKey;
  source: string;
  books: string;
  difference: string;
};
/**
 * Loads one year's Wave exports, compares the totals they state with the
 * books, and records the comparison with the files themselves as evidence.
 */
function WaveReportCheck({
  onScope,
  onRecorded,
}: {
  onScope: (from: string, to: string) => void;
  onRecorded: () => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]),
    [merged, setMerged] = useState<MergedReports | null>(null),
    [preview, setPreview] = useState<HistoryTotalsPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reason, setReason] = useState(""),
    [explanation, setExplanation] = useState(""),
    [checkId, setCheckId] = useState(() => crypto.randomUUID()),
    [recorded, setRecorded] = useState(false);
  // Evidence uploaded for the current files, kept so a failed record retries without a second copy.
  const evidence = useRef<{ id: string; files: File[] } | null>(null);
  const active = useRef(false);
  const command = useAccountingCommand(onRecorded);
  async function load(chosen: File[]) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    command.setError("");
    setPreview(null);
    setMerged(null);
    setRecorded(false);
    setFiles(chosen);
    try {
      const next = mergeReports(await readWaveReports(chosen));
      setMerged(next);
      setReason(
        `Wave ${next.fiscal_year} ${next.report_kinds
          .map((k) => reportKindLabel[k])
          .join(" and ")} export, ${next.source_report_type}.`,
      );
      setExplanation("");
      onScope(next.from, next.to);
      setPreview(
        await compareTotals({
          from: next.from,
          to: next.to,
          kind: next.kind,
          expected: next.expected,
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to read these Wave reports.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function record() {
    if (!merged || !preview || active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      if (evidence.current?.files !== files) {
        // The reports are the evidence: one CSV holding each file as loaded.
        const texts = await Promise.all(files.map((f) => f.text()));
        const doc = await uploadEvidence(
          new File(
            [texts.join("\n\n")],
            `wave-reports-${merged.fiscal_year}.csv`,
            {
              type: "text/csv",
            },
          ),
          crypto.randomUUID(),
        );
        evidence.current = { id: doc.id, files };
      }
      // Storing the evidence advances the books revision, so compare again and
      // record against the revision the owner is looking at.
      const fresh = await compareTotals({
        from: merged.from,
        to: merged.to,
        kind: merged.kind,
        expected: merged.expected,
      });
      setPreview(fresh);
      const note = explanation.trim();
      if (
        await command.execute({
          type: "history.check",
          id: checkId,
          expected_revision: fresh.revision,
          fiscal_year: merged.fiscal_year,
          kind: merged.kind,
          from: merged.from,
          to: merged.to,
          document_id: evidence.current.id,
          reason: reason.trim(),
          ...(note ? { explanation: note } : {}),
          source_report_type: merged.source_report_type.slice(0, 100),
          expected: merged.expected,
        })
      ) {
        setRecorded(true);
        setCheckId(crypto.randomUUID());
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to record this comparison.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const rows: TotalRow[] =
    merged && preview
      ? totalKeys
          .filter((k) => merged.expected[k] !== undefined)
          .map((k) => ({
            key: k,
            source: merged.expected[k]!,
            books: preview.actual[k] ?? "0",
            difference: preview.difference[k] ?? "0",
          }))
      : [];
  const differenceCell = (row: TotalRow) => (
    <span
      className={
        row.difference === "0" ? "text-muted-foreground" : "text-warning"
      }
    >
      {row.difference === "0" ? "Agrees" : <Money value={row.difference} />}
    </span>
  );
  const columns: DataTableColumn<TotalRow>[] = [
    { key: "label", header: "Total", render: (row) => totalLabels[row.key] },
    {
      key: "source",
      header: "Wave",
      align: "right",
      numeric: true,
      render: (row) => <Money value={row.source} />,
    },
    {
      key: "books",
      header: "Books",
      align: "right",
      numeric: true,
      render: (row) => <Money value={row.books} />,
    },
    {
      key: "difference",
      header: "Books minus Wave",
      align: "right",
      numeric: true,
      render: differenceCell,
    },
  ];
  const card = (row: TotalRow) => (
    <div className="glass-card rounded-xl p-4 text-sm">
      <p className="font-medium">{totalLabels[row.key]}</p>
      <dl className="mt-2 grid grid-cols-2 gap-1 text-xs">
        <dt className="text-muted-foreground">Wave</dt>
        <dd className="text-right">
          <Money value={row.source} />
        </dd>
        <dt className="text-muted-foreground">Books</dt>
        <dd className="text-right">
          <Money value={row.books} />
        </dd>
        <dt className="text-muted-foreground">Books minus Wave</dt>
        <dd className="text-right">{differenceCell(row)}</dd>
      </dl>
    </div>
  );
  const pending = busy || command.busy;
  return (
    <section className="glass-card rounded-xl p-5">
      <h3 className="font-semibold">Wave reports</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Load one year&apos;s Wave profit and loss and balance sheet exports. The
        totals they state are compared with the books, then recorded with the
        files as evidence. The first year on the books takes its opening balance
        sheet alone.
      </p>
      <label className="mt-4 block rounded-lg border border-dashed border-border p-5 text-center">
        <Upload
          className="mx-auto mb-3 text-teal-light"
          size={22}
          aria-hidden="true"
        />
        <span className="text-sm">
          Choose the CSV exports for one year, up to two files
        </span>
        <FileInput
          aria-label="Wave report CSV files"
          className="mt-4 w-full"
          multiple
          accept=".csv,text/csv"
          disabled={pending}
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            if (chosen.length) void load(chosen);
          }}
        />
      </label>
      {busy && !preview && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Reading reports…
        </p>
      )}
      {(error || command.error) && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error || command.error}
        </p>
      )}
      {merged && preview && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="font-medium">
              {merged.fiscal_year} · {kindLabel(merged.kind)}
            </span>
            <span className="text-muted-foreground">
              {merged.report_kinds.map((k) => reportKindLabel[k]).join(" and ")}{" "}
              · {merged.source_report_type} · {dateLabel(merged.from)} to{" "}
              {dateLabel(merged.to)}
            </span>
            <Badge variant={preview.differences === 0 ? "success" : "warning"}>
              {preview.differences === 0
                ? "Totals agree"
                : `${preview.differences} differences`}
            </Badge>
          </div>
          <div className="glass-card overflow-hidden rounded-xl">
            <DataTable
              columns={columns}
              data={rows}
              keyExtractor={(row) => row.key}
              framed={false}
              className="max-lg:p-4"
              mobileCard={card}
            />
          </div>
          {(preview.drafts > 0 || preview.source_errors > 0) && (
            <p className="text-xs text-muted-foreground">
              {preview.drafts} drafts and {preview.source_errors} unresolved
              import rows fall inside this year. Post or resolve them before
              this comparison can count as verified.
            </p>
          )}
          <TextInput
            label="Comparison notes"
            required
            maxLength={3000}
            value={reason}
            onChange={(nextValue) => setReason(nextValue)}
          />
          {preview.differences > 0 && (
            <div>
              <TextInput
                label="Explanation for the differences"
                maxLength={3000}
                value={explanation}
                onChange={(nextValue) => setExplanation(nextValue)}
                placeholder="Why the books and the Wave report differ"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                With an explanation and no drafts or unresolved rows the
                comparison is saved as explained. Otherwise it is saved as a
                mismatch to revisit after correcting the books.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || !reason.trim() || recorded}
              loading={pending}
              onClick={() => void record()}
            >
              <CheckCircle2 size={15} aria-hidden="true" />
              Record Wave comparison
            </Button>
            {recorded && (
              <span role="status" className="text-sm text-teal-light">
                Recorded. It is listed under recorded comparisons below.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
function HistoryLock({
  value,
  revision,
  onClose,
  onSaved,
}: {
  value: HistoryView["checks"][number];
  revision: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Accept these historical month baselines?</DialogTitle>
          <DialogDescription>
            Lock full calendar months inside {dateLabel(value.from_date)} to{" "}
            {dateLabel(value.to_date)}, retaining this source-report parity
            proof. These records are labeled historical baselines. No local
            statement matches are invented, and no new opening balance is
            posted.
          </DialogDescription>
        </DialogHeader>
        {cmd.error && (
          <p role="alert" className="text-sm text-error">
            {cmd.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={cmd.busy} onClick={onClose}>
            Back
          </Button>
          <Button
            disabled={cmd.busy}
            loading={cmd.busy}
            onClick={() =>
              void cmd.execute({
                type: "history.lock",
                id,
                expected_revision: revision,
                history_id: value.id,
              })
            }
          >
            Lock covered full months
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
