"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Landmark,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { cn, formatCurrency } from "@/lib/utils";
import {
  generateForm941,
  markFormFiled,
} from "@/lib/payroll/forms-actions";
import type {
  Form941Data,
  OrganizationConfig,
  PayrollForm,
} from "@/types/payroll";
import { formStatusLabel } from "@/lib/payroll/labels";
import { Term } from "./term";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  form: PayrollForm | null;
  formData: Form941Data | null;
  organization: OrganizationConfig | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Form941Content({
  year,
  quarter,
  form,
  formData,
  organization,
}: Props) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirmationDialog();
  const [submitting, setSubmitting] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [fileDialog, setFileDialog] = React.useState(false);
  const [confirmationNumber, setConfirmationNumber] = React.useState("");

  const isFiled = form?.status === "filed";
  const hasData = formData != null;
  const hasDraftEdits = form?.status === "draft";

  const handleGenerate = async () => {
    // Regenerating rebuilds form_data from the raw runs, which silently
    // overwrites any admin edits stored by saveForm941Draft. Confirm first
    // whenever the current record is in draft state (edited).
    if (hasDraftEdits) {
      const ok = await confirm({
        title: "Discard draft edits?",
        description:
          "Your saved edits on this Form 941 (Line 7 overrides, credits, etc.) will be replaced by freshly aggregated values from the pay runs. This cannot be undone.",
        confirmLabel: "Discard and regenerate",
        variant: "warning",
      });
      if (!ok) return;
    }

    setSubmitting(true);
    try {
      const res = await generateForm941({ tax_year: year, quarter });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to generate 941");
        return;
      }
      setWarnings(res.data?.warnings ?? []);
      toast("success", "Form 941 generated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkFiled = async () => {
    if (!form) return;
    setSubmitting(true);
    try {
      const res = await markFormFiled({
        form_id: form.id,
        confirmation_number: confirmationNumber.trim() || null,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to mark filed");
        return;
      }
      toast("success", "Form 941 marked as filed");
      setFileDialog(false);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <FileCheck2 className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold">Form 941 - Q{quarter} {year}</h1>
            <p className="text-sm text-muted-foreground">
              Employer's Quarterly Federal Tax Return
            </p>
          </div>
          <StatusBadge status={form?.status ?? null} />
        </div>
      </div>

      {/* Action bar */}
      <div className="glass-card rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <Button
          onClick={handleGenerate}
          disabled={submitting || isFiled}
          variant={hasData ? "outline" : "default"}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1" aria-hidden="true" />
          )}
          {hasData ? "Regenerate from runs" : "Generate Form 941"}
        </Button>

        {hasData && !isFiled && (
          <Button
            onClick={() => setFileDialog(true)}
            disabled={submitting}
          >
            <FileCheck2 className="h-4 w-4 mr-1" aria-hidden="true" />
            Mark filed
          </Button>
        )}

        {form?.generated_at && (
          <span className="text-xs text-muted-foreground ml-auto">
            Generated {new Date(form.generated_at).toLocaleString()}
          </span>
        )}
      </div>

      {/* Filed banner */}
      {isFiled && form && (
        <div
          role="status"
          className="rounded-xl border border-success/40 bg-success/10 p-4 flex items-start gap-3"
        >
          <CheckCircle2
            className="h-5 w-5 text-success flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex-1 text-sm">
            <div className="font-medium text-success">
              Filed {form.filed_at ? new Date(form.filed_at).toLocaleDateString() : ""}
            </div>
            {form.confirmation_number && (
              <div className="text-muted-foreground mt-0.5">
                Confirmation: {form.confirmation_number}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-2"
        >
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Review before filing
          </div>
          <ul className="text-sm text-foreground space-y-1 list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {!hasData ? (
        <div className="glass-card rounded-xl p-10 text-center text-sm text-muted-foreground space-y-2">
          <p>
            Form 941 has not been generated for Q{quarter} {year}.
          </p>
          <p>
            Click Generate to aggregate all approved runs in this quarter and
            produce a draft.
          </p>
        </div>
      ) : (
        <Form941Layout data={formData!} organization={organization} />
      )}

      <FileDialog
        open={fileDialog && !!form}
        confirmationNumber={confirmationNumber}
        onConfirmationNumberChange={setConfirmationNumber}
        onConfirm={handleMarkFiled}
        onCancel={() => {
          if (submitting) return;
          setFileDialog(false);
        }}
        submitting={submitting}
      />
      {confirmDialog}
    </div>
  );
}

// ─── Line layout ──────────────────────────────────────────────────────────────

function Form941Layout({
  data,
  organization,
}: {
  data: Form941Data;
  organization: OrganizationConfig | null;
}) {
  return (
    <div className="space-y-6">
      {/* Part 1 */}
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Part 1 - Quarterly taxes</SectionHeading>
        <LineRow
          number="1"
          label="Employees paid for pay period including last-month 12th"
          value={data.line_1_employees}
          format="integer"
        />
        <LineRow
          number="2"
          label="Wages, tips, and other compensation"
          value={data.line_2_wages}
        />
        <LineRow
          number="3"
          label="Federal income tax withheld"
          value={data.line_3_federal_income_tax}
        />

        <div className="border-t border-border my-2 pt-2">
          <LineRow
            number="5a"
            label="Taxable social security wages"
            value={data.line_5a_ss_wages}
            tax={data.line_5a_ss_tax}
            rate="0.124"
          />
          <LineRow
            number="5c"
            label="Taxable Medicare wages & tips"
            value={data.line_5c_medicare_wages}
            tax={data.line_5c_medicare_tax}
            rate="0.029"
          />
          {data.line_5d_additional_medicare_wages > 0 && (
            <LineRow
              number="5d"
              label="Taxable wages subject to Additional Medicare"
              value={data.line_5d_additional_medicare_wages}
              tax={data.line_5d_additional_medicare_tax}
              rate="0.009"
            />
          )}
          <LineRow
            number="5e"
            label="Total social security and Medicare taxes"
            value={data.line_5e_total_ss_medicare}
            emphasis
          />
        </div>

        <div className="border-t border-border my-2 pt-2">
          <LineRow
            number="6"
            label="Total taxes before adjustments (Line 3 + 5e)"
            value={data.line_6_total_taxes_before_adjustments}
            emphasis
          />
          <LineRow
            number="7"
            label="Current quarter's adjustment for fractions of cents"
            value={data.line_7_fractions_of_cents}
            signed
          />
          <LineRow
            number="10"
            label="Total taxes after adjustments"
            value={data.line_10_total_taxes_after_adjustments}
            emphasis
          />
          <LineRow
            number="12"
            label="Total taxes after adjustments and nonrefundable credits"
            value={data.line_12_total_taxes}
            emphasis
          />
        </div>

        <div className="border-t border-border my-2 pt-2">
          <LineRow
            number="13a"
            label="Total deposits for this quarter"
            value={data.line_13a_total_deposits}
          />
          {data.line_14_balance_due > 0 && (
            <LineRow
              number="14"
              label="Balance due (Line 12 - Line 13a)"
              value={data.line_14_balance_due}
              tone="error"
              emphasis
            />
          )}
          {data.line_15_overpayment > 0 && (
            <LineRow
              number="15"
              label="Overpayment (Line 13a - Line 12)"
              value={data.line_15_overpayment}
              tone="success"
              emphasis
            />
          )}
        </div>
      </section>

      {/* Part 2 */}
      <section className="glass-card rounded-xl p-5 space-y-3">
        <SectionHeading>Part 2 - Deposit schedule</SectionHeading>
        <p className="text-xs text-muted-foreground">
          {data.deposit_schedule === "monthly"
            ? "Line 16 Box B - Monthly schedule depositor"
            : "Line 16 Box C - Semiweekly schedule depositor, Schedule B attached"}
          {organization ? null : null}
        </p>
        {data.deposit_schedule === "monthly" && data.monthly_liability && (
          <MonthlyLiabilityTable
            monthly={data.monthly_liability}
            line12={data.line_12_total_taxes}
            year={data.tax_year}
            quarter={data.quarter}
          />
        )}
        {data.deposit_schedule === "semiweekly" && data.schedule_b && (
          <ScheduleBTable entries={data.schedule_b} />
        )}
      </section>

      {/* Deposit reconciliation hint */}
      <section className="glass-card rounded-xl p-5 space-y-2">
        <SectionHeading>Deposit reconciliation</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Line 13a reflects federal 941 deposits for this quarter that are
          marked as paid in the{" "}
          <Link
            href="/payroll/deposits"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            <Landmark className="h-3 w-3" aria-hidden="true" />
            deposits ledger
          </Link>
          . Scheduled-but-unpaid deposits do not count here, so if Line 14
          shows a balance due, confirm any recent EFTPS payments are logged.
        </p>
      </section>
    </div>
  );
}

// ─── Line row ─────────────────────────────────────────────────────────────────

function LineRow({
  number,
  label,
  value,
  tax,
  rate,
  format = "currency",
  tone,
  emphasis,
  signed,
}: {
  number: string;
  label: string;
  value: number;
  /** Second column when showing wages × rate. */
  tax?: number;
  /** Multiplier label displayed between wages and tax. */
  rate?: string;
  format?: "currency" | "integer";
  tone?: "error" | "success";
  emphasis?: boolean;
  signed?: boolean;
}) {
  const valueDisplay =
    format === "integer"
      ? String(Math.round(value))
      : signed
        ? formatSigned(value)
        : formatCurrency(value);
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-1.5 text-sm",
        emphasis && "font-semibold",
      )}
    >
      <span className="w-10 flex-shrink-0 text-xs font-mono text-muted-foreground">
        {number}
      </span>
      <span className="flex-1 text-foreground">{label}</span>
      <span
        className={cn(
          "text-right font-mono tabular-nums",
          tone === "error" && "text-error",
          tone === "success" && "text-success",
        )}
      >
        {valueDisplay}
      </span>
      {rate && (
        <span className="text-xs text-muted-foreground font-mono w-16 text-right">
          × {rate}
        </span>
      )}
      {tax != null && (
        <span
          className={cn(
            "text-right font-mono tabular-nums w-28",
            emphasis && "font-semibold",
          )}
        >
          {formatCurrency(tax)}
        </span>
      )}
    </div>
  );
}

function formatSigned(value: number): string {
  if (value >= 0) return formatCurrency(value);
  return `(${formatCurrency(Math.abs(value))})`;
}

// ─── Part 2 tables ────────────────────────────────────────────────────────────

function MonthlyLiabilityTable({
  monthly,
  line12,
  year,
  quarter,
}: {
  monthly: { month1: number; month2: number; month3: number };
  line12: number;
  year: number;
  quarter: number;
}) {
  const startMonth = (quarter - 1) * 3;
  const months = [0, 1, 2].map((i) => monthName(year, startMonth + i));
  const sum =
    Math.round((monthly.month1 + monthly.month2 + monthly.month3) * 100) / 100;
  const matches = Math.abs(sum - line12) < 0.005;
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
            <td className="px-3 py-2 font-semibold">Total (must equal Line 12)</td>
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

function ScheduleBTable({
  entries,
}: {
  entries: Array<{ date: string; amount: number }>;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No 941 liability days in this quarter.
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

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string | null }) {
  if (status === "filed") {
    return (
      <span className="inline-flex items-center rounded-md bg-success/10 text-success px-2 py-1 text-xs font-medium">
        {formStatusLabel("filed")}
      </span>
    );
  }
  if (status === "generated") {
    return (
      <span className="inline-flex items-center rounded-md bg-primary/10 text-primary px-2 py-1 text-xs font-medium">
        {formStatusLabel("generated")}
      </span>
    );
  }
  if (status === "draft") {
    return (
      <span className="inline-flex items-center rounded-md bg-warning/10 text-warning px-2 py-1 text-xs font-medium">
        Edited draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-secondary text-muted-foreground px-2 py-1 text-xs font-medium">
      Not started
    </span>
  );
}

// ─── Section heading ──────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

// ─── File dialog ──────────────────────────────────────────────────────────────

function FileDialog({
  open,
  confirmationNumber,
  onConfirmationNumberChange,
  onConfirm,
  onCancel,
  submitting,
}: {
  open: boolean;
  confirmationNumber: string;
  onConfirmationNumberChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="space-y-4">
        <DialogTitle>Mark Form 941 as filed</DialogTitle>
        <DialogDescription>
          Record that you have filed this return with the IRS. Once marked
          filed, the form becomes read-only and regeneration is disabled.
        </DialogDescription>
        <Input
          label="IRS confirmation / submission ID (optional)"
          value={confirmationNumber}
          onChange={(e) => onConfirmationNumberChange(e.target.value)}
          placeholder="e.g., EFTPS confirmation or e-file submission ID"
        />
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={submitting}>
            {submitting && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
            )}
            Mark filed
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
