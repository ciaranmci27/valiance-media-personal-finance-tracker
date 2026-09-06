"use client";

import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Filter,
  Search,
  FileText,
  BookmarkPlus,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import type {
  AccountingAccount,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type { RegisterFilter, ManageData } from "@/lib/accounting/workflows";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

const selectClass =
  "h-10 rounded-lg border border-border bg-input px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring";
interface RegisterResult {
  entries: JournalEntry[];
  total: number;
  offset: number;
  limit: number;
  revision: string;
}
export function AccountingRegister({
  from,
  to,
  accounts,
  onSelect,
  revision,
  initialAccount = "",
  initialStatus = "all",
  demoEntries,
  onSaveView,
  initialFilter = {},
  manage,
  onUseView,
  onRefresh,
}: {
  from: string;
  to: string;
  accounts: AccountingAccount[];
  onSelect: (entry: JournalEntry) => void;
  revision: string;
  initialAccount?: string;
  initialStatus?: "all" | "draft" | "posted";
  demoEntries?: JournalEntry[];
  onSaveView?: (filter: Partial<RegisterFilter>) => void;
  initialFilter?: Partial<RegisterFilter>;
  manage?: ManageData;
  onUseView?: (filter: Partial<RegisterFilter>) => void;
  onRefresh?: () => Promise<void>;
}) {
  const [query, setQuery] = useState(initialFilter.query ?? "");
  const [deferredQuery, setDeferredQuery] = useState(initialFilter.query ?? "");
  const [account, setAccount] = useState(
    initialFilter.account ?? initialAccount,
  );
  const [status, setStatus] = useState<string>(
    initialFilter.status ?? initialStatus,
  );
  const [source, setSource] = useState(initialFilter.source ?? "");
  const [missing, setMissing] = useState(
    initialFilter.missing_receipt ?? false,
  );
  const [payee, setPayee] = useState(initialFilter.payee ?? ""),
    [project, setProject] = useState(initialFilter.project ?? ""),
    [businessLine, setBusinessLine] = useState(
      initialFilter.business_line ?? "",
    );
  const [offset, setOffset] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(
    Object.keys(initialFilter).length > 0,
  );
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<string[]>([]),
    [approval, setApproval] = useState<{
      id: string;
      entries: JournalEntry[];
    } | null>(null);
  const command = useAccountingCommand(onRefresh);
  const filter = {
    from: initialFilter.from ?? from,
    to: initialFilter.to ?? to,
    status,
    query: deferredQuery || undefined,
    account: account || undefined,
    source: source || undefined,
    missing_receipt: missing,
    payee: payee || undefined,
    project: project || undefined,
    business_line: businessLine || undefined,
    offset,
    limit: 50,
  };
  const signature = JSON.stringify(filter);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDeferredQuery(query);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSelection([]);
    if (demoEntries) {
      const f = JSON.parse(signature);
      const selected = demoEntries.filter(
        (e) =>
          (f.status === "all" || e.status === f.status) &&
          (!f.account || e.lines.some((l) => l.account_id === f.account)) &&
          (!f.source || e.primary_origin === f.source) &&
          (!f.query || e.memo.toLowerCase().includes(f.query.toLowerCase())),
      );
      setResult({
        entries: selected.slice(f.offset, f.offset + 50),
        total: selected.length,
        offset: f.offset,
        limit: 50,
        revision: "demo",
      });
      setLoading(false);
      return;
    }
    accountingGet<RegisterResult>(
      { view: "register", filter: signature },
      controller.signal,
    )
      .then(setResult)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [signature, revision, demoEntries]);
  return (
    <section
      className="glass-card overflow-hidden"
      aria-label="Transaction register"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            aria-label="Search all transactions"
            placeholder="Search all transactions..."
            icon={<Search size={16} />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="sm:w-80"
          />
          <div className="flex rounded-lg border border-border p-1">
            {[
              ["all", "All transactions"],
              ["draft", "Review"],
              ["posted", "Posted"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm",
                  status === key
                    ? "bg-secondary font-medium"
                    : "text-muted-foreground",
                )}
                onClick={() => {
                  setStatus(key);
                  setOffset(0);
                }}
                aria-pressed={status === key}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <Filter size={14} />
          Filters
          {(account ||
            source ||
            missing ||
            payee ||
            project ||
            businessLine) && (
            <span className="h-1.5 w-1.5 rounded-full bg-teal" />
          )}
        </Button>
      </div>
      {!!manage?.views.length && onUseView && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">Saved views</span>
          {manage.views.map((v) => (
            <Button
              key={v.id}
              size="sm"
              variant="ghost"
              onClick={() => onUseView(v.filters)}
            >
              {v.name}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => onUseView({})}>
            Reset
          </Button>
        </div>
      )}
      {filtersOpen && (
        <div className="flex flex-wrap gap-3 border-b border-border bg-secondary/20 p-4">
          <select
            aria-label="Filter account"
            className={selectClass}
            value={account}
            onChange={(e) => {
              setAccount(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter payee"
            className={selectClass}
            value={payee}
            onChange={(e) => {
              setPayee(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All payees</option>
            {manage?.parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter project"
            className={selectClass}
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All projects</option>
            {manage?.dimensions
              .filter((d) => d.kind === "project")
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
          <select
            aria-label="Filter business line"
            className={selectClass}
            value={businessLine}
            onChange={(e) => {
              setBusinessLine(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All business lines</option>
            {manage?.dimensions
              .filter((d) => d.kind === "business_line")
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
          <select
            aria-label="Filter source"
            className={selectClass}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All sources</option>
            {["wave", "simplefin", "csv", "manual", "internal"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={missing}
              onChange={(e) => {
                setMissing(e.target.checked);
                setOffset(0);
              }}
            />
            Missing document
          </label>
          {onSaveView && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSaveView(filter as Partial<RegisterFilter>)}
            >
              <BookmarkPlus size={14} />
              Save view
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="p-5 text-sm text-error" role="alert">
          {error}
        </p>
      )}
      {!demoEntries && !!result?.entries.some((e) => e.status === "draft") && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-secondary/10 px-4 py-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              aria-label="Select visible drafts"
              checked={result.entries
                .filter((e) => e.status === "draft")
                .every((e) => selection.includes(e.id))}
              onChange={(e) =>
                setSelection(
                  e.target.checked
                    ? result.entries
                        .filter((e) => e.status === "draft")
                        .map((e) => e.id)
                    : [],
                )
              }
            />
            {selection.length
              ? `${selection.length} visible drafts selected`
              : "Select visible drafts"}
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={!selection.length || loading}
            onClick={() =>
              setApproval({
                id: crypto.randomUUID(),
                entries: result.entries.filter((e) => selection.includes(e.id)),
              })
            }
          >
            Review selected posting
          </Button>
        </div>
      )}
      <div
        aria-busy={loading}
        className={cn(
          "transition-opacity",
          loading && result ? "opacity-50" : "",
        )}
      >
        {loading && !result ? (
          <div className="space-y-4 p-6">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-lg bg-secondary"
              />
            ))}
          </div>
        ) : result?.entries.length ? (
          <div>
            {result.entries.map((e) => {
              const debit = e.lines.reduce(
                (sum, l) =>
                  sum +
                  (BigInt(l.amount_cents) > BigInt(0)
                    ? BigInt(l.amount_cents)
                    : BigInt(0)),
                BigInt(0),
              );
              return (
                <div
                  key={e.id}
                  className="flex items-center border-b border-border/70 last:border-b-0"
                >
                  {!demoEntries && e.status === "draft" && (
                    <input
                      className="ml-5"
                      type="checkbox"
                      aria-label={`Select ${e.memo}`}
                      checked={selection.includes(e.id)}
                      disabled={loading}
                      onChange={(event) =>
                        setSelection(
                          event.target.checked
                            ? [...selection, e.id]
                            : selection.filter((id) => id !== e.id),
                        )
                      }
                    />
                  )}
                  <button
                    onClick={() => onSelect(e)}
                    className="flex min-w-0 w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-secondary/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span
                      className={cn(
                        "hidden h-10 w-10 items-center justify-center rounded-xl sm:flex",
                        e.status === "draft"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-teal/10 text-teal",
                      )}
                    >
                      <FileText size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {e.memo}
                      </span>
                      <span className="mt-1 flex gap-2 text-xs text-muted-foreground">
                        <span>{e.entry_date}</span>
                        <span>·</span>
                        <span className="capitalize">{e.primary_origin}</span>
                        {e.reversed_by_entry_id && <span>· Reversed</span>}
                      </span>
                    </span>
                    <span className="hidden rounded-md border border-border px-2 py-1 text-xs capitalize text-muted-foreground md:block">
                      {e.status === "draft" ? "Needs review" : e.status}
                    </span>
                    <span className="text-right text-sm font-mono tabular-nums">
                      <MaskedValue value={formatCents(debit)} />
                      <span className="mt-1 block font-sans text-[10px] text-muted-foreground">
                        Journal total
                      </span>
                    </span>
                    <ArrowUpRight size={15} className="text-muted-foreground" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-16 text-center">
            <ArrowDownLeft
              size={24}
              className="mx-auto mb-3 text-muted-foreground"
            />
            <h3 className="font-medium">No transactions in this view</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Adjust the filters, import your history, or add a journal entry.
            </p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          {result?.total
            ? `${offset + 1}-${Math.min(offset + 50, result.total)} of ${result.total}`
            : "0 transactions"}
          {loading ? " · Updating..." : ""}
        </p>
        <div className="flex gap-1">
          <Button
            aria-label="Previous transaction page"
            variant="ghost"
            size="icon"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            aria-label="Next transaction page"
            variant="ghost"
            size="icon"
            disabled={!result || offset + 50 >= result.total || loading}
            onClick={() => setOffset(offset + 50)}
          >
            <ChevronRight size={16} />
          </Button>
        </div>
      </div>
      <Dialog
        open={!!approval}
        onOpenChange={(open) => {
          if (!open && !command.busy) setApproval(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Post selected drafts</DialogTitle>
            <DialogDescription>
              Review the visible selection. Every entry must still be balanced,
              open, and unchanged when this batch posts.
            </DialogDescription>
          </DialogHeader>
          {approval && (
            <div className="space-y-4">
              <p className="text-sm">
                {approval.entries.length} entries ·{" "}
                {approval.entries.map((e) => e.entry_date).sort()[0]} to{" "}
                {approval.entries
                  .map((e) => e.entry_date)
                  .sort()
                  .at(-1)}
              </p>
              <div className="max-h-64 overflow-y-auto divide-y divide-border">
                {approval.entries.map((e) => {
                  const balanced =
                    e.lines.length >= 2 &&
                    e.lines.reduce(
                      (s, l) => s + BigInt(l.amount_cents),
                      BigInt(0),
                    ) === BigInt(0);
                  return (
                    <div
                      key={e.id}
                      className="flex justify-between gap-3 py-3 text-sm"
                    >
                      <span>{e.memo}</span>
                      <span
                        className={
                          balanced
                            ? "text-muted-foreground"
                            : "text-destructive"
                        }
                      >
                        {balanced ? (
                          <MaskedValue
                            value={formatCents(
                              e.lines.reduce(
                                (s, l) =>
                                  s +
                                  (BigInt(l.amount_cents) > BigInt(0)
                                    ? BigInt(l.amount_cents)
                                    : BigInt(0)),
                                BigInt(0),
                              ),
                            )}
                          />
                        ) : (
                          "Unbalanced"
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              {command.error && (
                <p role="alert" className="text-sm text-destructive">
                  {command.error}
                </p>
              )}
              <Button
                disabled={
                  command.busy ||
                  approval.entries.some(
                    (e) =>
                      e.lines.length < 2 ||
                      e.lines.reduce(
                        (s, l) => s + BigInt(l.amount_cents),
                        BigInt(0),
                      ) !== BigInt(0),
                  )
                }
                onClick={async () => {
                  if (
                    await command.execute({
                      type: "entry.bulkpost",
                      id: approval.id,
                      entries: approval.entries.map((e) => ({
                        id: e.id,
                        expected_version: e.version,
                      })),
                    })
                  ) {
                    setApproval(null);
                    setSelection([]);
                  }
                }}
              >
                Post {approval.entries.length} reviewed entries
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
