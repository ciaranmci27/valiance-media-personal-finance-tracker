"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  CalendarDays,
  CheckCircle2,
  CircleDashed,
  PartyPopper,
  Send,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { DEPOSIT_TYPE_LABELS } from "@/types/payroll";
import type {
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";

interface Props {
  /** All non-deleted runs for the current tax year. */
  runs: PayrollRun[];
  /** All non-deleted deposits for the current tax year (paid + scheduled). */
  deposits: PayrollTaxDeposit[];
}

/**
 * Hero panel on /payroll that answers "what state is my latest pay cycle
 * in?" and "what do I need to do next?" in one glance.
 *
 * A cycle is the group of runs sharing a single pay_date. We find the latest
 * non-voided cycle and walk three downstream obligations:
 *   1. Approve any remaining drafts
 *   2. Pay the employees externally + mark the runs paid
 *   3. Pay the federal and state tax deposits generated at approval time
 *
 * Form filing (941, 940, W-2) sits outside the cycle because the cadence is
 * quarterly or annual, not per-pay-period. The Forms page owns those reminders.
 *
 * When every step is done, the panel renders a celebratory "Up to date" state
 * so the user gets a sense of closure, not a stale checklist.
 */
export function CurrentCyclePanel({ runs, deposits }: Props) {
  const cycle = React.useMemo(() => deriveLatestCycle(runs), [runs]);
  if (!cycle) return null;

  const cycleRunIds = React.useMemo(
    () => new Set(cycle.runs.map((r) => r.id)),
    [cycle.runs],
  );

  const cycleDeposits = React.useMemo(
    () =>
      deposits.filter((d) =>
        (d.included_run_ids ?? []).some((id) => cycleRunIds.has(id)),
      ),
    [deposits, cycleRunIds],
  );

  const totals = React.useMemo(() => {
    let net = 0;
    let employeeTaxes = 0;
    for (const r of cycle.runs) {
      net += Number(r.net_pay || 0);
      employeeTaxes +=
        Number(r.federal_income_tax || 0) +
        Number(r.state_income_tax || 0) +
        Number(r.social_security_employee || 0) +
        Number(r.medicare_employee || 0) +
        Number(r.additional_medicare || 0) +
        Number(r.state_disability_employee || 0);
    }
    return { net, employeeTaxes };
  }, [cycle.runs]);

  const paidCount = cycle.runs.filter((r) => r.status === "paid").length;
  const finalizedCount = cycle.runs.filter(
    (r) => r.status === "finalized" || r.status === "paid",
  ).length;
  const total = cycle.runs.length;

  const step1Done = finalizedCount === total;
  const step2Done = paidCount === total && total > 0;
  const step2Partial = paidCount > 0 && !step2Done;

  const paidDeposits = cycleDeposits.filter((d) => d.status === "paid");
  const scheduledDeposits = cycleDeposits.filter((d) => d.status !== "paid");
  const step3Done =
    cycleDeposits.length > 0 && scheduledDeposits.length === 0;
  const step3Partial = paidDeposits.length > 0 && !step3Done;

  const allDone = step1Done && step2Done && step3Done;

  const nextDeposit = scheduledDeposits
    .slice()
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];

  // The first incomplete step is the "active" one; subsequent pending steps
  // are upcoming. Nudge the user toward one thing at a time.
  const activeStep: 1 | 2 | 3 | null = !step1Done
    ? 1
    : !step2Done
      ? 2
      : !step3Done
        ? 3
        : null;

  // Single-employee cycles go straight to the run. Multi-employee cycles
  // route to the cycle hub so the admin can see every run and mark them
  // all paid with one payment-method entry.
  const primaryRunHref =
    total === 1
      ? `/payroll/runs/${cycle.runs[0].id}`
      : `/payroll/cycles/${cycle.payDate}`;

  return (
    <div className="glass-card rounded-xl p-5 space-y-4 stagger-1">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl flex-shrink-0",
              allDone
                ? "bg-success/15 text-success"
                : "bg-primary/10 text-primary",
            )}
            aria-hidden="true"
          >
            {allDone ? (
              <PartyPopper className="h-5 w-5" />
            ) : (
              <CalendarDays className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-foreground">
                {allDone ? "Latest cycle is fully settled" : "Current pay cycle"}
              </h2>
              <CycleStatusPill
                allDone={allDone}
                activeStep={activeStep}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Pay date {formatDate(cycle.payDate)}
              {" - "}
              {total} {total === 1 ? "employee" : "employees"}
              {" - "}
              <MaskedValue value={formatCurrency(totals.net)} /> net
            </p>
          </div>
        </div>
      </div>

      {allDone ? (
        <div className="rounded-lg border border-success/30 bg-success/5 p-4 flex items-start gap-3">
          <Sparkles
            className="h-4 w-4 text-success mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <div className="text-sm text-foreground space-y-1">
            <p className="font-medium">
              Every follow-up for this cycle is complete.
            </p>
            <p className="text-xs text-muted-foreground">
              Wages sent and tax deposits paid. Quarterly and annual forms
              live on the Forms page.
            </p>
          </div>
        </div>
      ) : (
        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            What's left to do
          </div>
          <ol className="space-y-2.5">
            <ChecklistRow
              num={1}
              state={
                step1Done ? "done" : activeStep === 1 ? "active" : "pending"
              }
              icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              title={
                step1Done
                  ? `Runs approved (${finalizedCount} of ${total})`
                  : `Approve the remaining ${total - finalizedCount} draft${total - finalizedCount === 1 ? "" : "s"}`
              }
              detail={
                step1Done
                  ? "Numbers locked, YTD updated, tax deposits scheduled."
                  : "Open each draft and approve to lock the numbers and schedule tax deposits."
              }
              action={
                !step1Done ? (
                  <Link href={primaryRunHref}>
                    <Button size="sm">
                      {total === 1 ? "Open run" : "Open cycle"}
                      <ArrowRight className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
                    </Button>
                  </Link>
                ) : null
              }
            />
            <ChecklistRow
              num={2}
              state={
                step2Done
                  ? "done"
                  : step2Partial
                    ? "partial"
                    : activeStep === 2
                      ? "active"
                      : "pending"
              }
              icon={<Send className="h-4 w-4" aria-hidden="true" />}
              title={
                step2Done
                  ? `Wages paid and stubs queued (${paidCount} of ${total})`
                  : step2Partial
                    ? `Pay remaining employees (${paidCount} of ${total} done)`
                    : `Pay employees + mark each run paid`
              }
              detail={
                step2Done ? (
                  "Payment recorded for every run in the cycle."
                ) : total === 1 ? (
                  <>
                    Send net pay through your bank (ACH, check, or wire), then
                    come back and mark the run paid.
                  </>
                ) : (
                  <>
                    Send net pay through your bank, then mark the whole cycle
                    paid in one step from the cycle page.
                  </>
                )
              }
              action={
                !step2Done && activeStep === 2 ? (
                  <Link href={primaryRunHref}>
                    <Button size="sm">
                      {total === 1 ? "Open run" : "Open cycle"}
                      <ArrowRight className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
                    </Button>
                  </Link>
                ) : null
              }
            />
            <ChecklistRow
              num={3}
              state={
                step3Done
                  ? "done"
                  : step3Partial
                    ? "partial"
                    : activeStep === 3
                      ? "active"
                      : "pending"
              }
              icon={<Banknote className="h-4 w-4" aria-hidden="true" />}
              title={
                cycleDeposits.length === 0
                  ? "Pay federal + state tax deposits"
                  : step3Done
                    ? `Tax deposits paid (${paidDeposits.length} of ${cycleDeposits.length})`
                    : step3Partial
                      ? `Pay remaining deposits (${paidDeposits.length} of ${cycleDeposits.length} done)`
                      : `Pay ${cycleDeposits.length} tax deposit${cycleDeposits.length === 1 ? "" : "s"}`
              }
              detail={
                cycleDeposits.length === 0 ? (
                  <>
                    Deposits will appear here once this cycle's runs are approved.
                  </>
                ) : step3Done ? (
                  "All IRS and state deposits for this cycle are paid."
                ) : nextDeposit ? (
                  <>
                    Next up{" "}
                    <span className="text-foreground font-medium">
                      {DEPOSIT_TYPE_LABELS[nextDeposit.deposit_type]}
                    </span>
                    {" - "}due {formatDate(nextDeposit.due_date)}.
                  </>
                ) : null
              }
              action={null}
            />
          </ol>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type RowState = "done" | "active" | "partial" | "pending";

function ChecklistRow({
  num,
  state,
  icon,
  title,
  detail,
  action,
}: {
  num: number;
  state: RowState;
  icon: React.ReactNode;
  title: React.ReactNode;
  detail: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg px-3 py-2.5 border transition-colors",
        state === "active" && "bg-primary/5 border-primary/30",
        state === "partial" && "bg-warning/5 border-warning/30",
        state === "done" && "bg-secondary/30 border-border",
        state === "pending" && "bg-transparent border-border",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full flex-shrink-0 text-xs font-semibold mt-0.5",
          state === "done" && "bg-success/15 text-success",
          state === "active" && "bg-primary text-primary-foreground",
          state === "partial" && "bg-warning/15 text-warning",
          state === "pending" && "bg-secondary text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {state === "done" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : state === "partial" ? (
          <CircleDashed className="h-4 w-4" />
        ) : state === "active" ? (
          icon
        ) : (
          num
        )}
      </span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div
          className={cn(
            "text-sm font-medium",
            state === "done" && "text-muted-foreground line-through",
            state === "pending" && "text-muted-foreground",
            state === "active" && "text-foreground",
            state === "partial" && "text-foreground",
          )}
        >
          {title}
        </div>
        {detail && (
          <div className="text-xs text-muted-foreground">{detail}</div>
        )}
      </div>
      {action && <div className="flex-shrink-0 self-center">{action}</div>}
    </li>
  );
}

function CycleStatusPill({
  allDone,
  activeStep,
}: {
  allDone: boolean;
  activeStep: 1 | 2 | 3 | null;
}) {
  if (allDone) {
    return (
      <span className="inline-flex items-center rounded-md bg-success/10 text-success px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
        Settled
      </span>
    );
  }
  const label =
    activeStep === 1
      ? "In progress"
      : activeStep === 2
        ? "Ready to pay"
        : activeStep === 3
          ? "Deposits pending"
          : "In progress";
  return (
    <span className="inline-flex items-center rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
      {label}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface CycleInfo {
  payDate: string;
  runs: PayrollRun[];
}

/** Pick the most recent pay_date among non-voided runs and collect every run
 *  that shares it. The resulting group is one pay cycle. */
function deriveLatestCycle(runs: PayrollRun[]): CycleInfo | null {
  const active = runs.filter((r) => r.status !== "voided");
  if (active.length === 0) return null;
  let latest = active[0].pay_date;
  for (const r of active) {
    if (r.pay_date > latest) latest = r.pay_date;
  }
  return {
    payDate: latest,
    runs: active.filter((r) => r.pay_date === latest),
  };
}
