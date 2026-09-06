"use client";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  LockKeyhole,
  ArrowUpRight,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type {
  CloseChecklist,
  CloseHistory,
  PeriodImpact,
} from "@/lib/accounting/close";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { AccountingClearing } from "./accounting-clearing";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

type Action =
  | "close"
  | "reopen"
  | "classify"
  | "file"
  | "restatement"
  | "finish";
export function AccountingClose({
  date,
  onRefresh,
  onEntry,
  onAccounts,
  onTransactions,
  onImports,
}: {
  date: string;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
  onAccounts: () => void;
  onTransactions: () => void;
  onImports: () => void;
}) {
  const [month, setMonth] = useState(date.slice(0, 7)),
    [data, setData] = useState<CloseChecklist | null>(null),
    [history, setHistory] = useState<CloseHistory | null>(null),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0),
    [section, setSection] = useState<"close" | "clearing">("close");
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
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
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
      });
    return () => abort.abort();
  }, [month, tick]);
  const closed = history?.periods.some(
      (p) => p.month_start === `${month}-01` && p.is_locked,
    ),
    fiscal = history?.years.find((y) => y.year === year),
    openCase = history?.restatements.find((c) => c.status === "open");
  const baseline = history?.closes.find(
    (c) =>
      c.month_start === `${month}-01` &&
      !c.reopen &&
      c.proof?.kind === "historical_baseline",
  );
  async function open(kind: Action, id = crypto.randomUUID()) {
    try {
      const impact =
        kind === "reopen" || kind === "restatement"
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
  if (section === "clearing")
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSection("close")}>
          Back to month close
        </Button>
        <AccountingClearing
          date={data?.through ?? date}
          onRefresh={refresh}
          onEntry={onEntry}
        />
      </div>
    );
  const checks = data
    ? [
        {
          label: "Calendar month ended",
          detail: data.month_ended
            ? "The month is complete"
            : "This calendar month has not ended yet",
          count: data.month_ended ? 0 : 1,
          action: () => document.getElementById("close-month")?.focus(),
        },
        {
          label: "Drafts reviewed",
          detail: `${data.drafts} drafts remain through this month`,
          count: data.drafts,
          action: onTransactions,
        },
        {
          label: "Bank observations reviewed",
          detail: `${data.unreviewed_feed_movements ?? 0} source movements through this month need a review batch in Bank feeds`,
          count: data.unreviewed_feed_movements ?? 0,
          action: onImports,
        },
        {
          label: "Import coverage verified",
          detail: `${data.unverified_imports} current or earlier batches need completion or report verification`,
          count: data.unverified_imports,
          action: onImports,
        },
        {
          label: "Bank and card statements reconciled",
          detail: `${data.unreconciled_accounts} accounts need statement coverage at month end`,
          count: data.unreconciled_accounts,
          action: onAccounts,
        },
        {
          label: "Transactions categorized",
          detail: `${data.uncategorized_lines} uncategorized lines remain`,
          count: data.uncategorized_lines,
          action: onTransactions,
        },
        {
          label: "Opening balances resolved",
          detail: `${data.opening_suspense_accounts} opening suspense balances remain`,
          count: data.opening_suspense_accounts,
          action: onAccounts,
        },
        {
          label: "Clearing balances explained",
          detail: `${data.unexplained_clearing_lines} outstanding items need settlement or supporting evidence`,
          count: data.unexplained_clearing_lines,
          action: () => setSection("clearing"),
        },
      ]
    : [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Close the books</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the month, retain its reports, and protect completed work.
          </p>
        </div>
        <Input
          label="Close month"
          type="month"
          min="1900-01"
          max="2100-12"
          value={month}
          onChange={(e) => {
            if (e.target.value) setMonth(e.target.value);
          }}
        />
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 p-4 text-sm text-error"
        >
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="text-sm text-muted-foreground">Checking the books…</p>
      )}
      {data && history && (
        <>
          {closed && baseline && (
            <section className="glass-card border-teal-light/30 p-5">
              <h3 className="font-semibold">Historical baseline accepted</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                This month is protected by verified source-report comparisons.
                Detailed statement matching remains available for retained bank
                and card statements.
              </p>
              <div className="mt-3">
                <SnapshotLink
                  id={baseline.snapshot_id}
                  label="Historical parity proof"
                />
              </div>
            </section>
          )}
          <div className="grid items-start gap-5 xl:grid-cols-[1fr_320px]">
            <section className="glass-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-border p-5">
                <h3 className="font-semibold">{month} close checklist</h3>
                <span
                  className={`rounded-full px-3 py-1 text-xs ${closed ? "bg-teal-light/10 text-teal-light" : "bg-secondary text-muted-foreground"}`}
                >
                  {closed
                    ? baseline
                      ? "Historical baseline"
                      : "Closed"
                    : data.ready
                      ? "Ready for review"
                      : "In progress"}
                </span>
              </div>
              {checks.map((c) => (
                <button
                  key={c.label}
                  onClick={c.action}
                  className="flex w-full items-start gap-3 border-b border-border p-5 text-left last:border-0 hover:bg-secondary/30"
                >
                  {c.count === 0 ? (
                    <CheckCircle2
                      size={19}
                      className="mt-0.5 shrink-0 text-teal-light"
                    />
                  ) : (
                    <Circle
                      size={19}
                      className="mt-0.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <div className="flex-1">
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.detail}
                    </p>
                  </div>
                  <ArrowUpRight
                    size={14}
                    className="mt-1 text-muted-foreground"
                  />
                </button>
              ))}
            </section>
            <div className="space-y-4">
              <section className="glass-card p-5">
                <LockKeyhole size={22} className="text-teal-light" />
                <h3 className="mt-4 font-semibold">
                  {closed
                    ? "This month is protected"
                    : "Retain a complete month"}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Closing saves the report values and supporting checks. It does
                  not post drafts or create balancing entries.
                </p>
                <Button
                  className="mt-5 w-full"
                  disabled={
                    closed ||
                    !data.ready ||
                    !fiscal ||
                    fiscal.classification === "unverified"
                  }
                  onClick={() => void open("close")}
                >
                  Review and close
                </Button>
                {closed && (
                  <Button
                    className="mt-2 w-full"
                    variant="outline"
                    onClick={() => void open("reopen")}
                  >
                    <RotateCcw size={14} />
                    Review reopen impact
                  </Button>
                )}
              </section>
              <section className="glass-card p-5">
                <h3 className="font-semibold">{year} entity and filing</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {fiscal?.classification === "s_corp"
                    ? "S corporation"
                    : fiscal?.classification === "other"
                      ? "Other entity classification"
                      : "Entity classification needs confirmation"}
                </p>
                {fiscal?.filed_on ? (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Filed {fiscal.filed_on}
                    </p>
                    <SnapshotLink
                      id={fiscal.filed_snapshot_id!}
                      label="Original filed reports"
                    />
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => void open("classify")}
                    >
                      Confirm classification
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-3"
                      onClick={() => void open("file")}
                    >
                      Record completed filing
                    </Button>
                  </>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  This records your filing status and evidence. It does not
                  submit a return.
                </p>
              </section>
            </div>
          </div>
          {data.accounts.length > 0 && (
            <section className="glass-card p-5">
              <h3 className="font-semibold">
                Statement coverage at {data.through}
              </h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {data.accounts.map((a) => (
                  <div
                    key={a.id}
                    className="flex justify-between gap-3 rounded-lg bg-secondary/30 p-3 text-sm"
                  >
                    <span>{a.name}</span>
                    <span
                      className={
                        a.reconciliation_id
                          ? "text-teal-light"
                          : "text-muted-foreground"
                      }
                    >
                      {a.reconciliation_id ? "Covered" : "Needs review"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Card statement cycles can cross month end. Their dated matches
                carry outstanding amounts across the calendar cutoff.
              </p>
            </section>
          )}
          {openCase && (
            <section className="glass-card border-warning/30 p-5">
              <h3 className="font-semibold">
                Open restatement: {openCase.from_date} to {openCase.to_date}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {openCase.reason}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Reclose each affected month after making the documented
                corrections. {openCase.return_review_explanation}
              </p>
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => void open("finish", openCase.id)}
              >
                Review and finish restatement
              </Button>
            </section>
          )}
          <section className="glass-card overflow-hidden">
            <div className="border-b border-border p-5">
              <h3 className="font-semibold">Saved close history</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Original reports stay available after reopen or restatement.
              </p>
            </div>
            {history.closes
              .filter((c) => c.month_start.startsWith(String(year)))
              .map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 text-sm last:border-0"
                >
                  <div>
                    <p className="font-medium">{c.month_start.slice(0, 7)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.reopen
                        ? `Reopened: ${c.reopen.reason}`
                        : c.proof?.kind === "historical_baseline"
                          ? "Accepted historical baseline"
                          : "Completed close"}
                    </p>
                  </div>
                  <SnapshotLink id={c.snapshot_id} label="Saved reports" />
                </div>
              ))}
            {!history.closes.some((c) =>
              c.month_start.startsWith(String(year)),
            ) && (
              <p className="p-5 text-sm text-muted-foreground">
                No close snapshots for {year} yet.
              </p>
            )}
          </section>
          {history.restatements
            .filter((c) => c.status === "completed")
            .map((c) => (
              <section key={c.id} className="glass-card p-5">
                <p className="font-medium">
                  Completed restatement · {c.from_date} to {c.to_date}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">{c.reason}</p>
                <div className="mt-3 flex gap-4">
                  <SnapshotLink
                    id={c.original_snapshot_id}
                    label="Original filed reports"
                  />
                  {c.replacement_snapshot_id && (
                    <SnapshotLink
                      id={c.replacement_snapshot_id}
                      label="Revised reports"
                    />
                  )}
                </div>
              </section>
            ))}
        </>
      )}
      {action && data && history && (
        <CloseAction
          action={action}
          month={`${month}-01`}
          checklist={data}
          history={history}
          onRestatement={() => void open("restatement")}
          onClose={() => setAction(null)}
          onSaved={async () => {
            setAction(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
function SnapshotLink({ id, label }: { id: string; label: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 text-sm text-teal-light hover:underline"
      href={`/api/accounting?view=snapshot&id=${id}`}
      target="_blank"
      rel="noreferrer"
    >
      {label}
      <ArrowUpRight size={13} />
    </a>
  );
}
function CloseAction({
  action,
  month,
  checklist,
  history,
  onRestatement,
  onClose,
  onSaved,
}: {
  action: { kind: Action; id: string; impact: PeriodImpact | null };
  month: string;
  checklist: CloseChecklist;
  history: CloseHistory;
  onRestatement: () => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [reason, setReason] = useState(""),
    [doc, setDoc] = useState(""),
    [classification, setClassification] = useState<
      "s_corp" | "other" | "unverified"
    >("unverified"),
    [filedOn, setFiledOn] = useState(""),
    [returnReview, setReturnReview] = useState<
      "required" | "not_required_with_explanation"
    >("required"),
    [explanation, setExplanation] = useState("");
  const cmd = useAccountingCommand(onSaved);
  const kind = action.kind,
    blocked = kind === "reopen" && !!action.impact?.filed_years.length;
  const titles = {
    close: "Close this month?",
    reopen: "Review the effect of reopening",
    classify: "Confirm the entity classification",
    file: "Record a completed filing",
    restatement: "Open a filed-year restatement",
    finish: "Finish this restatement?",
  };
  const descriptions = {
    close:
      "Keep an immutable report snapshot and lock financial changes for this month.",
    reopen:
      "Earlier changes can affect the opening balances and reports of every later close.",
    classify:
      "Confirm the classification that actually applied during this year. This is saved separately for each year.",
    file: "All twelve months must be closed. Attach the filed return or filing support and record its actual filing date.",
    restatement:
      "This opens the affected closed months for a documented correction. Original filed reports and evidence remain unchanged.",
    finish:
      "Every originally closed month must be closed again. A separate report snapshot preserves the revised result.",
  };
  async function submit() {
    const base = {
      id: action.id,
      expected_revision: action.impact?.revision ?? history.revision,
    };
    let c: WorkflowCommand;
    if (kind === "close") c = { ...base, type: "period.close", month };
    else if (kind === "reopen")
      c = { ...base, type: "period.reopen", month, reason };
    else if (kind === "classify")
      c = {
        ...base,
        type: "year.configure",
        year: Number(month.slice(0, 4)),
        classification,
      };
    else if (kind === "file")
      c = {
        ...base,
        type: "year.file",
        year: Number(month.slice(0, 4)),
        filed_on: filedOn,
        document_id: doc,
      };
    else if (kind === "restatement")
      c = {
        ...base,
        type: "year.restatement.begin",
        month,
        reason,
        document_id: doc,
        external_return_review: returnReview,
        return_review_explanation: explanation,
      };
    else c = { ...base, type: "year.restatement.complete" };
    await cmd.execute(c);
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{titles[kind]}</DialogTitle>
          <DialogDescription>{descriptions[kind]}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {(kind === "reopen" || kind === "restatement") && (
            <>
              <div className="rounded-lg bg-secondary/40 p-4 text-sm">
                <p className="font-medium">Affected close months</p>
                <p className="mt-2 text-muted-foreground">
                  {action.impact?.periods
                    .map((p) => p.month_start.slice(0, 7))
                    .join(", ") || "No locked months"}
                </p>
                {action.impact?.filed_years.length ? (
                  <p className="mt-2 text-warning">
                    Filed years affected:{" "}
                    {action.impact.filed_years.map((y) => y.year).join(", ")}. A
                    restatement is required.
                  </p>
                ) : null}
              </div>
              <Input
                label="Reason for reopening"
                required
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </>
          )}
          {kind === "classify" && (
            <label className="block text-sm">
              Classification for {month.slice(0, 4)}
              <select
                required
                className="mt-1 h-10 w-full rounded-lg border border-border bg-input px-3"
                value={classification}
                onChange={(e) =>
                  setClassification(e.target.value as typeof classification)
                }
              >
                <option value="unverified">Unverified</option>
                <option value="s_corp">S corporation</option>
                <option value="other">Other classification</option>
              </select>
            </label>
          )}
          {kind === "file" && (
            <Input
              label="Actual filing date"
              type="date"
              required
              value={filedOn}
              onChange={(e) => setFiledOn(e.target.value)}
            />
          )}
          {(kind === "file" || kind === "restatement") && (
            <AccountingDocumentPicker value={doc} onChange={setDoc} />
          )}
          {kind === "restatement" && (
            <>
              <label className="block text-sm">
                External return review
                <select
                  className="mt-1 h-10 w-full rounded-lg border border-border bg-input px-3"
                  value={returnReview}
                  onChange={(e) =>
                    setReturnReview(e.target.value as typeof returnReview)
                  }
                >
                  <option value="required">
                    Review amended-return requirements
                  </option>
                  <option value="not_required_with_explanation">
                    Not required, with explanation
                  </option>
                </select>
              </label>
              <Input
                label="Return review explanation"
                required
                maxLength={3000}
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
              />
            </>
          )}
          {kind === "close" && (
            <p className="rounded-lg bg-secondary/40 p-4 text-sm">
              {checklist.month_start.slice(0, 7)} · All close checks passed ·
              Revision {checklist.revision}
            </p>
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
              Back
            </Button>
            {blocked ? (
              <Button type="button" onClick={onRestatement}>
                Review restatement
              </Button>
            ) : (
              <Button type="submit" disabled={cmd.busy} loading={cmd.busy}>
                {kind === "close"
                  ? "Close month"
                  : kind === "reopen"
                    ? "Reopen affected months"
                    : kind === "restatement"
                      ? "Open restatement"
                      : "Save"}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
