"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { generateFormW2 } from "@/lib/payroll/forms-actions";
import {
  FormViewerShell,
  LineRow,
  SectionHeading,
} from "./form-viewer-shell";
import type {
  FormW2Data,
  PayrollEmployee,
  PayrollForm,
} from "@/types/payroll";
import { Term } from "./term";

interface Props {
  year: number;
  employeeId: string;
  employee: Pick<
    PayrollEmployee,
    "id" | "first_name" | "last_name" | "state_code"
  >;
  form: PayrollForm | null;
  formData: FormW2Data | null;
}

export function FormW2Content({
  year,
  employeeId,
  employee,
  form,
  formData,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);

  const handleGenerate = async () => {
    setSubmitting(true);
    try {
      const res = await generateFormW2({
        tax_year: year,
        employee_id: employeeId,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to generate W-2");
        return;
      }
      setWarnings(res.data?.warnings ?? []);
      toast("success", "Form W-2 generated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const fullName = `${employee.first_name} ${employee.last_name}`.trim();

  return (
    <FormViewerShell
      icon={FileText}
      title={`W-2 - ${fullName} - ${year}`}
      subtitle={
        <>
          <Term slug="w2">W-2</Term>: Employee wage and tax statement filed with
          the SSA.
        </>
      }
      form={form}
      hasData={formData != null}
      onGenerate={handleGenerate}
      submitting={submitting}
      warnings={warnings}
      emptyStateHint={`W-2 has not been generated for ${fullName} in ${year}.`}
      discardEditsDescription="Your saved edits on this W-2 will be replaced by freshly aggregated values from the pay runs."
    >
      {formData && <FormW2Layout data={formData} />}
    </FormViewerShell>
  );
}

function FormW2Layout({ data }: { data: FormW2Data }) {
  return (
    <div className="space-y-6">
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Federal</SectionHeading>
        <LineRow number="1" label="Wages, tips, other compensation" value={data.box_1_wages} emphasis />
        <LineRow
          number="2"
          label="Federal income tax withheld"
          value={data.box_2_federal_income_tax}
        />
        <div className="border-t border-border my-2 pt-2">
          <LineRow number="3" label="Social Security wages" value={data.box_3_ss_wages} />
          <LineRow number="4" label="Social Security tax withheld" value={data.box_4_ss_tax} />
          <LineRow number="5" label="Medicare wages and tips" value={data.box_5_medicare_wages} />
          <LineRow number="6" label="Medicare tax withheld" value={data.box_6_medicare_tax} />
        </div>
      </section>

      {(data.box_12?.length || data.box_14_section_125) && (
        <section className="glass-card rounded-xl p-5 space-y-2">
          <SectionHeading>Supplemental</SectionHeading>
          {data.box_12 && data.box_12.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Box 12 code</th>
                    <th className="text-right px-3 py-2 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.box_12.map((c, i) => (
                    <tr key={`${c.code}-${i}`} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-muted-foreground">
                        {c.code} {box12Label(c.code)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatCurrency(c.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.box_14_section_125 != null && data.box_14_section_125 > 0 && (
            <LineRow
              number="14"
              label="Section 125 cafeteria plan (informational)"
              value={data.box_14_section_125}
            />
          )}
        </section>
      )}

      {(() => {
        // states[] was added alongside multi-state Box 16 support; historical
        // W-2 rows stored before that change don't include it, so fall back to
        // a synthesized single-state from the flat box_15/16/17 fields.
        const states =
          data.states && data.states.length > 0
            ? data.states
            : [
                {
                  code: data.box_15_state,
                  wages: data.box_16_state_wages,
                  tax: data.box_17_state_income_tax,
                },
              ];
        if (states.length > 1) {
          return states.map((s) => (
            <section
              key={s.code}
              className="glass-card rounded-xl p-5 space-y-2"
            >
              <SectionHeading>State ({s.code})</SectionHeading>
              <LineRow number="16" label="State wages" value={s.wages} />
              <LineRow number="17" label="State income tax" value={s.tax} />
            </section>
          ));
        }
        const only = states[0];
        return (
          <section className="glass-card rounded-xl p-5 space-y-2">
            <SectionHeading>State ({only.code})</SectionHeading>
            <LineRow number="16" label="State wages" value={only.wages} />
            <LineRow number="17" label="State income tax" value={only.tax} />
          </section>
        );
      })()}
    </div>
  );
}

function box12Label(code: string): string {
  switch (code) {
    case "D":
      return "(401(k) elective deferrals)";
    case "DD":
      return "(employer-sponsored health coverage)";
    case "E":
      return "(403(b) elective deferrals)";
    case "W":
      return "(HSA employer + employee)";
    default:
      return "";
  }
}
