"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { formatCents, parseUsd, centsToDecimal } from "@/lib/accounting/money";
import type { ClearingView } from "@/lib/accounting/close";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

type Row = ClearingView["rows"][number];
export function AccountingClearing({
  date,
  onRefresh,
  onEntry,
}: {
  date: string;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const [asOf, setAsOf] = useState(date),
    [data, setData] = useState<ClearingView | null>(null),
    [tick, setTick] = useState(0),
    [error, setError] = useState(""),
    [account, setAccount] = useState("");
  const [action, setAction] = useState<{
      id: string;
      kind: "match" | "review";
      row: Row;
    } | null>(null),
    [release, setRelease] = useState<
      ClearingView["allocations"][number] | null
    >(null);
  const refresh = async () => {
    setTick((t) => t + 1);
    await onRefresh();
  };
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    accountingGet<ClearingView>({ view: "clearing", date: asOf }, abort.signal)
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [asOf, tick]);
  const accounts = Array.from(
      new Map(data?.rows.map((r) => [r.account_id, r.account_name]) ?? []),
    ),
    rows = data?.rows.filter((r) => !account || r.account_id === account) ?? [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Clearing balances</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Match obligations to settlements and document genuine timing items.
          </p>
        </div>
        <Input
          label="Outstanding as of"
          type="date"
          value={asOf}
          onChange={(e) => {
            if (e.target.value) setAsOf(e.target.value);
          }}
        />
      </div>
      <label className="block max-w-sm text-sm">
        Account
        <select
          className="mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">All clearing accounts</option>
          {accounts.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <section className="glass-card overflow-hidden">
        <div className="border-b border-border p-5 font-semibold">
          Outstanding items ({rows.length})
        </div>
        {!data && !error ? (
          <p className="p-5 text-sm text-muted-foreground">Loading balances…</p>
        ) : !rows.length ? (
          <p className="p-5 text-sm text-muted-foreground">
            No outstanding items in this scope.
          </p>
        ) : (
          rows.map((r) => (
            <div
              key={r.line_id}
              className="border-b border-border p-5 last:border-0"
            >
              <div className="flex justify-between gap-4">
                <div>
                  <button
                    onClick={() => onEntry(r.entry_id)}
                    className="text-left text-sm font-medium hover:underline"
                  >
                    {r.memo}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.account_name} · {r.entry_date}
                  </p>
                </div>
                <MaskedValue
                  value={formatCents(r.residual_cents)}
                  className="font-mono text-sm tabular-nums"
                />
              </div>
              {r.review && (
                <p className="mt-3 rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground">
                  Expected settlement {r.review.expected_resolution}:{" "}
                  {r.review.reason}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setAction({
                      id: crypto.randomUUID(),
                      kind: "match",
                      row: r,
                    })
                  }
                >
                  Match settlement
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setAction({
                      id: crypto.randomUUID(),
                      kind: "review",
                      row: r,
                    })
                  }
                >
                  Document timing item
                </Button>
              </div>
            </div>
          ))
        )}
      </section>
      <section className="glass-card overflow-hidden">
        <div className="border-b border-border p-5">
          <h3 className="font-semibold">Settlement history</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Latest 500 allocations through this date. Releases retain the
            historical matching record.
          </p>
        </div>
        {data?.allocations.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5 text-sm last:border-0"
          >
            <div className="min-w-0">
              <button
                className="block max-w-full truncate text-left hover:underline"
                onClick={() => onEntry(a.obligation_entry_id)}
              >
                {a.obligation_memo}
              </button>
              <button
                className="mt-1 block max-w-full truncate text-left text-xs text-muted-foreground hover:underline"
                onClick={() => onEntry(a.settlement_entry_id)}
              >
                Settled by {a.settlement_memo} · {a.effective_date}
              </button>
              <p className="mt-1 text-xs text-muted-foreground">
                {a.account_name}
                {a.released
                  ? ` · Released ${a.released.effective_date}: ${a.released.reason}`
                  : ""}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <MaskedValue
                value={formatCents(a.amount_cents)}
                className="font-mono tabular-nums"
              />
              {!a.released && (
                <Button variant="ghost" size="sm" onClick={() => setRelease(a)}>
                  Release match
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
      {action && data && (
        <ClearingAction
          value={action}
          data={data}
          onClose={() => setAction(null)}
          onSaved={async () => {
            setAction(null);
            await refresh();
          }}
        />
      )}
      {release && data && (
        <ReleaseAction
          value={release}
          data={data}
          onClose={() => setRelease(null)}
          onSaved={async () => {
            setRelease(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
function ClearingAction({
  value,
  data,
  onClose,
  onSaved,
}: {
  value: { id: string; kind: "match" | "review"; row: Row };
  data: ClearingView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [line, setLine] = useState(""),
    [reason, setReason] = useState(""),
    [amount, setAmount] = useState(
      centsToDecimal(
        BigInt(value.row.residual_cents) < BigInt(0)
          ? -BigInt(value.row.residual_cents)
          : BigInt(value.row.residual_cents),
      ),
    ),
    [expected, setExpected] = useState(""),
    [doc, setDoc] = useState("");
  const cmd = useAccountingCommand(onSaved),
    match = value.kind === "match";
  const candidates = data.rows.filter(
    (r) =>
      r.line_id !== value.row.line_id &&
      r.account_id === value.row.account_id &&
      BigInt(r.residual_cents) > BigInt(0) !==
        BigInt(value.row.residual_cents) > BigInt(0),
  );
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {match
              ? "Match a clearing settlement"
              : "Document an outstanding item"}
          </DialogTitle>
          <DialogDescription>
            {value.row.memo} · {formatCents(value.row.residual_cents)}{" "}
            outstanding on {data.as_of}.{" "}
            {match
              ? "Choose the opposite side of this same account. Partial matching is supported."
              : "Attach support and a specific expected resolution date. A note cannot make a financial difference disappear."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              if (match)
                await cmd.execute({
                  type: "clearing.allocate",
                  id: value.id,
                  expected_revision: data.revision,
                  obligation_line_id: value.row.line_id,
                  settlement_line_id: line,
                  amount_cents: parseUsd(amount).toString(),
                  reason,
                });
              else
                await cmd.execute({
                  type: "clearing.review",
                  id: value.id,
                  expected_revision: data.revision,
                  line_id: value.row.line_id,
                  as_of: data.as_of,
                  residual_cents: value.row.residual_cents,
                  expected_resolution: expected,
                  document_id: doc,
                  reason,
                });
            } catch (e) {
              cmd.setError(
                e instanceof Error ? e.message : "Check this allocation.",
              );
            }
          }}
        >
          {match ? (
            <>
              <label className="block text-sm">
                Settlement transaction
                <select
                  required
                  className="mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm"
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                >
                  <option value="">Choose a posted opposite-side amount</option>
                  {candidates.map((r) => (
                    <option key={r.line_id} value={r.line_id}>
                      {r.entry_date} · {r.memo} ·{" "}
                      {formatCents(r.residual_cents)}
                    </option>
                  ))}
                </select>
              </label>
              {!candidates.length && (
                <p className="text-xs text-muted-foreground">
                  No opposite-side item exists as of this date. Record the
                  settlement or view a later date.
                </p>
              )}
              <Input
                label="Amount to allocate (positive)"
                required
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </>
          ) : (
            <>
              <Input
                label="Expected resolution date"
                type="date"
                min={data.as_of}
                required
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
              <AccountingDocumentPicker value={doc} onChange={setDoc} />
            </>
          )}
          <Input
            label={match ? "Matching reason" : "Timing explanation"}
            required
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <Button type="submit" disabled={cmd.busy} loading={cmd.busy}>
            Save {match ? "allocation" : "review"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function ReleaseAction({
  value,
  data,
  onClose,
  onSaved,
}: {
  value: ClearingView["allocations"][number];
  data: ClearingView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID()),
    [date, setDate] = useState(data.as_of),
    [reason, setReason] = useState("");
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
          <DialogTitle>Release this clearing match?</DialogTitle>
          <DialogDescription>
            The allocation remains in history. Its amount becomes outstanding
            again on the effective release date, which must be open.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await cmd.execute({
              type: "clearing.release",
              id,
              expected_revision: data.revision,
              allocation_id: value.id,
              effective_date: date,
              reason,
            });
          }}
        >
          <Input
            label="Release date"
            type="date"
            min={value.effective_date}
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Input
            label="Reason"
            required
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <Button type="submit" disabled={cmd.busy} loading={cmd.busy}>
            Release allocation
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
