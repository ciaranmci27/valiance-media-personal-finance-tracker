"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  FileText,
  ListChecks,
  Plus,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaskedValue } from "@/components/ui/masked-value";
import { CustomSelect } from "@/components/ui/select";
import { StatCard } from "@/components/ui/stat-card";
import { formatCurrency, cn } from "@/lib/utils";
import { RUN_TYPE_LABELS } from "@/types/payroll";
import type { RunStatus } from "@/types/payroll";
import type { PayrollRunListItem } from "@/types/payroll";
import { RUN_STATUS_HUMAN, runStatusLabel } from "@/lib/payroll/labels";

type StatusFilter = "all" | RunStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: RUN_STATUS_HUMAN.draft },
  { value: "finalized", label: RUN_STATUS_HUMAN.finalized },
  { value: "paid", label: RUN_STATUS_HUMAN.paid },
  { value: "voided", label: RUN_STATUS_HUMAN.voided },
];

export function RunsListContent({ runs }: { runs: PayrollRunListItem[] }) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [year, setYear] = React.useState<number | "all">(() =>
    runs.length > 0 ? taxYearOf(runs[0].pay_date) : "all",
  );

  const years = React.useMemo(() => {
    const set = new Set<number>();
    for (const r of runs) set.add(taxYearOf(r.pay_date));
    return Array.from(set).sort((a, b) => b - a);
  }, [runs]);

  const filtered = React.useMemo(() => {
    return runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (year !== "all" && taxYearOf(r.pay_date) !== year) return false;
      return true;
    });
  }, [runs, statusFilter, year]);

  const stats = React.useMemo(() => {
    let grossYtd = 0;
    let netYtd = 0;
    let employeeTaxYtd = 0;
    let runCount = 0;
    for (const r of filtered) {
      if (r.status !== "finalized" && r.status !== "paid") continue;
      runCount += 1;
      grossYtd += Number(r.gross_pay || 0);
      netYtd += Number(r.net_pay || 0);
      employeeTaxYtd +=
        Number(r.federal_income_tax || 0) +
        Number(r.state_income_tax || 0) +
        Number(r.social_security_employee || 0) +
        Number(r.medicare_employee || 0) +
        Number(r.additional_medicare || 0) +
        Number(r.state_disability_employee || 0);
    }
    return { grossYtd, netYtd, employeeTaxYtd, runCount };
  }, [filtered]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <ListChecks className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Pay Runs</h1>
              <p className="text-sm text-muted-foreground">
                History and status of every pay run
              </p>
            </div>
          </div>
        </div>
        <Link href="/payroll/run">
          <Button>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Start payroll
          </Button>
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          title={`Gross (${year === "all" ? "all years" : year})`}
          value={stats.grossYtd}
          icon={<Wallet className="h-5 w-5" aria-hidden="true" />}
          className="stagger-1"
        />
        <StatCard
          title="Employee taxes withheld"
          value={stats.employeeTaxYtd}
          icon={<FileText className="h-5 w-5" aria-hidden="true" />}
          className="stagger-2"
        />
        <StatCard
          title="Net paid"
          value={stats.netYtd}
          icon={<Wallet className="h-5 w-5" aria-hidden="true" />}
          className="stagger-3"
        />
      </div>

      {/* Filters */}
      <div className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg bg-card p-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                statusFilter === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {years.length > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-muted-foreground">Year</label>
            <div className="w-28">
              <CustomSelect
                size="sm"
                value={year === "all" ? "all" : String(year)}
                onChange={(v) => setYear(v === "all" ? "all" : Number(v))}
                options={[
                  { value: "all", label: "All" },
                  ...years.map((y) => ({ value: String(y), label: String(y) })),
                ]}
              />
            </div>
          </div>
        )}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="glass-card rounded-xl p-10 text-center space-y-2">
          <h3 className="text-base font-semibold">No pay runs yet</h3>
          <p className="text-sm text-muted-foreground">
            Start your first pay run and it&apos;ll appear here.
          </p>
          <div className="pt-2">
            <Link href="/payroll/run">
              <Button>
                <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
                Start payroll
              </Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((run, index) => (
            <button
              key={run.id}
              type="button"
              onClick={() => router.push(`/payroll/runs/${run.id}`)}
              className={cn(
                "w-full text-left glass-card rounded-xl p-4 transition-all duration-200",
                "hover:border-primary/30 hover:scale-[1.005]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                "animate-fade-up",
                `stagger-${Math.min(index + 1, 6)}`,
                run.status === "voided" && "opacity-60",
              )}
            >
              <div className="flex items-center gap-4 flex-wrap">
                <div className="min-w-[110px]">
                  <div className="text-xs text-muted-foreground">Pay date</div>
                  <div className="font-mono text-sm text-foreground">
                    {run.pay_date}
                  </div>
                </div>
                <div className="flex-1 min-w-[180px]">
                  <div className="text-xs text-muted-foreground">Employee</div>
                  <div className="text-sm font-medium text-foreground truncate">
                    {run.payroll_employees
                      ? `${run.payroll_employees.first_name} ${run.payroll_employees.last_name}`
                      : "(removed)"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {RUN_TYPE_LABELS[run.run_type]} - period{" "}
                    {run.period_start} to {run.period_end}
                  </div>
                </div>
                <div className="min-w-[100px]">
                  <div className="text-xs text-muted-foreground">Gross</div>
                  <div className="font-mono text-sm text-foreground">
                    <MaskedValue value={formatCurrency(Number(run.gross_pay))} />
                  </div>
                </div>
                <div className="min-w-[100px]">
                  <div className="text-xs text-muted-foreground">Net</div>
                  <div className="font-mono text-sm text-foreground">
                    <MaskedValue value={formatCurrency(Number(run.net_pay))} />
                  </div>
                </div>
                <RunStatusBadge status={run.status} />
                <ChevronRight
                  className="h-5 w-5 text-muted-foreground/50"
                  aria-hidden="true"
                />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function taxYearOf(ymd: string): number {
  return Number(ymd.split("-")[0]);
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const tone =
    status === "paid"
      ? "bg-success/10 text-success"
      : status === "finalized"
        ? "bg-primary/10 text-primary"
        : status === "voided"
          ? "bg-error/10 text-error"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded",
        tone,
      )}
    >
      {runStatusLabel(status)}
    </span>
  );
}
