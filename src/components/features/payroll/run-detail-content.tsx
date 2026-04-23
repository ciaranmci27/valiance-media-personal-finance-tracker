"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  CheckCircle2,
  Circle,
  CircleDashed,
  FileCheck2,
  Landmark,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/select";
import { MaskedValue } from "@/components/ui/masked-value";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  deleteDraftRun,
  finalizeRun,
  markRunPaid,
  recalculateDraftRun,
  voidRun,
} from "@/lib/payroll/runs-actions";
import { sendPayStub } from "@/lib/payroll/paystub-actions";
import type { YtdTotals } from "@/lib/payroll/engine";
import {
  DEPOSIT_TYPE_LABELS,
  PAY_FREQUENCY_LABELS,
  RUN_TYPE_LABELS,
} from "@/types/payroll";
import { runStatusLabel, runStatusHelp } from "@/lib/payroll/labels";
import { Term } from "./term";
import type {
  PayrollEmployee,
  PayrollRun,
  PayrollRunEventType,
  PayrollRunHistory,
  PayrollTaxDeposit,
  WithholdingLineItem,
} from "@/types/payroll";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  run: PayrollRun;
  employee: PayrollEmployee | null;
  history: PayrollRunHistory[];
  ytdBefore: YtdTotals;
  ytdIncluding: YtdTotals;
  /** Tax deposits this run contributes to (federal 941, state withholding,
   *  FUTA, SUTA). Populated post-finalize; empty for drafts. */
  deposits: PayrollTaxDeposit[];
  /** Every non-deleted run sharing this run's pay_date. Lets the What's-next
   *  panel reflect cycle-level progress for multi-employee cycles instead of
   *  only this run's state. Always includes this run. */
  cycleRuns: PayrollRun[];
}

type OpenDialog =
  | "finalize"
  | "markPaid"
  | "void"
  | "voidAcknowledge"
  | "delete"
  | null;

// ─── Component ────────────────────────────────────────────────────────────────

export function RunDetailContent({
  run,
  employee,
  history,
  ytdBefore,
  ytdIncluding,
  deposits,
  cycleRuns,
}: Props) {
  const router = useRouter();

  const [dialog, setDialog] = React.useState<OpenDialog>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [paymentMethod, setPaymentMethod] = React.useState("ACH");
  const [paymentReference, setPaymentReference] = React.useState("");
  const [voidReason, setVoidReason] = React.useState("");
  const [voidDownstreamCount, setVoidDownstreamCount] = React.useState<number | null>(null);

  const closeDialog = () => {
    if (submitting) return;
    setDialog(null);
  };

  const handleFinalize = async () => {
    setSubmitting(true);
    try {
      const res = await finalizeRun(run.id);
      if (!res.ok) {
        toast("error", res.error ?? "Failed to approve");
        return;
      }
      if (res.warning) {
        // Approval committed but deposit creation failed. Warn rather than
        // error so the admin sees exactly what went wrong instead of a
        // silent empty deposits page.
        toast("warning", res.warning);
      } else {
        toast("success", "Run approved");
      }
      router.refresh();
    } finally {
      setSubmitting(false);
      setDialog(null);
    }
  };

  const handleMarkPaid = async () => {
    setSubmitting(true);
    try {
      const res = await markRunPaid({
        run_id: run.id,
        payment_method: paymentMethod.trim() || null,
        payment_reference: paymentReference.trim() || null,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to mark paid");
        return;
      }
      toast("success", "Marked as paid");
      router.refresh();
    } finally {
      setSubmitting(false);
      setDialog(null);
    }
  };

  const handleVoid = async () => {
    if (!voidReason.trim()) {
      toast("error", "A reason is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await voidRun({
        run_id: run.id,
        reason: voidReason.trim(),
      });
      if (!res.ok) {
        // Server refuses when later finalized/paid runs exist; it returns the
        // downstream count so we can confirm explicitly instead of blocking.
        if (res.data?.count && res.data.count > 0) {
          setVoidDownstreamCount(res.data.count);
          setDialog("voidAcknowledge");
          return;
        }
        toast("error", res.error ?? "Failed to void");
        setDialog(null);
        return;
      }
      toast("success", "Run voided");
      setVoidDownstreamCount(null);
      router.refresh();
      setDialog(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleVoidAcknowledge = async () => {
    setSubmitting(true);
    try {
      const res = await voidRun({
        run_id: run.id,
        reason: voidReason.trim(),
        acknowledge_downstream: true,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to void");
        setVoidDownstreamCount(null);
        setDialog(null);
        return;
      }
      toast("success", "Run voided");
      setVoidDownstreamCount(null);
      router.refresh();
      setDialog(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRecalculate = async () => {
    setSubmitting(true);
    try {
      const res = await recalculateDraftRun({ run_id: run.id });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to recalculate");
        return;
      }
      toast("success", "Draft recalculated");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendStub = async () => {
    setSubmitting(true);
    try {
      const res = await sendPayStub(run.id);
      if (!res.ok) {
        toast("error", res.error ?? "Failed to send pay stub");
        return;
      }
      toast("success", "Pay stub emailed");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setSubmitting(true);
    try {
      const res = await deleteDraftRun(run.id);
      if (!res.ok) {
        toast("error", res.error ?? "Failed to delete");
        return;
      }
      toast("success", "Draft deleted");
      router.push("/payroll/runs");
    } finally {
      setSubmitting(false);
      setDialog(null);
    }
  };

  const otherWithholdings = Array.isArray(run.other_withholdings)
    ? (run.other_withholdings as WithholdingLineItem[])
    : [];

  const employeeTaxTotal =
    Number(run.federal_income_tax || 0) +
    Number(run.state_income_tax || 0) +
    Number(run.social_security_employee || 0) +
    Number(run.medicare_employee || 0) +
    Number(run.additional_medicare || 0) +
    Number(run.state_disability_employee || 0);

  const employerCost =
    Number(run.gross_pay || 0) +
    Number(run.social_security_employer || 0) +
    Number(run.medicare_employer || 0) +
    Number(run.futa || 0) +
    Number(run.suta || 0) +
    Number(run.state_disability_employer || 0);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              {employee
                ? `${employee.first_name} ${employee.last_name}`
                : "Pay Run"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {RUN_TYPE_LABELS[run.run_type]} - period {run.period_start} to{" "}
              {run.period_end} - pays {run.pay_date}
            </p>
          </div>
        </div>
        <StatusPill status={run.status} />
      </div>

      {/* Action bar */}
      <div className="glass-card rounded-xl p-3 flex items-center gap-2 flex-wrap">
        {run.status === "draft" && (
          <>
            <Button onClick={() => setDialog("finalize")} disabled={submitting}>
              <FileCheck2 className="h-4 w-4 mr-1" aria-hidden="true" />
              Approve
            </Button>
            <Button
              variant="outline"
              onClick={handleRecalculate}
              disabled={submitting}
              title="Refresh taxes using the latest tax configs and employee W-4"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1" aria-hidden="true" />
              )}
              Recalculate
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog("delete")}
              disabled={submitting}
            >
              <Trash2 className="h-4 w-4 mr-1" aria-hidden="true" />
              Delete draft
            </Button>
          </>
        )}
        {run.status === "finalized" && (
          <>
            <Button onClick={() => setDialog("markPaid")} disabled={submitting}>
              <CheckCircle2 className="h-4 w-4 mr-1" aria-hidden="true" />
              Mark as paid
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog("void")}
              disabled={submitting}
            >
              <XCircle className="h-4 w-4 mr-1" aria-hidden="true" />
              Void
            </Button>
          </>
        )}
        {run.status === "paid" && (
          <>
            <Button
              variant="outline"
              onClick={handleSendStub}
              disabled={submitting}
              title={
                run.stub_sent_at
                  ? `Stub last emailed ${formatTime(run.stub_sent_at)}`
                  : "The employee has not received a pay stub for this run"
              }
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <Mail className="h-4 w-4 mr-1" aria-hidden="true" />
              )}
              {run.stub_sent_at ? "Resend pay stub" : "Send pay stub"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog("void")}
              disabled={submitting}
            >
              <XCircle className="h-4 w-4 mr-1" aria-hidden="true" />
              Void
            </Button>
          </>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          Created {formatTime(run.created_at)}
          {run.finalized_at ? ` - approved ${formatTime(run.finalized_at)}` : ""}
          {run.paid_at ? ` - paid ${formatTime(run.paid_at)}` : ""}
          {run.status === "paid" && !run.stub_sent_at
            ? " - stub not yet delivered"
            : ""}
        </span>
      </div>

      {/* What's next: guides the admin through sending wages, marking paid,
          and paying tax deposits. Quarterly/annual form filing lives on the
          Forms page since the cadence is different. Only relevant once the
          run leaves draft and hasn't been voided. */}
      {(run.status === "finalized" || run.status === "paid") && (
        <WhatsNextPanel
          run={run}
          cycleRuns={cycleRuns}
          deposits={deposits}
          stubBusy={submitting}
          onSendStub={handleSendStub}
        />
      )}

      {/* YTD staleness warning: an upstream run was voided after this run
          was approved, so stored FICA caps, Additional Medicare, FUTA cap, and
          supplemental values were computed against wages that no longer apply. */}
      {run.ytd_stale && run.status !== "voided" && (
        <div
          role="alert"
          className="glass-card rounded-xl p-4 border-warning/30 bg-warning/5"
        >
          <p className="flex items-start gap-2 text-sm text-foreground">
            <TriangleAlert
              className="h-4 w-4 shrink-0 mt-0.5 text-warning"
              aria-hidden="true"
            />
            <span>
              <span className="font-medium">YTD values on this run are stale.</span>
              {run.ytd_stale_reason && (
                <span className="block mt-1 text-xs text-muted-foreground">
                  {run.ytd_stale_reason}
                </span>
              )}
              <span className="block mt-1 text-xs text-muted-foreground">
                FICA cap, Additional Medicare threshold, FUTA cap, and
                supplemental wage calculations were frozen when this run was
                approved. Review and, if needed, void and re-run or file a
                correction.
              </span>
            </span>
          </p>
        </div>
      )}

      {/* Headline numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <HeadlineBox label="Gross" amount={Number(run.gross_pay || 0)} />
        <HeadlineBox label="Employee taxes" amount={employeeTaxTotal} />
        <HeadlineBox label="Net" amount={Number(run.net_pay || 0)} emphasis />
        <HeadlineBox label="Total employer cost" amount={employerCost} />
      </div>

      {/* Employee withholdings */}
      <Section title="Employee withholdings">
        <LineRow
          label={<Term slug="fit">Federal income tax</Term>}
          amount={Number(run.federal_income_tax || 0)}
        />
        <LineRow
          label={<Term slug="sit">State income tax</Term>}
          amount={Number(run.state_income_tax || 0)}
        />
        <LineRow
          label={
            <>
              <Term slug="fica">Social Security</Term> (employee)
            </>
          }
          amount={Number(run.social_security_employee || 0)}
        />
        <LineRow
          label={
            <>
              <Term slug="fica">Medicare</Term> (employee)
            </>
          }
          amount={Number(run.medicare_employee || 0)}
        />
        {Number(run.additional_medicare || 0) > 0 && (
          <LineRow
            label="Additional Medicare (0.9%)"
            amount={Number(run.additional_medicare || 0)}
          />
        )}
        {Number(run.state_disability_employee || 0) > 0 && (
          <LineRow
            label={
              <>
                <Term slug="sdi">State disability</Term> (employee)
              </>
            }
            amount={Number(run.state_disability_employee || 0)}
          />
        )}
        {otherWithholdings.map((item) => {
          const category = item.category ?? "post_tax";
          const suffix =
            category === "pre_tax_401k"
              ? "pre-tax 401(k)"
              : category === "pre_tax_125"
                ? "pre-tax §125"
                : "post-tax";
          return (
            <LineRow
              key={item.id}
              label={`${item.label} (${suffix})`}
              amount={Number(item.amount || 0)}
            />
          );
        })}
        <LineRow
          label="Total"
          amount={
            employeeTaxTotal +
            otherWithholdings.reduce(
              (sum, i) => sum + Number(i.amount || 0),
              0,
            )
          }
          bold
        />
      </Section>

      {/* Employer taxes */}
      <Section title="Employer taxes">
        <LineRow
          label={
            <>
              <Term slug="fica">Social Security</Term> (employer)
            </>
          }
          amount={Number(run.social_security_employer || 0)}
        />
        <LineRow
          label={
            <>
              <Term slug="fica">Medicare</Term> (employer)
            </>
          }
          amount={Number(run.medicare_employer || 0)}
        />
        <LineRow label={<Term slug="futa">FUTA</Term>} amount={Number(run.futa || 0)} />
        <LineRow label={<Term slug="suta">SUTA</Term>} amount={Number(run.suta || 0)} />
        {Number(run.state_disability_employer || 0) > 0 && (
          <LineRow
            label={
              <>
                <Term slug="sdi">State disability</Term> (employer)
              </>
            }
            amount={Number(run.state_disability_employer || 0)}
          />
        )}
      </Section>

      {/* YTD context */}
      <Section
        title={
          <>
            <Term slug="ytd">YTD</Term> context ({taxYearOf(run.pay_date)})
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <YtdColumn title="Before this run" totals={ytdBefore} />
          {run.status === "voided" ? (
            <YtdColumn
              title="Not counted (voided)"
              totals={ytdBefore}
              note="Voided runs are excluded from YTD totals, FICA caps, FUTA caps, and Additional Medicare thresholds."
            />
          ) : (
            <YtdColumn
              title={
                run.status === "finalized" || run.status === "paid"
                  ? "Including this run"
                  : "If this run is approved"
              }
              totals={ytdIncluding.runCount > 0 ? ytdIncluding : ytdBefore}
              projected={
                run.status !== "finalized" && run.status !== "paid"
                  ? ytdBefore
                  : undefined
              }
              runValues={
                run.status !== "finalized" && run.status !== "paid"
                  ? runAsYtdPatch(run)
                  : undefined
              }
            />
          )}
        </div>
      </Section>

      {/* Snapshots */}
      {(run.status === "finalized" || run.status === "paid" || run.status === "voided") && (
        <Section title="Snapshot">
          <p className="text-xs text-muted-foreground">
            This run captures frozen copies of the employee record and tax
            configs at the time of approval. Future config changes will not
            affect these numbers.
          </p>
          {employee && (
            <p className="text-xs text-muted-foreground">
              Filed under {PAY_FREQUENCY_LABELS[employee.pay_frequency]}{" "}
              schedule - {employee.state_code} state.
            </p>
          )}
          {run.void_reason && (
            <p className="text-xs text-error">
              Voided: {run.void_reason}
            </p>
          )}
          {run.payment_method || run.payment_reference ? (
            <p className="text-xs text-muted-foreground">
              Payment:{" "}
              {run.payment_method ?? "-"}
              {run.payment_reference ? ` (ref ${run.payment_reference})` : ""}
            </p>
          ) : null}
        </Section>
      )}

      {/* History */}
      <Section title="History">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">No history recorded.</p>
        ) : (
          <div className="space-y-2">
            {history.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between gap-3 flex-wrap text-sm"
              >
                <div className="flex items-center gap-2">
                  <HistoryIcon type={h.event_type} />
                  <span className="font-medium text-foreground">
                    {humanizeEvent(h.event_type)}
                  </span>
                  {h.notes && (
                    <span className="text-muted-foreground">- {h.notes}</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatTime(h.changed_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Dialogs */}
      <ConfirmationDialog
        open={dialog === "finalize"}
        onOpenChange={(o) => !o && closeDialog()}
        title="Approve this run?"
        description={<ApproveDialogBody />}
        confirmLabel="Approve"
        onConfirm={handleFinalize}
      />

      <ConfirmationDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && closeDialog()}
        title="Delete this draft?"
        description="Deleting removes the draft. Use Void instead for approved runs."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />

      <SimpleModal
        open={dialog === "markPaid"}
        title="Mark as paid"
        description="Record the payment method and reference. This captures the pay event in history."
        confirmLabel="Mark paid"
        onCancel={closeDialog}
        onConfirm={handleMarkPaid}
        submitting={submitting}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Payment method
            </label>
            <CustomSelect
              value={paymentMethod}
              onChange={setPaymentMethod}
              options={[
                { value: "ACH", label: "ACH" },
                { value: "Check", label: "Check" },
                { value: "Wire", label: "Wire" },
                { value: "Cash", label: "Cash" },
                { value: "Other", label: "Other" },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Reference (optional)
            </label>
            <Input
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
              placeholder="Check # or transaction id"
            />
          </div>
        </div>
      </SimpleModal>

      <SimpleModal
        open={dialog === "void"}
        title="Void this run?"
        description="Voiding keeps the record for audit but removes it from YTD totals. Provide a reason."
        confirmLabel="Void"
        variant="danger"
        onCancel={closeDialog}
        onConfirm={handleVoid}
        submitting={submitting}
      >
        <Textarea
          value={voidReason}
          onChange={(e) => setVoidReason(e.target.value)}
          placeholder="Reason (e.g. paid by mistake, corrected by replacement run)"
          className="min-h-[90px]"
        />
      </SimpleModal>

      <SimpleModal
        open={dialog === "voidAcknowledge"}
        title="Later runs depend on this one"
        description={
          voidDownstreamCount
            ? `${voidDownstreamCount} later finalized or paid run${voidDownstreamCount === 1 ? "" : "s"} used this run's gross pay when computing their YTD totals. Voiding now leaves those YTD numbers stale (FICA caps, Additional Medicare, FUTA wage base, supplemental thresholds) and you will likely need to file amended returns. Continue only if you understand the impact.`
            : undefined
        }
        confirmLabel="Void anyway"
        variant="danger"
        onCancel={() => {
          if (submitting) return;
          setVoidDownstreamCount(null);
          setDialog(null);
        }}
        onConfirm={handleVoidAcknowledge}
        submitting={submitting}
      >
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Reason:{" "}
          <span className="text-foreground">{voidReason.trim() || "(none provided)"}</span>
        </div>
      </SimpleModal>
    </div>
  );
}

// ─── Small sub-components ─────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="glass-card rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      </div>
      <div className="border-t border-border pt-3 space-y-2">{children}</div>
    </div>
  );
}

function LineRow({
  label,
  amount,
  bold,
}: {
  label: React.ReactNode;
  amount: number;
  bold?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between text-sm", bold && "font-semibold")}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">
        <MaskedValue value={formatCurrency(amount)} />
      </span>
    </div>
  );
}

function HeadlineBox({
  label,
  amount,
  emphasis,
}: {
  label: string;
  amount: number;
  emphasis?: boolean;
}) {
  return (
    <div className="glass-card rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono",
          emphasis ? "text-2xl font-bold" : "text-lg font-semibold",
        )}
      >
        <MaskedValue value={formatCurrency(amount)} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: PayrollRun["status"] }) {
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
        "px-2 py-1 text-xs font-semibold uppercase tracking-wider rounded",
        tone,
      )}
      title={runStatusHelp(status)}
    >
      {runStatusLabel(status)}
    </span>
  );
}

function YtdColumn({
  title,
  totals,
  projected,
  runValues,
  note,
}: {
  title: string;
  totals: YtdTotals;
  projected?: YtdTotals;
  runValues?: Partial<YtdTotals>;
  note?: string;
}) {
  // When we have projected + runValues, show `projected + runValues` as the
  // headline per-line. Otherwise just use `totals`.
  const lineValue = (key: keyof YtdTotals): number => {
    if (projected && runValues) {
      const base = Number(projected[key] ?? 0);
      const add = Number(runValues[key] ?? 0);
      return base + add;
    }
    return Number(totals[key] ?? 0);
  };

  return (
    <div className="space-y-2">
      <h4 className="text-xs uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <LineRow label="Gross" amount={lineValue("grossYtd")} />
      <LineRow
        label="Federal income tax"
        amount={lineValue("federalIncomeTaxYtd")}
      />
      <LineRow
        label="State income tax"
        amount={lineValue("stateIncomeTaxYtd")}
      />
      <LineRow
        label="SS (employee)"
        amount={lineValue("socialSecurityEmployeeYtd")}
      />
      <LineRow
        label="Medicare (employee)"
        amount={lineValue("medicareEmployeeYtd")}
      />
      <LineRow label="Net paid" amount={lineValue("netPayYtd")} bold />
    </div>
  );
}

function SimpleModal({
  open,
  title,
  description,
  confirmLabel,
  variant,
  children,
  onConfirm,
  onCancel,
  submitting,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  variant?: "danger";
  children: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onCancel();
      }}
    >
      <DialogContent className="space-y-4">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        {children}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={variant === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
            )}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryIcon({ type }: { type: PayrollRunEventType }) {
  const map: Record<PayrollRunEventType, React.ReactNode> = {
    created: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    updated: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    finalized: <FileCheck2 className="h-3.5 w-3.5 text-primary" aria-hidden="true" />,
    paid: <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />,
    voided: <XCircle className="h-3.5 w-3.5 text-error" aria-hidden="true" />,
    deleted: <Trash2 className="h-3.5 w-3.5 text-error" aria-hidden="true" />,
    restored: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
  };
  return <>{map[type]}</>;
}

function humanizeEvent(type: PayrollRunEventType): string {
  switch (type) {
    case "created":
      return "Draft created";
    case "updated":
      return "Draft recalculated";
    case "finalized":
      return "Approved";
    case "paid":
      return "Marked paid";
    case "voided":
      return "Voided";
    case "deleted":
      return "Deleted";
    case "restored":
      return "Restored";
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function taxYearOf(ymd: string): number {
  return Number(ymd.split("-")[0]);
}

function localTodayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Approve dialog body ─────────────────────────────────────────────────────

function ApproveDialogBody() {
  return (
    <div className="space-y-3 text-left">
      <p>Approving this run does three things:</p>
      <ul className="space-y-2">
        <ApproveStepLine
          icon={<Lock className="h-3.5 w-3.5" aria-hidden="true" />}
          title="Locks the numbers"
          detail="Updates YTD totals and freezes a snapshot for audit."
        />
        <ApproveStepLine
          icon={<Landmark className="h-3.5 w-3.5" aria-hidden="true" />}
          title="Schedules tax deposits"
          detail="Creates scheduled IRS and state deposits with due dates."
        />
        <ApproveStepLine
          icon={<Mail className="h-3.5 w-3.5" aria-hidden="true" />}
          title="Queues the pay stub"
          detail="Emails the stub after you mark the run as paid."
        />
      </ul>
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
        <span className="font-semibold text-foreground">
          This does not send wages.
        </span>{" "}
        Pay the employee through your bank, then mark the run as paid on the
        next screen.
      </div>
    </div>
  );
}

function ApproveStepLine({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary flex-shrink-0"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="text-sm text-foreground">
        <span className="font-medium">{title}</span>{" "}
        <span className="text-muted-foreground">- {detail}</span>
      </span>
    </li>
  );
}

// ─── What's next panel ────────────────────────────────────────────────────────

interface WhatsNextPanelProps {
  run: PayrollRun;
  cycleRuns: PayrollRun[];
  deposits: PayrollTaxDeposit[];
  stubBusy: boolean;
  onSendStub: () => void;
}

function WhatsNextPanel({
  run,
  cycleRuns,
  deposits,
  stubBusy,
  onSendStub,
}: WhatsNextPanelProps) {
  const isPaid = run.status === "paid";
  const stubSent = isPaid && !!run.stub_sent_at;

  // Non-voided siblings in this pay cycle. Voided runs don't block progress.
  // Fall back to just this run if siblings weren't fetched (legacy callers).
  const activeCycleRuns =
    cycleRuns.length > 0
      ? cycleRuns.filter((r) => r.status !== "voided")
      : [run];
  const cycleSize = activeCycleRuns.length;
  const paidInCycle = activeCycleRuns.filter(
    (r) => r.status === "paid",
  ).length;
  const stubsInCycle = activeCycleRuns.filter(
    (r) => r.status === "paid" && !!r.stub_sent_at,
  ).length;
  const isMultiEmployee = cycleSize > 1;

  const paidDeposits = deposits.filter((d) => d.status === "paid");
  const scheduledDeposits = deposits.filter((d) => d.status !== "paid");
  const depositsDone =
    deposits.length > 0 && scheduledDeposits.length === 0;
  const depositsPending = scheduledDeposits.length > 0;

  // Cycle-aware completion. For solo cycles this collapses to this run's
  // state. For multi-employee cycles Step 1/2 track the whole cycle so a
  // single finished run doesn't feel prematurely done while coworkers wait.
  const step1Done = isMultiEmployee
    ? paidInCycle === cycleSize
    : isPaid;
  const step1Partial = isMultiEmployee && paidInCycle > 0 && !step1Done;
  const step2Done = isMultiEmployee
    ? stubsInCycle === cycleSize
    : isPaid && stubSent;
  const step2Partial = isMultiEmployee
    ? stubsInCycle > 0 && !step2Done
    : isPaid && !stubSent;

  const allDone = step1Done && step2Done && depositsDone;

  return (
    <div className="glass-card rounded-xl p-5 space-y-4">
      {allDone ? (
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-4">
          <Sparkles
            className="h-4 w-4 text-success mt-0.5 flex-shrink-0"
            aria-hidden="true"
          />
          <div className="text-sm text-foreground space-y-1">
            <p className="font-medium">
              {isMultiEmployee
                ? "Every run in this cycle is fully settled."
                : "This run is fully settled."}
            </p>
            <p className="text-xs text-muted-foreground">
              Wages sent, pay stubs delivered, and tax deposits paid.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <ArrowRight className="h-4 w-4" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">
                What&apos;s next
              </h3>
            </div>
            <p className="text-xs text-muted-foreground">
              {isMultiEmployee
                ? `Progress shown across all ${cycleSize} employees in this cycle.`
                : "Approving only locks the math. These steps move real money."}
            </p>
          </div>

          <ol className="space-y-3 border-t border-border pt-4">
            {/* Step 1: Send wages externally. */}
            <StepRow
              num={1}
              done={step1Done}
              partial={step1Partial}
              title={
                isMultiEmployee
                  ? step1Done
                    ? `Wages sent to all ${cycleSize} employees`
                    : paidInCycle > 0
                      ? `Pay remaining employees (${paidInCycle} of ${cycleSize} done)`
                      : `Pay all ${cycleSize} employees`
                  : step1Done
                    ? "Wages sent"
                    : "Pay the employee"
              }
              detail={
                isMultiEmployee ? (
                  <>
                    Send each employee&apos;s net pay through your bank (ACH,
                    check, or wire). Use the cycle view to record them all
                    with one payment method.
                    {isPaid && run.payment_method && (
                      <>
                        {" "}
                        <span className="text-success">
                          This run recorded as {run.payment_method}
                          {run.payment_reference
                            ? ` (ref ${run.payment_reference})`
                            : ""}.
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    Send{" "}
                    <span className="font-mono text-foreground">
                      <MaskedValue
                        value={formatCurrency(Number(run.net_pay || 0))}
                      />
                    </span>{" "}
                    net pay through your bank (ACH, check, or wire).
                    {isPaid && run.payment_method && (
                      <>
                        {" "}
                        <span className="text-success">
                          Recorded as {run.payment_method}
                          {run.payment_reference
                            ? ` (ref ${run.payment_reference})`
                            : ""}.
                        </span>
                      </>
                    )}
                  </>
                )
              }
              action={
                isMultiEmployee && !step1Done ? (
                  <Link href={`/payroll/cycles/${run.pay_date}`}>
                    <Button size="sm" variant="outline">
                      Open cycle
                      <ArrowRight
                        className="h-3.5 w-3.5 ml-1"
                        aria-hidden="true"
                      />
                    </Button>
                  </Link>
                ) : null
              }
            />

            {/* Step 2: Record payment and email pay stubs. Only done when the
                stub has actually been delivered, so a silent send failure
                won't masquerade as completion. */}
            <StepRow
              num={2}
              done={step2Done}
              partial={step2Partial}
              title={
                isMultiEmployee
                  ? step2Done
                    ? `Pay stubs emailed to all ${cycleSize} employees`
                    : stubsInCycle > 0
                      ? `Deliver remaining pay stubs (${stubsInCycle} of ${cycleSize} sent)`
                      : `Mark each run paid and email pay stubs`
                  : step2Done
                    ? "Marked paid and pay stub sent"
                    : isPaid
                      ? "Deliver the pay stub"
                      : "Mark this run as paid"
              }
              detail={
                isMultiEmployee ? (
                  step2Done ? (
                    "Every run in the cycle is paid with its stub delivered."
                  ) : isPaid ? (
                    stubSent ? (
                      <>
                        This employee&apos;s stub was emailed{" "}
                        {run.stub_sent_at ? formatTime(run.stub_sent_at) : ""}.
                      </>
                    ) : (
                      <>Pay stub for this run has not been delivered yet.</>
                    )
                  ) : (
                    "Recording payment also emails the pay stub to each employee."
                  )
                ) : isPaid ? (
                  stubSent ? (
                    <>
                      Pay stub emailed{" "}
                      {run.stub_sent_at ? formatTime(run.stub_sent_at) : ""}.
                    </>
                  ) : (
                    <>Pay stub has not been delivered yet.</>
                  )
                ) : (
                  <>
                    Records the payment in the audit log and emails the pay
                    stub to the employee.
                  </>
                )
              }
              action={
                isPaid && !stubSent ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onSendStub}
                    disabled={stubBusy}
                  >
                    {stubBusy ? (
                      <Loader2
                        className="h-3.5 w-3.5 mr-1 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Mail className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                    )}
                    Send pay stub
                  </Button>
                ) : null
              }
            />

            {/* Step 3: Pay tax deposits */}
            <StepRow
              num={3}
              done={depositsDone}
              partial={paidDeposits.length > 0 && depositsPending}
              title={
                deposits.length === 0
                  ? "Pay tax deposits"
                  : depositsDone
                    ? "Tax deposits paid"
                    : paidDeposits.length > 0
                      ? `Pay remaining tax deposits (${paidDeposits.length} of ${deposits.length} done)`
                      : `Pay tax deposits (${deposits.length})`
              }
              detail={
                deposits.length === 0 ? (
                  <>
                    Deposits will appear here once approval completes. If
                    this message stays, the run had no taxable liability
                    (e.g., all zero).
                  </>
                ) : (
                  <DepositList
                    deposits={deposits}
                    linked={step2Done || depositsDone}
                  />
                )
              }
              action={null}
            />

          </ol>
        </>
      )}
    </div>
  );
}

function StepRow({
  num,
  done,
  partial,
  title,
  detail,
  action,
}: {
  num: number;
  done?: boolean;
  partial?: boolean;
  title: React.ReactNode;
  detail: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 flex-wrap">
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full flex-shrink-0 text-xs font-semibold",
          done
            ? "bg-success/10 text-success"
            : partial
              ? "bg-warning/10 text-warning"
              : "bg-secondary text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {done ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : partial ? (
          <CircleDashed className="h-4 w-4" />
        ) : (
          num
        )}
      </span>
      <div className="flex-1 min-w-[200px] space-y-0.5">
        <div
          className={cn(
            "text-sm font-medium",
            done ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          {title}
        </div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </li>
  );
}

function DepositList({
  deposits,
  linked,
}: {
  deposits: PayrollTaxDeposit[];
  /** When true (step 3 is active or complete) each row links to the deposits
   *  page. When false we render plain rows so users aren't nudged to step 3
   *  before finishing step 2. */
  linked: boolean;
}) {
  const todayYmd = localTodayYmd();
  return (
    <ul className="mt-1 space-y-1">
      {deposits.map((d) => {
        const isPaid = d.status === "paid";
        // String compare keeps the check calendar-day accurate. A deposit due
        // today is not "late" until tomorrow, regardless of clock time.
        const isLate = !isPaid && d.due_date < todayYmd;
        const inner = (
          <>
            <span className="flex items-center gap-1.5">
              {isPaid ? (
                <CheckCircle2
                  className="h-3 w-3 text-success flex-shrink-0"
                  aria-hidden="true"
                />
              ) : isLate ? (
                <AlertTriangle
                  className="h-3 w-3 text-error flex-shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <Circle
                  className="h-3 w-3 text-muted-foreground flex-shrink-0"
                  aria-hidden="true"
                />
              )}
              <span className="text-foreground">
                {DEPOSIT_TYPE_LABELS[d.deposit_type]}
              </span>
              <span className="font-mono text-muted-foreground">
                <MaskedValue value={formatCurrency(Number(d.amount || 0))} />
              </span>
            </span>
            <span
              className={cn(
                "text-[11px]",
                isPaid
                  ? "text-success"
                  : isLate
                    ? "text-error font-semibold"
                    : "text-muted-foreground",
              )}
            >
              {isPaid
                ? `Paid ${d.paid_at ? formatTime(d.paid_at) : ""}`
                : isLate
                  ? `Past due ${formatDate(d.due_date)}`
                  : `Due ${formatDate(d.due_date)}`}
            </span>
          </>
        );
        return (
          <li key={d.id}>
            {linked ? (
              <Link
                href="/payroll/deposits"
                className="flex items-center justify-between gap-2 flex-wrap text-xs rounded-md -mx-1 px-1 py-0.5 hover:bg-secondary/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {inner}
              </Link>
            ) : (
              <div className="flex items-center justify-between gap-2 flex-wrap text-xs -mx-1 px-1 py-0.5">
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function runAsYtdPatch(run: PayrollRun): Partial<YtdTotals> {
  return {
    grossYtd: Number(run.gross_pay || 0),
    federalIncomeTaxYtd: Number(run.federal_income_tax || 0),
    stateIncomeTaxYtd: Number(run.state_income_tax || 0),
    socialSecurityEmployeeYtd: Number(run.social_security_employee || 0),
    medicareEmployeeYtd: Number(run.medicare_employee || 0),
    additionalMedicareYtd: Number(run.additional_medicare || 0),
    stateDisabilityEmployeeYtd: Number(run.state_disability_employee || 0),
    socialSecurityEmployerYtd: Number(run.social_security_employer || 0),
    medicareEmployerYtd: Number(run.medicare_employer || 0),
    futaYtd: Number(run.futa || 0),
    sutaYtd: Number(run.suta || 0),
    stateDisabilityEmployerYtd: Number(run.state_disability_employer || 0),
    netPayYtd: Number(run.net_pay || 0),
  };
}
