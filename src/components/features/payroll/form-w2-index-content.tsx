"use client";

import * as React from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PayrollForm } from "@/types/payroll";
import { formStatusLabel } from "@/lib/payroll/labels";

export interface W2EmployeeRow {
  id: string;
  first_name: string;
  last_name: string;
  status: string;
  had_runs: boolean;
  form: PayrollForm | null;
}

interface Props {
  year: number;
  employees: W2EmployeeRow[];
}

export function FormW2IndexContent({ year, employees }: Props) {
  const withRuns = employees.filter((e) => e.had_runs);
  const withoutRuns = employees.filter((e) => !e.had_runs);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <FileText className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">W-2 Forms - {year}</h1>
            <p className="text-sm text-muted-foreground">
              Per-employee Wage and Tax Statements
            </p>
          </div>
        </div>
      </div>

      {withRuns.length === 0 && withoutRuns.length === 0 && (
        <div className="glass-card rounded-xl p-10 text-center text-sm text-muted-foreground">
          No employees on file for {year}. Add employees in the{" "}
          <Link href="/payroll/employees" className="text-primary hover:underline">
            employee roster
          </Link>{" "}
          first.
        </div>
      )}

      {withRuns.length > 0 && (
        <section className="glass-card rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold">
            Employees paid in {year}
          </h2>
          <p className="text-xs text-muted-foreground">
            Each employee who received wages this year needs a W-2. Click any
            row to generate or view their W-2.
          </p>
          <div className="space-y-2">
            {withRuns.map((e) => (
              <EmployeeRow key={e.id} year={year} employee={e} />
            ))}
          </div>
        </section>
      )}

      {withoutRuns.length > 0 && (
        <section className="glass-card rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold">
            Employees with no {year} payroll
          </h2>
          <p className="text-xs text-muted-foreground">
            These employees have no approved or paid runs in {year}. A W-2 is
            not required unless they received wages.
          </p>
          <div className="space-y-2">
            {withoutRuns.map((e) => (
              <EmployeeRow key={e.id} year={year} employee={e} muted />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EmployeeRow({
  year,
  employee,
  muted,
}: {
  year: number;
  employee: W2EmployeeRow;
  muted?: boolean;
}) {
  const href = `/payroll/forms/w2/${year}/${employee.id}`;
  const status = employee.form?.status ?? null;

  return (
    <Link
      href={href}
      className={cn(
        "rounded-lg border border-border p-3 flex items-center gap-3 transition-colors hover:border-primary/30 hover:bg-secondary/30",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        muted && "opacity-70",
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-lg",
          status === "filed"
            ? "bg-success/10 text-success"
            : "bg-primary/10 text-primary",
        )}
        aria-hidden="true"
      >
        {status === "filed" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Clock className="h-4 w-4" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground truncate">
          {employee.first_name} {employee.last_name}
        </div>
        <div className="text-xs text-muted-foreground">
          {status === "filed"
            ? formStatusLabel("filed")
            : status === "generated"
              ? formStatusLabel("generated")
              : status === "draft"
                ? "Edited draft"
                : "Not started"}
        </div>
      </div>
      <ChevronRight
        className="h-4 w-4 text-muted-foreground/50"
        aria-hidden="true"
      />
    </Link>
  );
}
