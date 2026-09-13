"use client";
import { useEffect, useState } from "react";
import { Check, Search, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Pagination } from "@/components/ui/pagination";
import { SectionHeader } from "@/components/ui/section-header";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { BankReview } from "@/lib/accounting/bank-matching";
import { parseUsd, centsToDecimal } from "@/lib/accounting/money";
import { dateLabel, money } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

type Candidate = BankReview["candidates"][number];
type Match = BankReview["matches"][number];
const PAGE = 25;

export function AccountingBankMatch({
  groupId,
  onClose,
  onSaved,
  onEntry,
}: {
  groupId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [data, setData] = useState<BankReview | null>(null),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<Candidate | null>(null),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [release, setRelease] = useState<{ id: string; match: Match } | null>(null),
    [releaseReason, setReleaseReason] = useState("");
  const command = useAccountingCommand();
  const { confirm, dialog } = useConfirmationDialog();
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      accountingGet<BankReview>(
        { view: "bank-review", group: groupId, query, offset: String(offset) },
        abort.signal,
      )
        .then((r) => {
          setData(r);
          setError("");
        })
        .catch((e) => {
          if (!abort.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [groupId, query, offset, tick]);
  let cents: bigint | null = null;
  try {
    cents = parseUsd(amount);
  } catch {}
  const remaining = BigInt(data?.remaining_cents ?? "0"),
    full = remaining === BigInt(0),
    completes = full || cents === remaining;
  const valid =
    !!data &&
    !data.source_conflict &&
    !loading &&
    !!reason.trim() &&
    (full ||
      (!!selected &&
        cents !== null &&
        cents > BigInt(0) &&
        cents <= remaining &&
        cents <= BigInt(selected.available_cents)));
  // A duplicate that is already fully allocated has nothing left to confirm.
  const canSave = !!data && (!full || data.group.status !== "duplicate");
  async function refreshed() {
    setSelected(null);
    setAmount("");
    setTick((t) => t + 1);
    await onSaved();
  }
  async function save() {
    if (!data || !valid) return;
    const result = await command.execute({
      type: "bank.match",
      id,
      group_id: groupId,
      expected_revision: data.revision,
      reason,
      allocations: full
        ? []
        : [{ line_id: selected!.line_id, amount_cents: cents!.toString() }],
      // Completing the movement retires the drafts that stand for the same source.
      discard_drafts: completes
        ? data.drafts.map((d) => ({ id: d.id, expected_version: d.version }))
        : [],
    });
    if (result) await refreshed();
  }
  async function releaseMatch() {
    if (!release || !data) return;
    const result = await command.execute({
      type: "bank.release",
      id: release.id,
      match_id: release.match.id,
      expected_revision: data.revision,
      reason: releaseReason,
    });
    if (result) {
      setRelease(null);
      setReleaseReason("");
      await refreshed();
    }
  }
  async function close() {
    if (command.busy) return;
    if (selected) {
      const ok = await confirm({
        title: "Discard selection?",
        description: "The selected bank line and amount will not be saved.",
        confirmLabel: "Discard",
        variant: "warning",
      });
      if (!ok) return;
    }
    onClose();
  }
  const frozen = loading || command.busy;
  function pick(candidate: Candidate) {
    if (frozen) return;
    setSelected(candidate);
    setAmount(
      centsToDecimal(
        BigInt(candidate.available_cents) < remaining
          ? BigInt(candidate.available_cents)
          : remaining,
      ),
    );
  }
  const matchColumns: DataTableColumn<Match>[] = [
    {
      key: "entry",
      header: "Entry",
      render: (m) => (
        <button
          type="button"
          className="text-left text-sm hover:text-teal-light"
          onClick={() => onEntry(m.entry_id)}
        >
          {m.memo}
          <span className="mt-1 block text-xs text-muted-foreground">
            {dateLabel(m.entry_date)} · Open entry
          </span>
        </button>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      render: (m) => (
        <MaskedValue value={money(m.amount_cents)} className="tabular-nums" />
      ),
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      render: (m) =>
        m.release ? (
          <span className="text-xs text-muted-foreground">
            Released: {m.release.reason}
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={frozen}
            onClick={() => {
              setRelease({ id: crypto.randomUUID(), match: m });
              setReleaseReason("");
            }}
          >
            Release match
          </Button>
        ),
    },
  ];
  const candidateColumns: DataTableColumn<Candidate>[] = [
    {
      key: "memo",
      header: "Bank line",
      render: (c) => (
        <button
          type="button"
          disabled={frozen}
          className="text-left font-medium hover:text-teal-light disabled:opacity-50"
          onClick={() => pick(c)}
        >
          {c.memo}
        </button>
      ),
    },
    {
      key: "date",
      header: "Date",
      className: "whitespace-nowrap",
      render: (c) => (
        <>
          {dateLabel(c.entry_date)}
          <span className="block text-xs text-muted-foreground">
            {c.days_apart} days from source
          </span>
        </>
      ),
    },
    {
      key: "available",
      header: "Available",
      align: "right",
      numeric: true,
      render: (c) => (
        <MaskedValue
          value={money(c.available_cents)}
          className="tabular-nums"
        />
      ),
    },
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Match bank movement</DialogTitle>
          <DialogDescription className="sr-only">
            Attach this imported movement to posted bank lines.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-5">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!data && loading && (
            <div
              role="status"
              aria-label="Loading bank movement..."
              className="space-y-5"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-5 w-24" />
              </div>
              <TableSkeleton rows={3} />
            </div>
          )}
          {data && (
            <>
              {data.source_conflict && (
                <p role="alert" className="text-sm text-warning">
                  The source record changed. Resolve it before matching.
                </p>
              )}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{data.group.memo}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateLabel(data.group.entry_date)} ·{" "}
                    {data.group.account_name} · {data.group.source_system} ·{" "}
                    {data.group.source_scope}
                  </p>
                </div>
                <div className="text-right">
                  <MaskedValue
                    value={money(data.group.bank_amount_cents)}
                    className="tabular-nums"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Remaining{" "}
                    <MaskedValue
                      value={money(data.remaining_cents)}
                      className="tabular-nums"
                    />
                  </p>
                </div>
              </div>
              {data.matches.length > 0 && (
                <section>
                  <SectionHeader
                    label="Recorded matches"
                    count={data.matches.length}
                  />
                  <DataTable
                    columns={matchColumns}
                    data={data.matches}
                    keyExtractor={(m) => m.id}
                    mobileCard={(m) => (
                      <div className="glass-card rounded-xl p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 text-sm">
                            {m.memo}
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {dateLabel(m.entry_date)}
                            </span>
                          </div>
                          <MaskedValue
                            value={money(m.amount_cents)}
                            className="shrink-0 text-sm tabular-nums"
                          />
                        </div>
                        {m.release ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Released: {m.release.reason}
                          </p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="link"
                            className="px-0"
                            onClick={() => onEntry(m.entry_id)}
                          >
                            Open entry
                          </Button>
                          {!m.release && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={frozen}
                              onClick={() => {
                                setRelease({
                                  id: crypto.randomUUID(),
                                  match: m,
                                });
                                setReleaseReason("");
                              }}
                            >
                              Release match
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  />
                </section>
              )}
              {release && (
                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-sm font-medium">
                    Release {release.match.memo}
                  </p>
                  <TextInput
                    label="Reason"
                    placeholder="Why this match is wrong"
                    value={releaseReason}
                    onChange={(nextValue) => setReleaseReason(nextValue)}
                    maxLength={1000}
                    required
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={command.busy}
                      onClick={() => setRelease(null)}
                    >
                      Keep match
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        command.busy || !releaseReason.trim() || loading
                      }
                      onClick={() =>
                        void releaseMatch().catch((e) => setError(e.message))
                      }
                    >
                      Release
                    </Button>
                  </div>
                </div>
              )}
              {!full && (
                <section className="space-y-3">
                  <TextInput
                    label="Posted bank line"
                    leftIcon={Search}
                    placeholder="Search a description or YYYY-MM-DD"
                    value={query}
                    onChange={(nextValue) => {
                      setQuery(nextValue);
                      setOffset(0);
                      setSelected(null);
                    }}
                  />
                  <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
                    <DataTable
                      columns={candidateColumns}
                      data={data.candidates}
                      keyExtractor={(c) => c.line_id}
                      onRowClick={pick}
                      busy={loading}
                      framed={false}
                      emptyState="No available bank lines match this search."
                      rowClassName={(c) =>
                        selected?.line_id === c.line_id
                          ? "bg-primary/10"
                          : undefined
                      }
                      mobileCard={(c) => (
                        <button
                          type="button"
                          disabled={frozen}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 text-left text-sm transition-colors disabled:opacity-50",
                            selected?.line_id === c.line_id && "bg-primary/10",
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            pick(c);
                          }}
                        >
                          <span className="min-w-0 break-words">
                            <span className="block font-medium">{c.memo}</span>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {dateLabel(c.entry_date)} · {c.days_apart} days
                              from source
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <MaskedValue
                              value={money(c.available_cents)}
                              className="tabular-nums"
                            />
                            <span className="mt-1 block text-xs text-muted-foreground">
                              Available
                            </span>
                          </span>
                        </button>
                      )}
                    />
                  </div>
                  <Pagination
                    offset={offset}
                    limit={PAGE}
                    total={data.total}
                    busy={loading}
                    onChange={setOffset}
                  />
                  {selected && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm font-medium">
                          {selected.memo}
                        </p>
                        <Button
                          size="sm"
                          variant="link"
                          className="h-auto shrink-0 px-0"
                          onClick={() => onEntry(selected.entry_id)}
                        >
                          Inspect
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </Button>
                      </div>
                      <TextInput
                        label="Amount (USD)"
                        inputMode="decimal"
                        value={amount}
                        onChange={setAmount}
                        description={
                          completes
                            ? "Completes the movement"
                            : "The rest stays in review"
                        }
                      />
                    </div>
                  )}
                </section>
              )}
              {full && (
                <p
                  role="status"
                  className="flex items-center gap-2 text-sm text-teal-light"
                >
                  <Check size={16} aria-hidden="true" />
                  This movement is fully allocated.
                </p>
              )}
              {completes && data.drafts.length > 0 && (
                <div>
                  <p className="text-sm font-medium">
                    Drafts discarded on completion
                  </p>
                  <div className="mt-2 divide-y divide-border rounded-xl border border-border text-sm">
                    {data.drafts.map((d) => (
                      <details key={d.id} className="px-4 py-3">
                        <summary className="cursor-pointer">
                          {dateLabel(d.entry_date)} · {d.memo}
                        </summary>
                        <div className="mt-2 space-y-1 pl-3">
                          {d.lines.map((l) => (
                            <div
                              key={l.id}
                              className="flex justify-between gap-3"
                            >
                              <span>{l.account_name}</span>
                              <MaskedValue
                                value={money(l.amount_cents)}
                                className="tabular-nums"
                              />
                            </div>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              )}
              {canSave && (
                <TextInput
                  label="Reason"
                  placeholder="How the source and posting agree"
                  value={reason}
                  onChange={(nextValue) => setReason(nextValue)}
                  maxLength={1000}
                  required
                />
              )}
            </>
          )}
          {command.error && (
            <p role="alert" className="text-sm text-destructive">
              {command.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={command.busy}
              onClick={() => void close()}
            >
              {canSave ? "Cancel" : "Close"}
            </Button>
            {canSave && (
              <Button
                disabled={!valid || command.busy || !!release}
                loading={command.busy}
                onClick={() => void save().catch((e) => setError(e.message))}
              >
                {full ? "Confirm" : "Match"}
              </Button>
            )}
          </div>
        </div>
        {dialog}
      </DialogContent>
    </Dialog>
  );
}
