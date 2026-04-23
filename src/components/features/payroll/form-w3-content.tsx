"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { generateFormW3 } from "@/lib/payroll/forms-actions";
import {
  FormViewerShell,
  LineRow,
  SectionHeading,
} from "./form-viewer-shell";
import type { FormW3Data, PayrollForm } from "@/types/payroll";
import { Term } from "./term";

interface Props {
  year: number;
  form: PayrollForm | null;
  formData: FormW3Data | null;
  /** Number of W-2 forms that exist in payroll_forms for this year. */
  w2Count: number;
}

export function FormW3Content({ year, form, formData, w2Count }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const handleGenerate = async () => {
    setSubmitting(true);
    try {
      const res = await generateFormW3({ tax_year: year });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to generate W-3");
        return;
      }
      setWarnings(res.data?.warnings ?? []);
      toast("success", "Form W-3 generated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FormViewerShell
      icon={FileText}
      title={`Form W-3 - ${year}`}
      subtitle={
        <>
          <Term slug="w3">W-3</Term>: Annual transmittal summary filed with the
          batch of <Term slug="w2">W-2</Term>s.
        </>
      }
      form={form}
      hasData={formData != null}
      onGenerate={handleGenerate}
      submitting={submitting}
      warnings={warnings}
      emptyStateHint={
        w2Count === 0
          ? `No W-2 forms exist for ${year} yet. Generate individual W-2s first, then roll up the W-3.`
          : `Form W-3 has not been generated for ${year}.`
      }
      discardEditsDescription="Your saved edits on this W-3 will be replaced by a fresh rollup of all W-2s for the year."
    >
      {formData && <FormW3Layout data={formData} year={year} />}
    </FormViewerShell>
  );
}

function FormW3Layout({ data, year }: { data: FormW3Data; year: number }) {
  return (
    <div className="space-y-6">
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Transmittal</SectionHeading>
        <LineRow
          number="c"
          label="Number of W-2s"
          value={data.w2_count}
          format="integer"
          emphasis
        />
      </section>

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Federal totals</SectionHeading>
        <LineRow number="1" label="Wages, tips, other compensation" value={data.box_1_wages} emphasis />
        <LineRow
          number="2"
          label="Federal income tax withheld"
          value={data.box_2_federal_income_tax}
        />
        <LineRow number="3" label="Social Security wages" value={data.box_3_ss_wages} />
        <LineRow number="4" label="Social Security tax withheld" value={data.box_4_ss_tax} />
        <LineRow number="5" label="Medicare wages and tips" value={data.box_5_medicare_wages} />
        <LineRow number="6" label="Medicare tax withheld" value={data.box_6_medicare_tax} />
      </section>

      {data.box_12_d_elective_deferrals > 0 && (
        <section className="glass-card rounded-xl p-5 space-y-2">
          <SectionHeading>Deferrals</SectionHeading>
          <LineRow
            number="12a"
            label="Box 12 code D - 401(k) elective deferrals"
            value={data.box_12_d_elective_deferrals}
          />
        </section>
      )}

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>State totals</SectionHeading>
        <LineRow number="16" label="State wages" value={data.box_16_state_wages} />
        <LineRow number="17" label="State income tax" value={data.box_17_state_income_tax} />
        {data.states && data.states.length > 1 && (
          <div className="mt-2 pt-2 border-t border-border">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Per state
            </p>
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">State</th>
                    <th className="text-right px-3 py-2 font-medium">
                      Box 16 wages
                    </th>
                    <th className="text-right px-3 py-2 font-medium">
                      Box 17 tax
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.states.map((s) => (
                    <tr key={s.code} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-muted-foreground">
                        {s.code}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatCurrency(s.wages)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatCurrency(s.tax)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Rollup source</SectionHeading>
        <p className="text-sm text-muted-foreground">
          This W-3 sums the{" "}
          <Link
            href={`/payroll/forms/w2/${year}`}
            className="text-primary hover:underline"
          >
            {data.w2_count} W-2 form{data.w2_count === 1 ? "" : "s"}
          </Link>{" "}
          stored for {year}. Regenerating the W-3 re-reads the stored W-2s
          including any manual box overrides.
        </p>
      </section>
    </div>
  );
}
