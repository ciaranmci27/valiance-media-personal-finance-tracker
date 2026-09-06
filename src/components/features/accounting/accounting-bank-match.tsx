"use client";
import { useEffect, useState } from "react";
import { Link2, Check, Search, ArrowUpRight } from "lucide-react";
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
import type { BankReview } from "@/lib/accounting/bank-matching";
import { formatCents, parseUsd, centsToDecimal } from "@/lib/accounting/money";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

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
    [selected, setSelected] = useState<BankReview["candidates"][number] | null>(
      null,
    ),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState(""),
    [approved, setApproved] = useState(false),
    [release, setRelease] = useState<{
      id: string;
      match: BankReview["matches"][number];
    } | null>(null),
    [releaseReason, setReleaseReason] = useState("");
  const command = useAccountingCommand();
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
        cents <= BigInt(selected.available_cents))) &&
    (!completes || !data.drafts.length || approved);
  async function refreshed() {
    setSelected(null);
    setAmount("");
    setApproved(false);
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
      discard_drafts:
        completes && approved
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
  const close = () => {
    if (command.busy) return;
    if (
      selected &&
      !window.confirm("Discard this unsaved bank match selection?")
    )
      return;
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[92dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Match bank evidence</DialogTitle>
          <DialogDescription>
            Attach this imported movement to posted bank lines. Partial matches
            never create another posting.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-5">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!data && loading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading bank movement…
            </p>
          )}
          {data && (
            <>
              {data.source_conflict && (
                <p
                  role="alert"
                  className="rounded-lg border border-amber-500/30 p-3 text-sm"
                >
                  This provider identity has conflicting dates, accounts, or
                  amounts in the source history. Resolve the changed source
                  record before matching it.
                </p>
              )}
              <section className="rounded-lg border border-border bg-secondary/30 p-4">
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{data.group.memo}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {data.group.entry_date} · {data.group.account_name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {data.group.source_system} · {data.group.source_scope}
                    </p>
                  </div>
                  <div className="text-right">
                    <MaskedValue
                      value={formatCents(data.group.bank_amount_cents)}
                      className="font-mono"
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Remaining:{" "}
                      <MaskedValue value={formatCents(data.remaining_cents)} />
                    </p>
                  </div>
                </div>
              </section>
              {data.matches.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">Recorded matches</h3>
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {data.matches.map((m) => (
                      <div key={m.id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <button
                            className="text-left text-sm hover:text-primary"
                            onClick={() => onEntry(m.entry_id)}
                          >
                            {m.memo}
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {m.entry_date} · Open entry
                            </span>
                          </button>
                          <MaskedValue
                            value={formatCents(m.amount_cents)}
                            className="text-sm font-mono"
                          />
                        </div>
                        {m.release ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            Released: {m.release.reason}
                          </p>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={command.busy || loading}
                            onClick={() => {
                              setRelease({ id: crypto.randomUUID(), match: m });
                              setReleaseReason("");
                            }}
                          >
                            Release match
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {release && (
                <section className="rounded-lg border border-amber-500/30 p-4">
                  <h3 className="text-sm font-medium">
                    Release this evidence match
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {release.match.memo}. The posted transaction stays in the
                    books; this source returns to review.
                  </p>
                  <Input
                    label="Release reason"
                    className="mt-3"
                    value={releaseReason}
                    onChange={(e) => setReleaseReason(e.target.value)}
                    maxLength={1000}
                  />
                  <div className="mt-3 flex justify-end gap-2">
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
                      Release match
                    </Button>
                  </div>
                </section>
              )}
              {!full && (
                <section className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Search size={16} className="text-muted-foreground" />
                    <h3 className="text-sm font-medium">
                      Find a posted bank line
                    </h3>
                  </div>
                  <Input
                    aria-label="Search matching entries"
                    placeholder="Search a description or exact YYYY-MM-DD date"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setOffset(0);
                      setSelected(null);
                      setApproved(false);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Closest dates appear first. Available amounts exclude
                    allocations already made by this source.
                  </p>
                  <div
                    className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border"
                    aria-busy={loading}
                  >
                    {data.candidates.map((c) => (
                      <button
                        key={c.line_id}
                        disabled={loading || command.busy}
                        className={`flex w-full items-start justify-between gap-3 p-3 text-left text-sm transition-colors ${selected?.line_id === c.line_id ? "bg-primary/10" : "hover:bg-secondary/40"}`}
                        onClick={() => {
                          setSelected(c);
                          setAmount(
                            centsToDecimal(
                              BigInt(c.available_cents) < remaining
                                ? BigInt(c.available_cents)
                                : remaining,
                            ),
                          );
                          setApproved(false);
                        }}
                      >
                        <span>
                          <span className="block font-medium">{c.memo}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {c.entry_date} · {c.days_apart} days from source
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <MaskedValue
                            value={formatCents(c.available_cents)}
                            className="font-mono"
                          />
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Available
                          </span>
                        </span>
                      </button>
                    ))}
                    {!data.candidates.length && (
                      <p className="p-4 text-sm text-muted-foreground">
                        No available bank lines match this search.
                      </p>
                    )}
                  </div>
                  {data.total > 25 && (
                    <div className="flex justify-between">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={loading || !offset}
                        onClick={() => setOffset((o) => Math.max(0, o - 25))}
                      >
                        Previous
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {offset + 1}–{Math.min(offset + 25, data.total)} of{" "}
                        {data.total}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={loading || offset + 25 >= data.total}
                        onClick={() => setOffset((o) => o + 25)}
                      >
                        Next
                      </Button>
                    </div>
                  )}
                  {selected && (
                    <div className="rounded-lg border border-primary/30 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-medium">{selected.memo}</p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onEntry(selected.entry_id)}
                        >
                          <ArrowUpRight size={14} />
                          Inspect
                        </Button>
                      </div>
                      <Input
                        label="Amount to match (USD)"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => {
                          setAmount(e.target.value);
                          setApproved(false);
                        }}
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        {completes
                          ? "This completes the source movement."
                          : "Any unmatched amount remains in review."}
                      </p>
                    </div>
                  )}
                </section>
              )}
              {full && (
                <p
                  role="status"
                  className="flex items-center gap-2 text-sm text-primary"
                >
                  <Check size={16} />
                  This source movement is fully allocated.
                </p>
              )}
              {completes && data.drafts.length > 0 && (
                <section className="space-y-3 rounded-lg border border-amber-500/30 p-4">
                  <h3 className="text-sm font-medium">
                    Resolve redundant imported drafts
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    These unposted drafts represent the same source. Completing
                    the match discards them and retains their history and linked
                    documents.
                  </p>
                  {data.drafts.map((d) => (
                    <details key={d.id} className="text-sm">
                      <summary className="cursor-pointer">
                        {d.entry_date} · {d.memo}
                      </summary>
                      <div className="mt-2 space-y-1 pl-3">
                        {d.lines.map((l) => (
                          <div
                            key={l.id}
                            className="flex justify-between gap-3"
                          >
                            <span>{l.account_name}</span>
                            <MaskedValue value={formatCents(l.amount_cents)} />
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={approved}
                      onChange={(e) => setApproved(e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      I reviewed these drafts and approve discarding them when
                      this match completes.
                    </span>
                  </label>
                </section>
              )}
              {(!full || data.group.status !== "duplicate") && (
                <>
                  <Input
                    label="Matching reason"
                    placeholder="Explain how the source and posting agree"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={1000}
                  />
                  <div className="flex justify-end">
                    <Button
                      disabled={!valid || command.busy || !!release}
                      loading={command.busy}
                      onClick={() =>
                        void save().catch((e) => setError(e.message))
                      }
                    >
                      <Link2 size={15} />
                      {full
                        ? "Confirm existing allocation"
                        : completes
                          ? "Complete match"
                          : "Save partial match"}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
          {command.error && (
            <p role="alert" className="text-sm text-destructive">
              {command.error}
            </p>
          )}
          <div className="flex justify-between border-t border-border pt-4">
            <Button
              variant="ghost"
              disabled={command.busy}
              onClick={() => {
                setSelected(null);
                setApproved(false);
                setTick((t) => t + 1);
              }}
            >
              Refresh review
            </Button>
            <Button variant="outline" disabled={command.busy} onClick={close}>
              Done
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
