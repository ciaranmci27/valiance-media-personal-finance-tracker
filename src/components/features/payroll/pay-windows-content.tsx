"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Play,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { toast } from "@/components/ui/toast";
import { cn, formatDate } from "@/lib/utils";
import type {
  PayWindow,
  PayWindowEmployee,
} from "@/lib/payroll/runs-actions";

interface Props {
  windows: PayWindow[];
  errors: { employee: PayWindowEmployee; reason: string }[];
}

export function PayWindowsContent({ windows, errors }: Props) {
  const router = useRouter();
  const [customDate, setCustomDate] = React.useState("");

  const handleCustomDate = () => {
    if (!customDate) {
      toast("info", "Enter a pay date to preview");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
      toast("error", "Enter a valid date (YYYY-MM-DD)");
      return;
    }
    router.push(`/payroll/run?pay_date=${encodeURIComponent(customDate)}`);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Play className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Calculate Payroll</h1>
            <p className="text-sm text-muted-foreground">
              Upcoming pay cycles grouped by schedule
            </p>
          </div>
        </div>
      </div>

      {/* Schedule errors */}
      {errors.length > 0 && (
        <div className="glass-card rounded-xl p-4 border border-warning/30 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle
              className="h-4 w-4 text-warning"
              aria-hidden="true"
            />
            <h3 className="text-sm font-semibold text-foreground">
              {errors.length} employee
              {errors.length === 1 ? "" : "s"} have schedule issues
            </h3>
          </div>
          <ul className="space-y-1 text-sm pl-6 list-disc">
            {errors.map((e) => (
              <li key={e.employee.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {e.employee.first_name} {e.employee.last_name}
                </span>
                {" - "}
                {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Windows list */}
      {windows.length === 0 ? (
        <div className="space-y-3">
          <div className="glass-card rounded-xl p-10 text-center space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <CalendarDays
                className="h-6 w-6 text-primary"
                aria-hidden="true"
              />
            </div>
            <h3 className="text-base font-semibold">No upcoming pay cycles</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {errors.length > 0
                ? "All employees have schedule errors - fix their configuration above or on the employee pages."
                : "Add active employees with pay schedules to see pay cycles here."}
            </p>
            <div className="pt-2">
              <Link href="/payroll/employees">
                <Button variant="outline">Manage employees</Button>
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <CustomDateCard
              value={customDate}
              onChange={setCustomDate}
              onSubmit={handleCustomDate}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Next pay cycle{windows.length === 1 ? "" : "s"}
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {windows.map((w) => (
              <WindowCard key={w.id} window={w} />
            ))}
            <CustomDateCard
              value={customDate}
              onChange={setCustomDate}
              onSubmit={handleCustomDate}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Custom date card ─────────────────────────────────────────────────────────

interface CustomDateCardProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}

function CustomDateCard({ value, onChange, onSubmit }: CustomDateCardProps) {
  return (
    <div className="glass-card rounded-xl p-4 flex flex-col gap-3 border-dashed">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div
          className="flex h-10 w-10 items-center justify-center rounded-xl flex-shrink-0 bg-secondary/60 text-muted-foreground"
          aria-hidden="true"
        >
          <CalendarClock className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Custom pay date</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Preview a specific date (e.g., a catch-up run). Employees whose
            cadence does not match will be flagged as skipped.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
        <DateInput
          value={value}
          onChange={onChange}
          placeholder="YYYY-MM-DD"
          className="flex-1 min-w-[140px]"
          aria-label="Custom pay date"
        />
        <Button variant="outline" size="sm" onClick={onSubmit}>
          Preview date
        </Button>
      </div>
    </div>
  );
}

// ─── Window card ──────────────────────────────────────────────────────────────

function WindowCard({ window: w }: { window: PayWindow }) {
  const href = buildWindowHref(w);
  const employeeCount = w.employees.length;

  return (
    <Link
      href={href}
      className={cn(
        "group glass-card rounded-xl p-4 flex flex-col gap-3 transition-colors",
        "hover:border-primary/30 hover:bg-secondary/30",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl flex-shrink-0",
              w.overdue
                ? "bg-error/10 text-error"
                : w.has_existing_run
                  ? "bg-success/10 text-success"
                  : "bg-primary/10 text-primary",
            )}
            aria-hidden="true"
          >
            {w.overdue ? (
              <AlertTriangle className="h-5 w-5" />
            ) : w.has_existing_run ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <CalendarDays className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-foreground truncate">
                {w.frequency_label}
              </h3>
              {w.schedule_detail && (
                <span className="text-xs text-muted-foreground">
                  {w.schedule_detail}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              Period {formatRange(w.period_start, w.period_end)}
            </p>
          </div>
        </div>
        <ChevronRight
          className="h-4 w-4 text-muted-foreground/60 flex-shrink-0 mt-1 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Pay date
          </p>
          <p
            className={cn(
              "font-mono text-sm",
              w.overdue
                ? "text-error font-semibold"
                : w.imminent
                  ? "text-warning font-semibold"
                  : "text-foreground",
            )}
          >
            {formatDate(w.pay_date)}
          </p>
          {w.overdue && (
            <p className="text-[11px] text-error">Past due</p>
          )}
          {!w.overdue && w.imminent && (
            <p className="text-[11px] text-warning">Due within 7 days</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          <span>
            {employeeCount} {employeeCount === 1 ? "employee" : "employees"}
          </span>
        </div>
      </div>

      {employeeCount > 0 && (
        <div className="flex flex-wrap gap-1 pt-2 border-t border-border">
          {w.employees.slice(0, 5).map((e) => (
            <span
              key={e.id}
              className="text-[11px] px-2 py-0.5 rounded-full bg-secondary/50 text-muted-foreground"
            >
              {e.first_name} {e.last_name.charAt(0)}.
            </span>
          ))}
          {employeeCount > 5 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary/50 text-muted-foreground">
              +{employeeCount - 5} more
            </span>
          )}
        </div>
      )}

      {w.has_existing_run && (
        <p className="text-[11px] text-success">
          At least one employee already has a run for this period
        </p>
      )}
    </Link>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildWindowHref(w: PayWindow): string {
  const params = new URLSearchParams();
  params.set("pay_date", w.pay_date);
  params.set("employees", w.employees.map((e) => e.id).join(","));
  return `/payroll/run?${params.toString()}`;
}

/** "Apr 6 - Apr 19, 2026" or "Apr 30 - May 13, 2026". Collapses year when
 *  start and end share it; drops redundant month when they match. */
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
