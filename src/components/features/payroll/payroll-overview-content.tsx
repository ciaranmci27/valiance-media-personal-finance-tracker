"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  FileCheck2,
  Landmark,
  Play,
  Settings2,
  Target,
  Users2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaskedValue } from "@/components/ui/masked-value";
import { StatCard } from "@/components/ui/stat-card";
import { formatCurrency, cn } from "@/lib/utils";
import { aggregateYtd, getNextPayPeriod } from "@/lib/payroll/engine";
import {
  form940DueDate,
  form941DueDate,
  formA1AprDueDate,
  formA1QrtDueDate,
  w2DueDate,
} from "@/lib/payroll/deposits";
import type {
  OrganizationConfig,
  PayrollEmployee,
  PayrollForm,
  PayrollFormType,
  PayrollRun,
  PayrollTaxDeposit,
} from "@/types/payroll";
import {
  DEPOSIT_TYPE_LABELS,
  PAY_FREQUENCY_LABELS,
  PAYROLL_FORM_TYPE_LABELS,
} from "@/types/payroll";
import { CurrentCyclePanel } from "./current-cycle-panel";
import { Term } from "./term";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  organization: OrganizationConfig | null;
  employees: PayrollEmployee[];
  yearRuns: PayrollRun[];
  taxYear: number;
  /** Every deposit for the tax year (paid + scheduled). The Current cycle
   *  panel needs the full set to report completion; "due soon" is derived. */
  yearDeposits: PayrollTaxDeposit[];
  recentForms: PayrollForm[];
}

interface FormSlot {
  id: string;
  type: PayrollFormType;
  quarter: 1 | 2 | 3 | 4 | null;
  label: string;
  href: string;
  dueDate: string;
  form: PayrollForm | null;
}

interface UpcomingWindow {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  employees: PayrollEmployee[];
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PayrollOverviewContent({
  organization,
  employees,
  yearRuns,
  taxYear,
  yearDeposits,
  recentForms,
}: Props) {
  const today = todayLocalYmd();
  const depositsSoon = React.useMemo(() => {
    return yearDeposits
      .filter((d) => d.status !== "paid")
      .filter((d) => diffDays(d.due_date, today) <= 30)
      .slice(0, 5)
      .map((d) => ({
        ...d,
        isOverdue: d.due_date < today,
      }));
  }, [yearDeposits, today]);

  // Build a slot for every scheduled filing in the tax year (941 Q1-4,
  // A1-QRT Q1-4, 940, W-3, A1-APR). An unfiled slot appears in the
  // "due soon" widget when its due date is within 30 days or overdue.
  const formsSoon = React.useMemo(() => {
    const byKey = new Map<string, PayrollForm>();
    for (const f of recentForms) {
      // Employee-scoped forms (W-2) are excluded from the rollup widget; the
      // per-employee progress already surfaces on /payroll/forms.
      if (f.employee_id) continue;
      const key = `${f.form_type}|${f.quarter ?? ""}`;
      byKey.set(key, f);
    }

    const slots: FormSlot[] = [];
    for (const q of [1, 2, 3, 4] as const) {
      slots.push({
        id: `941-${q}`,
        type: "941",
        quarter: q,
        label: `${PAYROLL_FORM_TYPE_LABELS["941"]} - Q${q} ${taxYear}`,
        href: `/payroll/forms/941/${taxYear}/${q}`,
        dueDate: form941DueDate(taxYear, q),
        form: byKey.get(`941|${q}`) ?? null,
      });
      slots.push({
        id: `a1_qrt-${q}`,
        type: "a1_qrt",
        quarter: q,
        label: `${PAYROLL_FORM_TYPE_LABELS.a1_qrt} - Q${q} ${taxYear}`,
        href: `/payroll/forms/a1-qrt/${taxYear}/${q}`,
        dueDate: formA1QrtDueDate(taxYear, q),
        form: byKey.get(`a1_qrt|${q}`) ?? null,
      });
    }
    slots.push({
      id: "940",
      type: "940",
      quarter: null,
      label: `${PAYROLL_FORM_TYPE_LABELS["940"]} ${taxYear}`,
      href: `/payroll/forms/940/${taxYear}`,
      dueDate: form940DueDate(taxYear),
      form: byKey.get("940|") ?? null,
    });
    slots.push({
      id: "w3",
      type: "w3",
      quarter: null,
      label: `${PAYROLL_FORM_TYPE_LABELS.w3} ${taxYear}`,
      href: `/payroll/forms/w3/${taxYear}`,
      dueDate: w2DueDate(taxYear),
      form: byKey.get("w3|") ?? null,
    });
    slots.push({
      id: "a1_apr",
      type: "a1_apr",
      quarter: null,
      label: `${PAYROLL_FORM_TYPE_LABELS.a1_apr} ${taxYear}`,
      href: `/payroll/forms/a1-apr/${taxYear}`,
      dueDate: formA1AprDueDate(taxYear),
      form: byKey.get("a1_apr|") ?? null,
    });

    return slots
      .filter((s) => s.form?.status !== "filed")
      .filter((s) => diffDays(s.dueDate, today) <= 30)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 5);
  }, [recentForms, taxYear, today]);
  const activeEmployees = React.useMemo(
    () => employees.filter((e) => e.status === "active"),
    [employees],
  );

  // YTD totals from contributing runs (finalized + paid, not voided).
  const ytd = React.useMemo(() => {
    const contributing = yearRuns.filter(
      (r) => r.status === "finalized" || r.status === "paid",
    );
    return aggregateYtd(contributing);
  }, [yearRuns]);

  const employerCostYtd =
    ytd.grossYtd +
    ytd.socialSecurityEmployerYtd +
    ytd.medicareEmployerYtd +
    ytd.futaYtd +
    ytd.sutaYtd +
    ytd.stateDisabilityEmployerYtd;

  // Upcoming schedule: group active employees by their next pay window
  // (period_start, period_end, pay_date). Mirrors the /payroll/run landing
  // so the overview and the run flow speak the same language.
  const upcomingWindows = React.useMemo(() => {
    const now = new Date();
    const byKey = new Map<string, UpcomingWindow>();
    const scheduleErrors: PayrollEmployee[] = [];

    for (const emp of activeEmployees) {
      try {
        const period = getNextPayPeriod(
          {
            pay_frequency: emp.pay_frequency,
            pay_anchor_date: emp.pay_anchor_date,
            pay_lag_days: emp.pay_lag_days,
            semimonthly_days: emp.semimonthly_days,
            monthly_day: emp.monthly_day,
          },
          now,
        );
        const key = `${period.pay_date}|${period.period_start}|${period.period_end}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.employees.push(emp);
        } else {
          byKey.set(key, {
            id: key,
            period_start: period.period_start,
            period_end: period.period_end,
            pay_date: period.pay_date,
            employees: [emp],
          });
        }
      } catch {
        scheduleErrors.push(emp);
      }
    }

    const windows = Array.from(byKey.values()).sort((a, b) =>
      a.pay_date.localeCompare(b.pay_date),
    );
    return { windows, scheduleErrors };
  }, [activeEmployees]);

  // S-Corp compensation tracker: for employees with target_annual_comp set,
  // show their YTD gross against the target. Helps owner-operators stay on
  // top of reasonable compensation requirements.
  const compTrackers = React.useMemo(() => {
    const byEmployee = new Map<string, number>();
    for (const run of yearRuns) {
      if (run.status !== "finalized" && run.status !== "paid") continue;
      byEmployee.set(
        run.employee_id,
        (byEmployee.get(run.employee_id) ?? 0) + Number(run.gross_pay || 0),
      );
    }
    return activeEmployees
      .filter(
        (e) => e.target_annual_comp != null && Number(e.target_annual_comp) > 0,
      )
      .map((e) => ({
        employee: e,
        target: Number(e.target_annual_comp),
        grossYtd: byEmployee.get(e.id) ?? 0,
      }));
  }, [activeEmployees, yearRuns]);

  const orgName = organization?.legal_name ?? "Your company";

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Users2 className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Payroll</h1>
            <p className="text-sm text-muted-foreground">
              {orgName} - tax year {taxYear}
            </p>
          </div>
        </div>
        <Link href="/payroll/run">
          <Button>
            <Play className="h-4 w-4 mr-1" aria-hidden="true" />
            Start payroll
          </Button>
        </Link>
      </div>

      {/* Current cycle: the hero "where am I" panel. Shows the latest non-voided
          pay cycle's state and the next concrete action the user needs to take. */}
      <CurrentCyclePanel runs={yearRuns} deposits={yearDeposits} />

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          title={`Gross YTD (${taxYear})`}
          value={ytd.grossYtd}
          icon={<Wallet className="h-5 w-5" aria-hidden="true" />}
          className="stagger-1"
        />
        <StatCard
          title="Employer cost YTD"
          value={employerCostYtd}
          icon={<Wallet className="h-5 w-5" aria-hidden="true" />}
          className="stagger-2"
        />
        <StatCard
          title="Active employees"
          value={activeEmployees.length}
          format="number"
          icon={<Users2 className="h-5 w-5" aria-hidden="true" />}
          className="stagger-3"
        />
      </div>

      {/* Upcoming pay schedule - grouped by pay window to mirror /payroll/run */}
      <div className="glass-card rounded-xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Upcoming pay dates
              </h3>
            </div>
            <p className="text-xs text-muted-foreground">
              The next pay runs that need to be processed. Click a row to preview and run that cycle.
            </p>
          </div>
          {upcomingWindows.windows.length > 0 && (
            <Link
              href="/payroll/run"
              className="text-xs text-primary hover:underline flex-shrink-0 mt-1"
            >
              View all
            </Link>
          )}
        </div>
        <div className="border-t border-border pt-3">
          {upcomingWindows.windows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {activeEmployees.length === 0 ? (
                <>
                  No active employees yet.{" "}
                  <Link
                    href="/payroll/employees/new"
                    className="text-primary hover:underline"
                  >
                    Add your first
                  </Link>
                  .
                </>
              ) : (
                <>
                  All active employees have schedule errors.{" "}
                  <Link
                    href="/payroll/employees"
                    className="text-primary hover:underline"
                  >
                    Fix pay configuration
                  </Link>
                  .
                </>
              )}
            </p>
          ) : (
            <div className="space-y-2">
              {upcomingWindows.windows.slice(0, 5).map((w) => {
                const count = w.employees.length;
                const href = `/payroll/run?pay_date=${encodeURIComponent(
                  w.pay_date,
                )}&employees=${w.employees.map((e) => e.id).join(",")}`;
                const primaryFreq = w.employees[0]?.pay_frequency;
                return (
                  <Link
                    key={w.id}
                    href={href}
                    className="flex items-center justify-between gap-3 flex-wrap text-sm hover:bg-secondary/30 rounded-md -mx-2 px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary flex-shrink-0">
                        <CalendarDays className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate">
                          {primaryFreq ? PAY_FREQUENCY_LABELS[primaryFreq] : "Pay cycle"}
                          {" - "}
                          {count} {count === 1 ? "employee" : "employees"}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          Period {formatRange(w.period_start, w.period_end)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <DueBadge dueDate={w.pay_date} today={today} />
                      <div className="font-mono text-xs text-muted-foreground">
                        {w.pay_date}
                      </div>
                    </div>
                  </Link>
                );
              })}
              {upcomingWindows.scheduleErrors.length > 0 && (
                <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2">
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-warning mt-0.5 flex-shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {upcomingWindows.scheduleErrors.length} employee
                    {upcomingWindows.scheduleErrors.length === 1 ? "" : "s"}{" "}
                    with schedule issues.{" "}
                    <Link
                      href="/payroll/run"
                      className="text-primary hover:underline"
                    >
                      Review
                    </Link>
                    .
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* S-Corp comp tracker */}
      {compTrackers.length > 0 && (
        <div className="glass-card rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Reasonable compensation tracker
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Shareholder-employees with a target annual W-2 wage. Stay ahead of
            the reasonable compensation requirement by tracking YTD gross
            against target.
          </p>
          <div className="border-t border-border pt-3 space-y-4">
            {compTrackers.map((t) => {
              const ratio = t.target > 0 ? t.grossYtd / t.target : 0;
              const pct = Math.min(100, Math.max(0, ratio * 100));
              const isOnTrack = monthProgress(taxYear) <= ratio + 0.02;
              return (
                <div key={t.employee.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm flex-wrap">
                    <span className="font-medium text-foreground">
                      {t.employee.first_name} {t.employee.last_name}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      <MaskedValue value={formatCurrency(t.grossYtd)} /> /{" "}
                      <MaskedValue value={formatCurrency(t.target)} />
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        isOnTrack ? "bg-success" : "bg-warning",
                      )}
                      style={{ width: `${pct}%` }}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {pct.toFixed(1)}% of target
                    {" - "}
                    year is {Math.round(monthProgress(taxYear) * 100)}% through
                    {!isOnTrack && (
                      <span className="text-warning font-medium">
                        {" - "}behind pace
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Upcoming deposits */}
      {depositsSoon.length > 0 && (
        <div className="glass-card rounded-xl p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Tax deposits due soon
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Federal and state tax payments owed for recent pay periods. Pay before the due date to avoid penalties.
              </p>
            </div>
            <Link
              href="/payroll/deposits"
              className="text-xs text-primary hover:underline flex-shrink-0 mt-1"
            >
              View all
            </Link>
          </div>
          <div className="border-t border-border pt-3 space-y-2">
            {depositsSoon.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between gap-3 flex-wrap text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium text-foreground truncate">
                    {DEPOSIT_TYPE_LABELS[d.deposit_type]}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Period {d.period_start} to {d.period_end}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-wrap flex-shrink-0">
                  <DueBadge dueDate={d.due_date} today={today} />
                  <div className="font-mono text-sm text-foreground">
                    {formatCurrency(Number(d.amount || 0))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming forms */}
      {formsSoon.length > 0 && (
        <div className="glass-card rounded-xl p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2">
                <FileCheck2
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Tax forms due soon
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Required quarterly and annual filings. Generate a draft, review it, then mark it filed once submitted.
              </p>
            </div>
            <Link
              href="/payroll/forms"
              className="text-xs text-primary hover:underline flex-shrink-0 mt-1"
            >
              View all
            </Link>
          </div>
          <div className="border-t border-border pt-3 space-y-2">
            {formsSoon.map((s) => {
              const isDraft =
                s.form?.status === "draft" || s.form?.status === "generated";
              return (
                <Link
                  key={s.id}
                  href={s.href}
                  className="flex items-center justify-between gap-3 flex-wrap text-sm hover:bg-secondary/30 rounded-md -mx-2 px-2 py-1.5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FormStatusBadge isDraft={isDraft} />
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {s.label}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {isDraft
                          ? "Draft ready to review"
                          : "Not started - click to generate"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <DueBadge dueDate={s.dueDate} today={today} />
                    <div className="font-mono text-xs text-muted-foreground">
                      {s.dueDate}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Nav cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <NavCard
          href="/payroll/deposits"
          icon={<Landmark className="h-5 w-5" aria-hidden="true" />}
          title="Tax deposits"
          subtitle="Federal and state tax payments owed"
        />
        <NavCard
          href="/payroll/forms"
          icon={<FileCheck2 className="h-5 w-5" aria-hidden="true" />}
          title="Tax forms"
          subtitle="Quarterly and annual filings"
        />
        <NavCard
          href="/payroll/employees"
          icon={<Users2 className="h-5 w-5" aria-hidden="true" />}
          title="Employees"
          subtitle="Roster, W-4, and pay config"
        />
        <NavCard
          href="/payroll/config"
          icon={<Settings2 className="h-5 w-5" aria-hidden="true" />}
          title="Settings"
          subtitle="Organization and tax tables"
        />
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Urgency pill for a due date. Red for overdue/today, amber for the next
 *  week, blue for the next fortnight, grey beyond that. Communicates "how
 *  much time you have" at a glance without the user having to compute days. */
function DueBadge({ dueDate, today }: { dueDate: string; today: string }) {
  const days = Math.round(diffDays(dueDate, today));

  let variant: "error" | "warning" | "primary" | "muted";
  let text: string;

  if (days < 0) {
    variant = "error";
    const abs = -days;
    text = abs === 1 ? "1 day late" : `${abs} days late`;
  } else if (days === 0) {
    variant = "error";
    text = "Due today";
  } else if (days <= 7) {
    variant = "warning";
    text = days === 1 ? "Due tomorrow" : `Due in ${days}d`;
  } else if (days <= 14) {
    variant = "primary";
    text = `Due in ${days}d`;
  } else {
    variant = "muted";
    text = `In ${days}d`;
  }

  const variantClasses: Record<typeof variant, string> = {
    error: "bg-error/10 text-error",
    warning: "bg-warning/10 text-warning",
    primary: "bg-primary/10 text-primary",
    muted: "bg-secondary text-muted-foreground",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap",
        variantClasses[variant],
      )}
    >
      {text}
    </span>
  );
}

/** Status indicator for a tax form: solid dot filled when a draft is ready,
 *  outlined when no form has been generated yet. Tells the user at a glance
 *  whether they need to generate or review. */
function FormStatusBadge({ isDraft }: { isDraft: boolean }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0",
        isDraft ? "bg-warning/10 text-warning" : "bg-secondary text-muted-foreground",
      )}
      aria-hidden="true"
    >
      <FileCheck2 className="h-4 w-4" />
    </span>
  );
}

function NavCard({
  href,
  icon,
  title,
  subtitle,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "glass-card rounded-xl p-4 flex items-center gap-4 transition-all duration-200",
        "hover:border-primary/30 hover:scale-[1.01]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <ChevronRight
        className="h-4 w-4 text-muted-foreground/50"
        aria-hidden="true"
      />
    </Link>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "Apr 6 - Apr 19, 2026" or "Apr 30 - May 13, 2026". Collapses year when
 *  start and end share it; drops redundant month when they match. Matches
 *  the formatting used on /payroll/run so the widget speaks the same language. */
function formatRange(start: string, end: string): string {
  const s = parseLocal(start);
  const e = parseLocal(end);
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();

  const startFmt = s.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endFmt = sameMonth
    ? String(e.getDate())
    : e.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const yearFmt = e.getFullYear();

  return `${startFmt} - ${endFmt}, ${yearFmt}`;
}

function parseLocal(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayLocalYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function diffDays(target: string, from: string): number {
  const t = Date.parse(`${target}T00:00:00Z`);
  const f = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(f)) return Number.POSITIVE_INFINITY;
  return (t - f) / 86_400_000;
}

/** Fraction of the year elapsed (0..1). Used as a pace indicator for the
 *  reasonable-comp tracker: if ratio >= monthProgress(year), comp is on pace. */
function monthProgress(taxYear: number): number {
  const now = new Date();
  if (now.getUTCFullYear() < taxYear) return 0;
  if (now.getUTCFullYear() > taxYear) return 1;
  const start = Date.UTC(taxYear, 0, 1);
  const end = Date.UTC(taxYear + 1, 0, 1);
  return (now.getTime() - start) / (end - start);
}
