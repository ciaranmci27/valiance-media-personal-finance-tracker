"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Users2,
  UserPlus,
  Calendar,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { MaskedValue } from "@/components/ui/masked-value";
import { formatCurrency, cn } from "@/lib/utils";
import type { PayrollEmployee, PayFrequency } from "@/types/payroll";

interface Props {
  employees: PayrollEmployee[];
}

type TabValue = "active" | "terminated" | "all";

const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  semimonthly: "Semimonthly",
  monthly: "Monthly",
  annual: "Annual",
};

const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
};

function annualizedComp(employee: PayrollEmployee): number {
  return (
    Number(employee.pay_amount || 0) *
    PERIODS_PER_YEAR[employee.pay_frequency]
  );
}

export function EmployeesListContent({ employees }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState<TabValue>("active");

  const counts = React.useMemo(() => {
    let active = 0;
    let terminated = 0;
    for (const e of employees) {
      if (e.status === "active") active += 1;
      else terminated += 1;
    }
    return { active, terminated, all: employees.length };
  }, [employees]);

  const totalAnnualComp = React.useMemo(
    () =>
      employees
        .filter((e) => e.status === "active")
        .reduce((sum, e) => sum + annualizedComp(e), 0),
    [employees],
  );

  const filtered = React.useMemo(() => {
    const list =
      activeTab === "all"
        ? employees
        : employees.filter((e) => e.status === activeTab);
    return [...list].sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "active" ? -1 : 1;
      }
      return a.last_name.localeCompare(b.last_name);
    });
  }, [employees, activeTab]);

  const tabs: { value: TabValue; label: string; count: number }[] = [
    { value: "active", label: "Active", count: counts.active },
    { value: "terminated", label: "Terminated", count: counts.terminated },
    { value: "all", label: "All", count: counts.all },
  ];

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Users2 className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Employees</h1>
              <p className="text-sm text-muted-foreground">
                Roster, W-4 elections, and pay configuration
              </p>
            </div>
          </div>
        </div>
        <Link href="/payroll/employees/new">
          <Button>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add Employee
          </Button>
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard
          title="Active Employees"
          value={counts.active}
          format="number"
          icon={<Users2 className="h-5 w-5" aria-hidden="true" />}
          className="stagger-1"
        />
        <StatCard
          title="Annualized Comp"
          value={totalAnnualComp}
          icon={<Calendar className="h-5 w-5" aria-hidden="true" />}
          className="stagger-2"
        />
        <StatCard
          title="Total Records"
          value={counts.all}
          format="number"
          icon={<UserPlus className="h-5 w-5" aria-hidden="true" />}
          className="stagger-3"
        />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              activeTab === tab.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {tab.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-xs",
                activeTab === tab.value
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="glass-card rounded-xl p-10 text-center space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <UserPlus className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-foreground">
            {activeTab === "terminated"
              ? "No terminated employees"
              : "No employees yet"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {activeTab === "terminated"
              ? "Employees you mark as terminated will appear here."
              : "Add your first employee to begin running payroll."}
          </p>
          {activeTab !== "terminated" && (
            <div className="pt-2">
              <Link href="/payroll/employees/new">
                <Button>
                  <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
                  Add Employee
                </Button>
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((employee, index) => (
            <button
              key={employee.id}
              type="button"
              onClick={() => router.push(`/payroll/employees/${employee.id}`)}
              className={cn(
                "w-full text-left glass-card rounded-xl p-4 transition-all duration-200",
                "hover:border-primary/30 hover:scale-[1.01]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                "animate-fade-up",
                `stagger-${Math.min(index + 1, 6)}`,
                employee.status === "terminated" && "opacity-60",
              )}
            >
              <div className="flex items-center gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary font-semibold">
                  {initialsOf(employee.first_name, employee.last_name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-foreground truncate">
                      {employee.first_name} {employee.last_name}
                    </h3>
                    <StatusBadge status={employee.status} />
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {PAY_FREQUENCY_LABELS[employee.pay_frequency]}
                    {" - "}
                    <span className="font-mono">
                      <MaskedValue
                        value={formatCurrency(Number(employee.pay_amount))}
                      />
                    </span>
                    {" / period - "}
                    <span className="font-mono">
                      <MaskedValue
                        value={formatCurrency(annualizedComp(employee))}
                      />
                    </span>
                    {" annualized"}
                  </p>
                </div>
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

function initialsOf(first: string, last: string): string {
  const a = first.trim().charAt(0).toUpperCase();
  const b = last.trim().charAt(0).toUpperCase();
  return `${a}${b}` || "?";
}

function StatusBadge({ status }: { status: "active" | "terminated" }) {
  if (status === "active") {
    return (
      <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-success/10 text-success">
        Active
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-muted text-muted-foreground">
      Terminated
    </span>
  );
}
