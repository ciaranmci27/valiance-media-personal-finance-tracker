"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Circle,
  LockKeyhole,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  CloseChecklist,
  CloseHistory,
  PeriodImpact,
} from "@/lib/accounting/close";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { absMoney, countLabel, monthLabel } from "./format";

type Action = "close" | "reopen";

type Check = {
  key: string;
  label: string;
  detail: string;
  count: number;
  action?: () => void;
};

/**
 * Month end. Three things matter: nothing is left to review, the book
 * balances match the bank, and the month is locked. Everything else the
 * server checks is listed under "More checks" so it never hides the three.
 */
export function AccountingClose({
  date,
  onRefresh,
  onAccounts,
  onTransactions,
}: {
  date: string;
  onRefresh: () => Promise<void>;
  onEntry?: (id: string) => void;
  onAccounts: () => void;
  onTransactions: () => void;
  onImports: () => void;
}) {
  const params = useSearchParams();
  const requestedMonth = params.get("month");
  const [month, setMonth] = useState(
    requestedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
      ? requestedMonth
      : date.slice(0, 7),
  );
  const [data, setData] = useState<CloseChecklist | null>(null);
  const [history, setHistory] = useState<CloseHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [action, setAction] = useState<{
    kind: Action;
    id: string;
    impact: PeriodImpact | null;
  } | null>(null);
  const year = Number(month.slice(0, 4));

  const refresh = async () => {
    setTick((t) => t + 1);
    await onRefresh();
  };

  // Reloads keep the previous checklist on screen; only the first load and a
  // month change show the placeholder.
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    Promise.all([
      accountingGet<CloseChecklist>(
        { view: "close", date: `${month}-01` },
        abort.signal,
      ),
      accountingGet<CloseHistory>({ view: "close-history" }, abort.signal),
    ])
      .then(([c, h]) => {
        setData(c);
        setHistory(h);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [month, tick]);

  const closed = history?.periods.some(
    (p) => p.month_start === `${month}-01` && p.is_locked,
  );
  // Periods worth listing for the year: locked months and months that were
  // reopened with a reason.
  const yearPeriods =
    history?.periods.filter(
      (p) => p.month_start.startsWith(`${year}-`) && (p.is_locked || p.reason),
    ) ?? [];
  const lockedMonths = yearPeriods.filter((p) => p.is_locked).length;
  // The package cutoff stays inside the selected year and never runs past
  // the books' current date.
  const packageThrough = `${year}-12-31` < date ? `${year}-12-31` : date;

  async function open(kind: Action, id = crypto.randomUUID()) {
    try {
      const impact =
        kind === "reopen"
          ? await accountingGet<PeriodImpact>({
              view: "period-impact",
              date: `${month}-01`,
            })
          : null;
      setAction({ kind, id, impact });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load affected periods.",
      );
    }
  }

  // The three checks that decide a month.
  const reviewCount = data ? data.drafts : 0;
  const balanceCount = data
    ? data.accounts.filter(
        (a) => a.difference_cents !== null && a.difference_cents !== "0",
      ).length
    : 0;
  const balancesKnown = data
    ? data.accounts.some((a) => a.difference_cents !== null)
    : false;

  const moreChecks: Check[] = data
    ? [
        {
          key: "history",
          label: "Historical checks agree",
          detail:
            data.history_mismatches === 0
              ? "Every recorded source comparison still matches the books."
              : `${countLabel(data.history_mismatches, "source comparison")} no longer match the books.`,
          count: data.history_mismatches,
          action: () => {
            window.location.href = "/accounting?view=manage&section=history";
          },
        },
      ]
    : [];
  const moreOpen = moreChecks.filter((c) => c.count > 0);

  const status = closed
    ? { label: "Locked", variant: "success" as const }
    : !data
      ? { label: "Checking", variant: "default" as const }
      : !data.month_ended
        ? { label: "Month in progress", variant: "default" as const }
        : data.ready
          ? { label: "Ready to lock", variant: "info" as const }
          : { label: "Needs attention", variant: "warning" as const };

  return (
    <div className="space-y-5" aria-busy={loading}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold">Month end</h2>
            <Badge variant={status.variant} dot>
              {status.label}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Review what is left, confirm the balances, then lock the month.
            Locking posts nothing and creates no balancing entries.
          </p>
        </div>
        <TextInput
          label="Month"
          type="month"
          min="1900-01"
          max="2100-12"
          value={month}
          className="w-44"
          onChange={(nextValue) => {
            if (nextValue) {
              setMonth(nextValue);
              setData(null);
              const url = new URL(window.location.href);
              url.searchParams.set("month", nextValue);
              window.history.replaceState(null, "", url);
            }
          }}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error"
        >
          {error}
        </p>
      )}
      {!data && !error && (
        <div
          role="status"
          aria-label="Checking the books..."
          className="grid gap-4 lg:grid-cols-3"
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      )}

      {data && history && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <StepCard
              step={1}
              title="Everything reviewed"
              done={reviewCount === 0}
              summary={
                reviewCount === 0
                  ? "No drafts through this month."
                  : reviewCount === 1
                    ? "1 draft still needs attention."
                    : `${reviewCount} drafts still need attention.`
              }
              lines={[
                [
                  data.drafts,
                  countLabel(data.drafts, "draft", "drafts") + " to review",
                ],
              ]}
              actionLabel="Open transactions"
              onAction={onTransactions}
            />
            <StepCard
              step={2}
              title="Balances match"
              done={balanceCount === 0}
              summary={
                !balancesKnown
                  ? "No bank balances reported yet. This check starts once a bank feed is mapped."
                  : balanceCount === 0
                    ? "Every mapped bank and card account matches what the bank last reported."
                    : `${countLabel(balanceCount, "account")} off from what the bank last reported.`
              }
              lines={data.accounts.map((a) => [
                a.difference_cents === null || a.difference_cents === "0"
                  ? 0
                  : 1,
                a.difference_cents === null
                  ? `${a.name}: no bank balance yet`
                  : `${a.name}: off by ${absMoney(a.difference_cents)}`,
              ])}
              actionLabel="Compare balances"
              onAction={onAccounts}
            />
            <div
              className={cn(
                "glass-card flex flex-col rounded-xl p-5",
                closed && "border-teal-light/30",
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full",
                    closed
                      ? "bg-primary/15 text-teal-light"
                      : "bg-[rgba(var(--ink),0.06)] text-muted-foreground",
                  )}
                >
                  <LockKeyhole size={16} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Step 3
                  </p>
                  <h3 className="font-semibold">
                    {closed ? "Locked" : "Lock the month"}
                  </h3>
                </div>
              </div>
              <p className="mt-3 flex-1 text-sm text-muted-foreground">
                {closed
                  ? `${monthLabel(month)} is protected. Its reports are saved with the period.`
                  : data.month_ended
                    ? "Saves the reports for this month and stops changes to it."
                    : "The month has not ended yet. Come back after the last day."}
              </p>
              <Button
                className="mt-4 w-full"
                disabled={closed || !data.ready || !data.month_ended}
                onClick={() => void open("close")}
              >
                <LockKeyhole size={15} aria-hidden="true" />
                Lock {monthLabel(month)}
              </Button>
              {closed && (
                <Button
                  className="mt-2 w-full"
                  variant="outline"
                  onClick={() => void open("reopen")}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  Reopen
                </Button>
              )}
            </div>
          </div>

          <section className="glass-card overflow-hidden rounded-xl">
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
              className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-[rgba(var(--ink),0.03)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">More checks</span>
                {moreOpen.length > 0 ? (
                  <Badge variant="warning" size="sm">
                    {moreOpen.length} open
                  </Badge>
                ) : (
                  <Badge variant="success" size="sm">
                    All clear
                  </Badge>
                )}
              </div>
              <ChevronDown
                size={16}
                aria-hidden="true"
                className={cn(
                  "text-muted-foreground transition-transform",
                  showMore && "rotate-180",
                )}
              />
            </button>
            {showMore && (
              <div className="border-t border-border">
                {moreChecks.map((c) => {
                  const row =
                    "flex w-full items-start gap-3 border-b border-border px-5 py-4 text-left last:border-0";
                  const body = (
                    <>
                      {c.count === 0 ? (
                        <CheckCircle2
                          size={18}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-teal-light"
                        />
                      ) : (
                        <Circle
                          size={18}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-warning"
                        />
                      )}
                      <div className="flex-1">
                        <p className="text-sm font-medium">{c.label}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {c.detail}
                        </p>
                      </div>
                      {c.action && (
                        <ArrowUpRight
                          size={14}
                          aria-hidden="true"
                          className="mt-1 text-muted-foreground"
                        />
                      )}
                    </>
                  );
                  // Checks with nowhere to go are plain rows, not dead buttons.
                  return c.action ? (
                    <button
                      key={c.key}
                      type="button"
                      onClick={c.action}
                      className={cn(
                        row,
                        "transition-colors hover:bg-[rgba(var(--ink),0.03)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <div key={c.key} className={row}>
                      {body}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="glass-card rounded-xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{year} year end</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {lockedMonths} of 12 months locked. The year-end package saves
                  an immutable copy of the statements, ledger detail and
                  schedules for the tax preparer.
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <a
                  href={`/accounting?view=reports&report=books-package&package_year=${year}&package_through=${packageThrough}`}
                >
                  Open year-end package
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              </Button>
            </div>
          </section>

          <section>
            <SectionHeader
              label="Saved closes"
              count={lockedMonths}
              description="Locking saves the month's reports with its period record."
            />
            <div className="glass-card overflow-hidden rounded-xl">
              {yearPeriods.map((p) => (
                <div
                  key={p.month_start}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 text-sm last:border-0"
                >
                  <div>
                    <p className="font-medium">{monthLabel(p.month_start)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.is_locked ? "Locked" : `Reopened: ${p.reason}`}
                    </p>
                  </div>
                  <Badge
                    variant={p.is_locked ? "success" : "warning"}
                    size="sm"
                  >
                    {p.is_locked ? "Locked" : "Open"}
                  </Badge>
                </div>
              ))}
              {yearPeriods.length === 0 && (
                <p className="p-5 text-sm text-muted-foreground">
                  No months locked in {year} yet.
                </p>
              )}
            </div>
          </section>
        </>
      )}

      {action && data && (
        <CloseAction
          action={action}
          month={`${month}-01`}
          checklist={data}
          onClose={() => setAction(null)}
          onSaved={async () => {
            setAction(null);
            await refresh();
          }}
          onFailed={async () => {
            // Reload the month and the affected periods so a retry carries
            // the current revision instead of the one that was rejected.
            setTick((t) => t + 1);
            await open(action.kind, action.id);
          }}
        />
      )}
    </div>
  );
}

function StepCard({
  step,
  title,
  done,
  summary,
  lines,
  actionLabel,
  onAction,
}: {
  step: number;
  title: string;
  done: boolean;
  summary: string;
  lines: [number, string][];
  actionLabel: string;
  onAction: () => void;
}) {
  const open = lines.filter(([count]) => count > 0);
  return (
    <div
      className={cn(
        "glass-card flex flex-col rounded-xl p-5",
        done && "border-teal-light/30",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full",
            done
              ? "bg-primary/15 text-teal-light"
              : "bg-warning/15 text-warning",
          )}
        >
          {done ? (
            <CheckCircle2 size={16} aria-hidden="true" />
          ) : (
            <Circle size={16} aria-hidden="true" />
          )}
        </span>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Step {step}
          </p>
          <h3 className="font-semibold">{title}</h3>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{summary}</p>
      {open.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {open.slice(0, 5).map(([, text]) => (
            <li key={text} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
              />
              <span className="truncate">{text}</span>
            </li>
          ))}
          {open.length > 5 && (
            <li className="text-xs text-muted-foreground">
              and {open.length - 5} more
            </li>
          )}
        </ul>
      )}
      <div className="flex-1" />
      <Button
        variant={done ? "ghost" : "secondary"}
        size="sm"
        className="mt-4 self-start"
        onClick={onAction}
      >
        {actionLabel}
        <ArrowUpRight size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}

function CloseAction({
  action,
  month,
  checklist,
  onClose,
  onSaved,
  onFailed,
}: {
  action: { kind: Action; id: string; impact: PeriodImpact | null };
  month: string;
  checklist: CloseChecklist;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onFailed: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const cmd = useAccountingCommand(onSaved);
  const kind = action.kind;
  const titles = {
    close: `Lock ${monthLabel(month)}`,
    reopen: `Reopen ${monthLabel(month)}`,
  };
  // Reopening carries into every later locked month; that list is the one
  // fact that can change the owner's mind, so it is the visible subtitle.
  const affected =
    action.impact?.periods.map((p) => monthLabel(p.month_start)) ?? [];
  const subtitle =
    kind === "reopen" && affected.length
      ? `Also affects ${affected.join(", ")}.`
      : "";
  const descriptions = {
    close: "Saves this month's reports and stops changes to it.",
    reopen: "Changes flow into every later locked month.",
  };

  async function submit() {
    // The checklist carries the financial revision the lock is checked
    // against; a reopen uses the revision the affected periods were read at.
    const base = {
      id: action.id,
      expected_revision: action.impact?.revision ?? checklist.revision,
    };
    const c: WorkflowCommand =
      kind === "close"
        ? { ...base, type: "period.lock", month }
        : { ...base, type: "period.reopen", month, reason };
    if (!(await cmd.execute(c))) await onFailed();
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{titles[kind]}</DialogTitle>
          <DialogDescription className={subtitle ? undefined : "sr-only"}>
            {subtitle || descriptions[kind]}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {kind === "reopen" && (
            <TextInput
              label="Reason"
              required
              maxLength={1000}
              value={reason}
              onChange={(nextValue) => setReason(nextValue)}
            />
          )}
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={cmd.busy} loading={cmd.busy}>
              {kind === "close" ? "Lock" : "Reopen"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
