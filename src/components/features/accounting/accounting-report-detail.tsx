"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type {
  CashClass,
  ReportDetail,
  ReportFilter,
} from "@/lib/accounting/reports";
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { AccountingPicker } from "./accounting-picker";
import { countLabel, dateLabel, enumLabel, money } from "./format";

export const cashLabels: Record<CashClass, string> = {
  operating: "Operating activities",
  investing: "Investing activities",
  financing: "Financing activities",
  internal_transfer: "Internal transfers & transit",
  unclassified: "Needs classification",
};

/** Masked, tabular money for report cells and totals. */
export function ReportMoney({ value }: { value: string | bigint }) {
  return (
    <MaskedValue
      value={money(value)}
      className="tabular-nums whitespace-nowrap"
    />
  );
}

type DetailRow = ReportDetail["rows"][number];
const PAGE_SIZE = 100;
const dash = <span className="text-muted-foreground">-</span>;

export function AccountingReportDetail({
  title,
  filter,
  revision,
  onClose,
  onEntry,
  onChanged,
  inline = false,
}: {
  title: string;
  filter: ReportFilter;
  revision: string;
  onClose: () => void;
  onEntry: (id: string) => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const [offset, setOffset] = useState(0),
    [data, setData] = useState<ReportDetail | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [cash, setCash] = useState<string | null>(null);
  const signature = JSON.stringify({ ...filter, offset });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    accountingGet<ReportDetail>(
      { view: "report-detail", filter: signature },
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
  }, [signature, revision]);
  const stale = data && data.revision !== revision;
  const cashMode = !!filter.cash_class;
  const originLabel = (r: DetailRow) =>
    `${enumLabel(r.primary_origin)}${r.status === "draft" ? " · Draft" : ""}`;
  const memoLink = (r: DetailRow) => (
    <button
      type="button"
      onClick={() => onEntry(r.entry_id)}
      className="flex items-center gap-2 text-left hover:text-teal-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="line-clamp-2">{r.memo || "Journal entry"}</span>
      <ArrowUpRight size={13} aria-hidden="true" className="shrink-0" />
    </button>
  );
  const debit = (r: DetailRow) =>
    cashMode || BigInt(r.amount_cents) > BigInt(0) ? (
      <ReportMoney value={r.amount_cents} />
    ) : (
      dash
    );
  const credit = (r: DetailRow) =>
    !cashMode && BigInt(r.amount_cents) < BigInt(0) ? (
      <ReportMoney value={-BigInt(r.amount_cents)} />
    ) : (
      dash
    );
  const trailing = (r: DetailRow) =>
    cashMode ? (
      <button
        type="button"
        disabled={r.status !== "posted"}
        onClick={() => setCash(r.id)}
        className="text-xs text-teal-light underline-offset-4 hover:underline disabled:text-muted-foreground"
      >
        {cashLabels[r.classification as CashClass] ?? "Review classification"}
      </button>
    ) : (
      <ReportMoney value={r.running_cents} />
    );
  const headers = {
    debit: cashMode ? "Cash movement" : "Debit",
    credit: "Credit",
    trailing: cashMode ? "Classification" : "Account balance",
  };
  const columns: DataTableColumn<DetailRow>[] = [
    {
      key: "date",
      header: "Date / source",
      className: "whitespace-nowrap",
      render: (r) => (
        <>
          <span>{dateLabel(r.entry_date)}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {originLabel(r)}
          </span>
        </>
      ),
    },
    {
      key: "description",
      header: "Description",
      className: "max-w-72",
      render: (r) => (
        <>
          {memoLink(r)}
          {r.line_memo && (
            <p className="mt-1 text-xs text-muted-foreground">{r.line_memo}</p>
          )}
        </>
      ),
    },
    {
      key: "account",
      header: "Account",
      className: "max-w-56",
      render: (r) => (
        <span className="text-muted-foreground">{r.account_name}</span>
      ),
    },
    {
      key: "debit",
      header: headers.debit,
      align: "right",
      numeric: true,
      render: debit,
    },
    {
      key: "credit",
      header: headers.credit,
      align: "right",
      numeric: true,
      render: credit,
    },
    {
      key: "trailing",
      header: headers.trailing,
      align: "right",
      numeric: true,
      render: trailing,
    },
  ];
  const mobileCard = (r: DetailRow) => (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 text-sm">
        <span>{dateLabel(r.entry_date)}</span>
        <span className="text-xs text-muted-foreground">{originLabel(r)}</span>
      </div>
      <div className="mt-2 text-sm">{memoLink(r)}</div>
      {r.line_memo && (
        <p className="mt-1 text-xs text-muted-foreground">{r.line_memo}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{r.account_name}</p>
      <dl className="mt-3 space-y-1 border-t border-border pt-3">
        {(
          [
            [headers.debit, debit],
            [headers.credit, credit],
            [headers.trailing, trailing],
          ] as const
        ).map(([label, cell]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{cell(r)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
  const content = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 text-xs text-muted-foreground">
        <span>
          {dateLabel(filter.from)} to {dateLabel(filter.to)} ·{" "}
          {filter.mode === "working" ? "Working preview" : "Posted books"}
        </span>
        {data && <span>{countLabel(data.total, "journal line")}</span>}
      </div>
      {error && (
        <p role="alert" className="p-5 text-sm text-error">
          {error}
        </p>
      )}
      {stale && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-secondary p-4 text-sm"
        >
          <span>
            The books changed after this report was opened. Refresh the report
            to compare the same revision.
          </span>
          <Button variant="outline" size="sm" onClick={onChanged}>
            Refresh report
          </Button>
        </div>
      )}
      {loading ? (
        <div
          role="status"
          aria-label="Loading journal lines..."
          className="p-4"
        >
          <TableSkeleton rows={6} />
        </div>
      ) : (
        data &&
        !stale && (
          <>
            <DataTable
              columns={columns}
              data={data.rows}
              keyExtractor={(r) => `${r.id}-${r.allocation_index ?? 0}`}
              framed={false}
              mobileCard={mobileCard}
              emptyState="No contributing entries in this period."
              className="p-4 lg:p-0"
              after={
                <Pagination
                  offset={offset}
                  limit={PAGE_SIZE}
                  total={data.total}
                  onChange={setOffset}
                  noun="journal lines"
                />
              }
            />
            <div className="border-t border-border px-5 py-4 text-xs text-muted-foreground">
              {cashMode
                ? "Cash movement"
                : "Net activity, debit positive / credit negative"}
              <span className="ml-3 text-sm text-foreground">
                <ReportMoney value={data.total_cents} />
              </span>
            </div>
          </>
        )
      )}
    </>
  );
  return (
    <>
      {inline ? (
        <div className="glass-card overflow-hidden rounded-xl">{content}</div>
      ) : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <DialogContent className="max-h-[90dvh] max-w-6xl overflow-y-auto p-0">
            <DialogHeader className="p-5 pr-12">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription className="sr-only">
                The journal lines behind {title}.
              </DialogDescription>
            </DialogHeader>
            {content}
          </DialogContent>
        </Dialog>
      )}
      {cash && (
        <CashAllocationEditor
          line={cash}
          onClose={() => setCash(null)}
          onSaved={() => {
            setCash(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

type CashReview = {
  id: string;
  entry_id: string;
  memo: string;
  entry_date: string;
  account_name: string;
  amount_cents: string;
  version: number;
  allocations: {
    classification: Exclude<CashClass, "unclassified">;
    amount_cents: string;
    note: string;
  }[];
  reason: string;
  status: string;
};
function CashAllocationEditor({
  line,
  onClose,
  onSaved,
}: {
  line: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<CashReview | null>(null),
    [error, setError] = useState(""),
    [reason, setReason] = useState(""),
    [rows, setRows] = useState<
      {
        key: string;
        classification: Exclude<CashClass, "unclassified">;
        amount: string;
        note: string;
      }[]
    >([]);
  const cmd = useAccountingCommand(onSaved);
  useEffect(() => {
    const controller = new AbortController();
    accountingGet<CashReview | null>(
      { view: "cash-review", line },
      controller.signal,
    )
      .then((d) => {
        if (!d) throw new Error("This is not a bank cash line.");
        setData(d);
        setReason(d.reason);
        setRows(
          (d.allocations.length
            ? d.allocations
            : [
                {
                  classification: "operating" as const,
                  amount_cents: d.amount_cents,
                  note: "",
                },
              ]
          ).map((a) => ({
            ...a,
            key: crypto.randomUUID(),
            amount: centsToDecimal(a.amount_cents),
          })),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [line]);
  let remainder: string | null = null;
  try {
    if (data)
      remainder = (
        BigInt(data.amount_cents) -
        rows.reduce((s, r) => s + parseUsd(r.amount), BigInt(0))
      ).toString();
  } catch {
    /* Incomplete amount entry. */
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Classify cash movement</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the cash activity for this bank movement.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="mt-4 text-sm text-error">
            {error}
          </p>
        )}
        {!data && !error && (
          <div
            role="status"
            aria-label="Loading cash movement..."
            className="mt-4 space-y-3"
          >
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {data && (
          <form
            className="mt-5 space-y-5"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const allocations = rows.map((r) => ({
                  classification: r.classification,
                  amount_cents: parseUsd(r.amount).toString(),
                  note: r.note,
                }));
                if (remainder !== "0")
                  throw new Error(
                    "Allocated amounts must equal the cash movement exactly.",
                  );
                await cmd.execute({
                  type: "cash.allocate",
                  id: line,
                  expected_version: data.version,
                  reason,
                  allocations,
                });
              } catch (e) {
                cmd.setError(
                  e instanceof Error ? e.message : "Check the allocations.",
                );
              }
            }}
          >
            <div className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{data.memo}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {dateLabel(data.entry_date)} · {data.account_name}
                </p>
              </div>
              <ReportMoney value={data.amount_cents} />
            </div>
            <div className="divide-y divide-border rounded-xl border border-border">
              {rows.map((r, i) => (
                <div key={r.key} className="space-y-3 p-4">
                  <div className="grid grid-cols-[1fr_120px_28px] items-end gap-2">
                    <AccountingPicker
                      label={`Activity ${i + 1}`}
                      visibleLabel="Activity"
                      value={r.classification}
                      options={Object.entries(cashLabels)
                        .filter(([key]) => key !== "unclassified")
                        .map(([value, label]) => ({ value, label }))}
                      onChange={(v) =>
                        setRows(
                          rows.map((x, j) =>
                            i === j
                              ? {
                                  ...x,
                                  classification: v as typeof r.classification,
                                }
                              : x,
                          ),
                        )
                      }
                    />
                    <TextInput
                      label="Amount"
                      required
                      value={r.amount}
                      onChange={(nextValue) =>
                        setRows(
                          rows.map((x, j) =>
                            i === j ? { ...x, amount: nextValue } : x,
                          ),
                        )
                      }
                    />
                    <Tooltip content={`Remove allocation ${i + 1}`}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        aria-label={`Remove allocation ${i + 1}`}
                        disabled={rows.length === 1 || cmd.busy}
                        onClick={() => setRows(rows.filter((_, j) => i !== j))}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </Tooltip>
                  </div>
                  <TextInput
                    label="Note"
                    required
                    maxLength={500}
                    value={r.note}
                    onChange={(nextValue) =>
                      setRows(
                        rows.map((x, j) =>
                          i === j ? { ...x, note: nextValue } : x,
                        ),
                      )
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={rows.length >= 100 || cmd.busy}
                onClick={() =>
                  setRows([
                    ...rows,
                    {
                      key: crypto.randomUUID(),
                      classification: "operating",
                      amount: remainder ? centsToDecimal(remainder) : "",
                      note: "",
                    },
                  ])
                }
              >
                <Plus size={14} aria-hidden="true" />
                Split
              </Button>
              <span className="text-xs text-muted-foreground">
                Unallocated:{" "}
                {remainder === null ? (
                  "Check amounts"
                ) : (
                  <ReportMoney value={remainder} />
                )}
              </span>
            </div>
            <TextInput
              label="Reason"
              required
              maxLength={1000}
              value={reason}
              onChange={(nextValue) => setReason(nextValue)}
            />
            {cmd.error && (
              <p role="alert" className="text-sm text-error">
                {cmd.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={cmd.busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  cmd.busy || remainder !== "0" || data.status !== "posted"
                }
              >
                {cmd.busy ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
