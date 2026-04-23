"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCheck2, Landmark } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { generateForm940 } from "@/lib/payroll/forms-actions";
import {
  FormViewerShell,
  LineRow,
  SectionHeading,
} from "./form-viewer-shell";
import type {
  Form940Data,
  OrganizationConfig,
  PayrollForm,
} from "@/types/payroll";
import { Term } from "./term";

interface Props {
  year: number;
  form: PayrollForm | null;
  formData: Form940Data | null;
  organization: OrganizationConfig | null;
}

export function Form940Content({
  year,
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
      const res = await generateForm940({ tax_year: year });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to generate 940");
        return;
      }
      setWarnings(res.data?.warnings ?? []);
      toast("success", "Form 940 generated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormViewerShell
      icon={FileCheck2}
      title={`Form 940 - ${year}`}
      subtitle={
        <>
          Employer&apos;s Annual Federal Unemployment (
          <Term slug="futa">FUTA</Term>) Tax Return
        </>
      }
      form={form}
      hasData={formData != null}
      onGenerate={handleGenerate}
      submitting={submitting}
      warnings={warnings}
      emptyStateHint={`Form 940 has not been generated for ${year}.`}
      discardEditsDescription="Your saved edits on this Form 940 will be replaced by freshly aggregated values from the pay runs."
    >
      {formData && <Form940Layout data={formData} />}
    </FormViewerShell>
  );
}

function Form940Layout({ data }: { data: Form940Data }) {
  return (
    <div className="space-y-6">
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>
          <Term slug="futa">FUTA</Term> wages
        </SectionHeading>
        <LineRow
          number="3"
          label="Total payments to all employees"
          value={data.line_3_total_payments}
        />
        <LineRow
          number="4"
          label={<>Payments exempt from <Term slug="futa">FUTA</Term></>}
          value={data.line_4_payments_exempt}
        />
        <LineRow
          number="5"
          label="Payments to each employee over $7,000"
          value={data.line_5_payments_over_7000}
        />
        <LineRow
          number="7"
          label={<>Total taxable <Term slug="futa">FUTA</Term> wages</>}
          value={data.line_7_total_taxable}
          emphasis
        />
      </section>

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>
          <Term slug="futa">FUTA</Term> tax
        </SectionHeading>
        <LineRow
          number="8"
          label={
            <>
              <Term slug="futa">FUTA</Term> tax before adjustments (Line 7 ×
              0.006)
            </>
          }
          value={data.line_8_futa_before_adjustments}
        />
        <LineRow
          number="12"
          label={
            <>
              Total <Term slug="futa">FUTA</Term> tax after adjustments
            </>
          }
          value={data.line_12_futa_after_adjustments}
          emphasis
        />
        <div className="border-t border-border my-2 pt-2">
          {data.line_14_balance_due > 0 && (
            <LineRow
              number="14"
              label="Balance due"
              value={data.line_14_balance_due}
              tone="error"
              emphasis
            />
          )}
          {data.line_15_overpayment > 0 && (
            <LineRow
              number="15"
              label="Overpayment"
              value={data.line_15_overpayment}
              tone="success"
              emphasis
            />
          )}
        </div>
      </section>

      {data.quarterly_liability && (
        <section className="glass-card rounded-xl p-5 space-y-3">
          <SectionHeading>Part 5 - Quarterly liability</SectionHeading>
          <p className="text-xs text-muted-foreground">
            Required when total FUTA tax exceeds $500 for the year; always
            displayed here for completeness.
          </p>
          <QuarterlyTable
            quarterly={data.quarterly_liability}
            total={data.line_12_futa_after_adjustments}
          />
        </section>
      )}

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Deposit reconciliation</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Balance due and overpayment compare Line 12 to federal 940 deposits
          marked as paid in the{" "}
          <Link
            href="/payroll/deposits"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            <Landmark className="h-3 w-3" aria-hidden="true" />
            deposits ledger
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

function QuarterlyTable({
  quarterly,
  total,
}: {
  quarterly: { q1: number; q2: number; q3: number; q4: number };
  total: number;
}) {
  const sum =
    Math.round(
      (quarterly.q1 + quarterly.q2 + quarterly.q3 + quarterly.q4) * 100,
    ) / 100;
  const matches = Math.abs(sum - total) < 0.01;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <tbody>
          {(["q1", "q2", "q3", "q4"] as const).map((k, i) => (
            <tr key={k} className="border-b border-border">
              <td className="px-3 py-2 text-muted-foreground">
                Q{i + 1} FUTA liability
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCurrency(quarterly[k])}
              </td>
            </tr>
          ))}
          <tr className="bg-secondary/40">
            <td className="px-3 py-2 font-semibold">Total</td>
            <td
              className={`px-3 py-2 text-right font-mono tabular-nums font-semibold ${matches ? "" : "text-error"}`}
            >
              {formatCurrency(sum)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
