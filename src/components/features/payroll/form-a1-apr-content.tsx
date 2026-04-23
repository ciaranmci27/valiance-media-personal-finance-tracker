"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCheck2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { generateFormA1Apr } from "@/lib/payroll/forms-actions";
import {
  FormViewerShell,
  LineRow,
  SectionHeading,
} from "./form-viewer-shell";
import type { FormA1AprData, PayrollForm } from "@/types/payroll";
import { Term } from "./term";

interface Props {
  year: number;
  form: PayrollForm | null;
  formData: FormA1AprData | null;
  quarterCount: number;
  w3Exists: boolean;
}

export function FormA1AprContent({
  year,
  form,
  formData,
  quarterCount,
  w3Exists,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const handleGenerate = async () => {
    setSubmitting(true);
    try {
      const res = await generateFormA1Apr({ tax_year: year });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to generate A1-APR");
        return;
      }
      setWarnings(res.data?.warnings ?? []);
      toast("success", "AZ Form A1-APR generated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const prereqWarnings = [
    ...(quarterCount < 4
      ? [
          `Only ${quarterCount} of 4 A1-QRT returns generated for ${year}. Generate each quarter's A1-QRT first so the reconciliation has complete data.`,
        ]
      : []),
    ...(!w3Exists
      ? [
          `W-3 for ${year} has not been generated. The APR uses W-2 Box 17 totals (via W-3) as the ground-truth withholding.`,
        ]
      : []),
  ];

  const emptyStateHint =
    prereqWarnings.length > 0
      ? "The A1-APR reconciles the four quarterly A1-QRT returns against the annual W-2 totals. Generate prerequisites first (see warnings above)."
      : `AZ Form A1-APR has not been generated for ${year}.`;

  return (
    <FormViewerShell
      icon={FileCheck2}
      title={`AZ A1-APR - ${year}`}
      subtitle={
        <>
          <Term slug="a1_apr">Arizona A-1-APR</Term>: Annual reconciliation of
          state withholding.
        </>
      }
      form={form}
      hasData={formData != null}
      onGenerate={handleGenerate}
      submitting={submitting}
      warnings={[...prereqWarnings, ...warnings]}
      emptyStateHint={emptyStateHint}
      discardEditsDescription="Your saved edits on this A1-APR will be replaced by a fresh reconciliation of the quarterly returns and W-3."
    >
      {formData && <FormA1AprLayout data={formData} year={year} />}
    </FormViewerShell>
  );
}

function FormA1AprLayout({ data, year }: { data: FormA1AprData; year: number }) {
  return (
    <div className="space-y-6">
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Annual reconciliation</SectionHeading>
        <LineRow
          number=""
          label="Total Arizona wages"
          value={data.total_az_wages}
        />
        <LineRow
          number=""
          label="Total Arizona tax withheld (W-2 Box 17)"
          value={data.total_az_withheld}
          emphasis
        />
        <LineRow
          number=""
          label="Sum of A1-QRT Line A (reported)"
          value={data.a1_qrt_line_a_sum}
        />
        <LineRow
          number=""
          label="Sum of A1-QRT Line B (deposited)"
          value={data.a1_qrt_line_b_sum}
        />
        <div className="border-t border-border my-2 pt-2">
          <LineRow
            number=""
            label="Reconciliation adjustment (W-2 total - Line A sum)"
            value={data.adjustment}
            signed
            tone={
              Math.abs(data.adjustment) > 0.5
                ? "error"
                : data.adjustment === 0
                  ? undefined
                  : "success"
            }
            emphasis
          />
        </div>
      </section>

      <section className="glass-card rounded-xl p-5 space-y-3">
        <SectionHeading>Quarterly breakdown</SectionHeading>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Quarter</th>
                <th className="text-right px-3 py-2 font-medium">AZ wages</th>
                <th className="text-right px-3 py-2 font-medium">Line A</th>
                <th className="text-right px-3 py-2 font-medium">Line B</th>
              </tr>
            </thead>
            <tbody>
              {(["q1", "q2", "q3", "q4"] as const).map((k, i) => {
                const q = data.quarterly[k];
                return (
                  <tr key={k} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link
                        href={`/payroll/forms/a1-qrt/${year}/${i + 1}`}
                        className="text-primary hover:underline"
                      >
                        Q{i + 1}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatCurrency(q.wages)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatCurrency(q.reported)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatCurrency(q.deposited)}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-secondary/40 border-t border-border">
                <td className="px-3 py-2 font-semibold">Total</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                  {formatCurrency(data.total_az_wages)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                  {formatCurrency(data.a1_qrt_line_a_sum)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                  {formatCurrency(data.a1_qrt_line_b_sum)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Transmittal</SectionHeading>
        <LineRow
          number=""
          label="W-2 forms attached"
          value={data.w2_count}
          format="integer"
        />
        <LineRow
          number=""
          label="Distinct employees paid in year"
          value={data.total_employees}
          format="integer"
        />
      </section>
    </div>
  );
}
