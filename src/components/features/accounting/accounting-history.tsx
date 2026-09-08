"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import { CustomSelect } from "@/components/ui/select";
import { parseUsd } from "@/lib/accounting/money";
import type {
  HistoryControls,
  HistoryPreview,
  HistoryView,
} from "@/lib/accounting/history";
import { AccountingDocumentPicker } from "./accounting-document-picker";
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
        <Input
          id={id}
          label={id ? monthHeaders[i] : undefined}
          aria-label={
            id ? undefined : `${monthLabel(m.from)} source ${monthFields[i]}`
          }
          inputMode="decimal"
          placeholder="Enter source amount"
          value={monthly[`${m.from}:${key}`] ?? ""}
          onChange={(e) => {
            setMonthly((v) => ({
              ...v,
              [`${m.from}:${key}`]: e.target.value,
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
      <section className="glass-card rounded-xl p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Source report starts"
            type="date"
            value={from}
            onChange={(e) => {
              if (e.target.value) {
                setFrom(e.target.value);
                resetScope();
              }
            }}
          />
          <Input
            label="Source report ends"
            type="date"
            min={from}
            value={to}
            onChange={(e) => {
              if (e.target.value) {
                setTo(e.target.value);
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
              <CustomSelect
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
                    <Input
                      aria-label={`Source amount for ${a.name}`}
                      inputMode="decimal"
                      placeholder="Source amount"
                      value={accounts[a.account_id] ?? ""}
                      onChange={(e) => {
                        setAccounts((v) => ({
                          ...v,
                          [a.account_id]: e.target.value,
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
                  <Input
                    label={label}
                    inputMode="decimal"
                    value={totals[key] ?? ""}
                    placeholder="Enter source amount"
                    onChange={(e) => {
                      setTotals((v) => ({ ...v, [key]: e.target.value }));
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
              <Input
                label="Coverage and comparison notes"
                required
                maxLength={3000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
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
                  <Input
                    label="Explanation for the differences"
                    maxLength={3000}
                    value={explanation}
                    onChange={(e) => setExplanation(e.target.value)}
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
              <h3 className="font-semibold">Saved verifications</h3>
            </div>
            {!history.checks.length ? (
              <p className="p-5 text-sm text-muted-foreground">
                Accepted comparisons will appear here with their original
                evidence.
              </p>
            ) : (
              history.checks.map((h) => (
                <div
                  key={h.id}
                  className="border-b border-border p-5 last:border-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                      {dateLabel(h.from_date)} to {dateLabel(h.to_date)}
                    </p>
                    <Badge variant={h.invalidated ? "warning" : "info"}>
                      {h.invalidated
                        ? "Needs fresh comparison"
                        : h.controls.proof.partial_year
                          ? "Verified partial year"
                          : "Verified full year"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {h.explanation}
                  </p>
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
                      disabled={
                        h.invalidated ||
                        h.eligible_months === 0 ||
                        (h.locked_months ?? []).length >= h.eligible_months
                      }
                      onClick={() => setLock(h)}
                    >
                      Review historical month locks
                    </Button>
                  </div>
                  {(h.locked_months ?? []).length > 0 && (
                    <p className="mt-3 text-xs text-teal-light">
                      Historical baselines locked:{" "}
                      {h.locked_months.map((m) => monthLabel(m)).join(", ")}.
                    </p>
                  )}
                </div>
              ))
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
