"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCheck2, Landmark } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { generateFormA1Qrt } from "@/lib/payroll/forms-actions";
import {
  FormViewerShell,
  LineRow,
  SectionHeading,
} from "./form-viewer-shell";
import type {
  FormA1QrtData,
  OrganizationConfig,
  PayrollForm,
} from "@/types/payroll";
import { Term } from "./term";

interface Props {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  form: PayrollForm | null;
  formData: FormA1QrtData | null;
  organization: OrganizationConfig | null;
}

export function FormA1QrtContent({
  year,
  quarter,
  form,
  formData,
  organization: _organization,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const handleGenerate = async () => {
    setSubmitting(true);
    try {
      const res = await generateFormA1Qrt({ tax_year: year, quarter });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to generate A1-QRT");
        return;
      }
      setWarnings(res.data?.warnings ?? []);
      toast("success", "AZ Form A1-QRT generated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormViewerShell
      icon={FileCheck2}
      title={`AZ A1-QRT - Q${quarter} ${year}`}
      subtitle={
        <>
          <Term slug="a1_qrt">Arizona A-1-QRT</Term>: Quarterly state
          withholding reconciliation.
        </>
      }
      form={form}
      hasData={formData != null}
      onGenerate={handleGenerate}
      submitting={submitting}
      warnings={warnings}
      emptyStateHint={`AZ Form A1-QRT has not been generated for Q${quarter} ${year}.`}
      discardEditsDescription="Your saved edits on this A1-QRT will be replaced by freshly aggregated values from the pay runs. This cannot be undone."
    >
      {formData && <FormA1QrtLayout data={formData} />}
    </FormViewerShell>
  );
}

function FormA1QrtLayout({ data }: { data: FormA1QrtData }) {
  return (
    <div className="space-y-6">
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Quarterly summary</SectionHeading>
        <LineRow
          number=""
          label="Employees paid in quarter"
          value={data.employees}
          format="integer"
        />
        <LineRow
          number=""
          label="Total Arizona wages"
          value={data.total_az_wages}
        />
        <div className="border-t border-border my-2 pt-2">
          <LineRow
            number="A"
            label="Arizona income tax withheld"
            value={data.line_a_az_tax_withheld}
            emphasis
          />
          <LineRow
            number="B"
            label="Arizona tax paid (A1-WP deposits)"
            value={data.line_b_az_tax_paid}
          />
          {data.line_c_overpayment > 0 && (
            <LineRow
              number="C"
              label="Overpayment (Line B - A)"
              value={data.line_c_overpayment}
              tone="success"
              emphasis
            />
          )}
          {data.line_d_balance_due > 0 && (
            <LineRow
              number="D"
              label="Balance due (Line A - B)"
              value={data.line_d_balance_due}
              tone="error"
              emphasis
            />
          )}
        </div>
      </section>

      <section className="glass-card rounded-xl p-5 space-y-3">
        <SectionHeading>Deposit schedule</SectionHeading>
        <p className="text-xs text-muted-foreground">
          {data.deposit_schedule === "quarterly"
            ? "Quarterly depositor - tax paid with this return."
            : data.deposit_schedule === "monthly"
              ? "Monthly depositor - per-month liability below sums to Line A."
              : "Semiweekly depositor - per-day liability (Schedule A) below sums to Line A."}
        </p>
        {data.deposit_schedule === "monthly" && data.monthly_liability && (
          <MonthlyTable
            monthly={data.monthly_liability}
            lineA={data.line_a_az_tax_withheld}
            year={data.tax_year}
            quarter={data.quarter}
          />
        )}
        {data.deposit_schedule === "semiweekly" && data.schedule_a && (
          <ScheduleATable entries={data.schedule_a} />
        )}
      </section>

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Deposit reconciliation</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Line B reflects A1-WP state withholding deposits for this quarter
          that are marked as paid in the{" "}
          <Link
            href="/payroll/deposits"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            <Landmark className="h-3 w-3" aria-hidden="true" />
            deposits ledger
          </Link>
          . Scheduled-but-unpaid deposits do not count here.
        </p>
      </section>
    </div>
  );
}

function MonthlyTable({
  monthly,
  lineA,
  year,
  quarter,
}: {
  monthly: { month1: number; month2: number; month3: number };
  lineA: number;
  year: number;
  quarter: number;
}) {
  const startMonth = (quarter - 1) * 3;
  const months = [0, 1, 2].map((i) => monthName(year, startMonth + i));
  const sum =
    Math.round((monthly.month1 + monthly.month2 + monthly.month3) * 100) / 100;
  const matches = Math.abs(sum - lineA) < 0.005;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <tbody>
          <tr className="border-b border-border">
            <td className="px-3 py-2 text-muted-foreground">{months[0]}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {formatCurrency(monthly.month1)}
            </td>
          </tr>
          <tr className="border-b border-border">
            <td className="px-3 py-2 text-muted-foreground">{months[1]}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {formatCurrency(monthly.month2)}
            </td>
          </tr>
          <tr className="border-b border-border">
            <td className="px-3 py-2 text-muted-foreground">{months[2]}</td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {formatCurrency(monthly.month3)}
            </td>
          </tr>
          <tr className="bg-secondary/40">
            <td className="px-3 py-2 font-semibold">Total (must equal Line A)</td>
            <td
              className={cn(
                "px-3 py-2 text-right font-mono tabular-nums font-semibold",
                !matches && "text-error",
              )}
            >
              {formatCurrency(sum)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ScheduleATable({
  entries,
}: {
  entries: Array<{ date: string; amount: number }>;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No withholding liability days in this quarter.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Date</th>
            <th className="text-right px-3 py-2 font-medium">Daily liability</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.date} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-muted-foreground">
                {e.date}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCurrency(e.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function monthName(year: number, monthIndex0: number): string {
  return new Date(Date.UTC(year, monthIndex0, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
