"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  Loader2,
  Send,
  Sparkles,
  Users,
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
import { toast } from "@/components/ui/toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { markRunPaid, markRunsPaidBatch } from "@/lib/payroll/runs-actions";
import { runStatusLabel } from "@/lib/payroll/labels";
import {
  DEPOSIT_TYPE_LABELS,
  PAY_FREQUENCY_LABELS,
} from "@/types/payroll";
import type {
  PayrollEmployee,
  PayrollRun,
  PayrollTaxDeposit,
  RunStatus,
} from "@/types/payroll";

type CycleEmployee = Pick<
  PayrollEmployee,
  "id" | "first_name" | "last_name" | "pay_frequency" | "state_code"
>;

interface Props {
  payDate: string;
  runs: PayrollRun[];
  employees: CycleEmployee[];
  deposits: PayrollTaxDeposit[];
}

type OpenDialog = "markAllPaid" | { kind: "markOne"; runId: string } | null;

export function CycleDetailContent({
  payDate,
  runs,
  employees,
  deposits,
}: Props) {
  const router = useRouter();

  const employeeById = React.useMemo(() => {
    const map = new Map<string, CycleEmployee>();
    for (const e of employees) map.set(e.id, e);
    return map;
  }, [employees]);

  const [dialog, setDialog] = React.useState<OpenDialog>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [paymentMethod, setPaymentMethod] = React.useState("ACH");
  const [paymentReference, setPaymentReference] = React.useState("");

  const closeDialog = () => {
    if (submitting) return;
    setDialog(null);
    setPaymentReference("");
  };

  // Period assumed uniform across the cycle (cycles share pay_date and, in
  // practice, period). Fall back to a span label when they diverge.
  const periodLabel = React.useMemo(() => {
    if (runs.length === 0) return null;
    const first = runs[0];
    const uniform = runs.every(
      (r) =>
        r.period_start === first.period_start &&
        r.period_end === first.period_end,
    );
    if (uniform) {
      return `${formatDate(first.period_start)} to ${formatDate(first.period_end)}`;
    }
    const starts = runs.map((r) => r.period_start).sort();
    const ends = runs.map((r) => r.period_end).sort();
    return `${formatDate(starts[0])} to ${formatDate(ends[ends.length - 1])}`;
  }, [runs]);

  const totals = React.useMemo(() => {
    let gross = 0;
    let net = 0;
    let employeeTaxes = 0;
    for (const r of runs) {
      if (r.status === "voided") continue;
      gross += Number(r.gross_pay || 0);
      net += Number(r.net_pay || 0);
      employeeTaxes +=
        Number(r.federal_income_tax || 0) +
        Number(r.state_income_tax || 0) +
        Number(r.social_security_employee || 0) +
        Number(r.medicare_employee || 0) +
        Number(r.additional_medicare || 0) +
        Number(r.state_disability_employee || 0);
    }
    return { gross, net, employeeTaxes };
  }, [runs]);

  const activeRuns = React.useMemo(
    () => runs.filter((r) => r.status !== "voided"),
    [runs],
  );
  const draftRuns = activeRuns.filter((r) => r.status === "draft");
  const approvedRuns = activeRuns.filter((r) => r.status === "finalized");
  const paidRuns = activeRuns.filter((r) => r.status === "paid");

  const total = activeRuns.length;
  const approvedCount = approvedRuns.length + paidRuns.length;
  const paidCount = paidRuns.length;

  const step1Done = total > 0 && approvedCount === total;
  const step2Done = total > 0 && paidCount === total;
  const step2Partial = paidCount > 0 && !step2Done;

  const paidDeposits = deposits.filter((d) => d.status === "paid");
  const scheduledDeposits = deposits.filter((d) => d.status !== "paid");
  const step3Done = deposits.length > 0 && scheduledDeposits.length === 0;
  const step3Partial = paidDeposits.length > 0 && !step3Done;

  const allDone = step1Done && step2Done && step3Done;
  const nextDeposit = scheduledDeposits
    .slice()
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];

  const canBulkMarkPaid = approvedRuns.length > 0;

  const handleMarkOnePaid = async (runId: string) => {
    setSubmitting(true);
    try {
      const res = await markRunPaid({
        run_id: runId,
        payment_method: paymentMethod.trim() || null,
        payment_reference: paymentReference.trim() || null,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to mark paid");
        return;
      }
      toast("success", "Marked as paid");
      setDialog(null);
      setPaymentReference("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const handleMarkAllPaid = async () => {
    if (approvedRuns.length === 0) {
      toast("info", "No approved runs waiting for payment.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await markRunsPaidBatch({
        run_ids: approvedRuns.map((r) => r.id),
        payment_method: paymentMethod.trim() || null,
        payment_reference: paymentReference.trim() || null,
      });
      if (!res.ok || !res.data) {
        toast("error", res.error ?? "Failed to mark paid");
        return;
      }
      const ok = res.data.succeeded.length;
      const failed = res.data.failed.length;
      if (failed === 0) {
        toast(
          "success",
          `Marked ${ok} run${ok === 1 ? "" : "s"} as paid`,
        );
      } else {
        toast(
          "warning",
          `Marked ${ok}; ${failed} failed. Check each run.`,
        );
      }
      setDialog(null);
      setPaymentReference("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const activeStep: 1 | 2 | 3 | null = !step1Done
    ? 1
    : !step2Done
      ? 2
      : !step3Done
        ? 3
        : null;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl flex-shrink-0",
              allDone
                ? "bg-success/15 text-success"
                : "bg-primary/10 text-primary",
            )}
            aria-hidden="true"
          >
            <CalendarDays className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">Pay cycle</h1>
            <p className="text-sm text-muted-foreground">
              Pay date {formatDate(payDate)}
              {periodLabel ? ` - period ${periodLabel}` : ""}
            </p>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {total} {total === 1 ? "employee" : "employees"}
              {runs.length > total
                ? ` (+${runs.length - total} voided)`
                : ""}
            </p>
          </div>
        </div>
        <CycleStatusPill allDone={allDone} activeStep={activeStep} />
      </div>

      {/* Checklist - one shared surface for all three follow-ups, so the
          admin always knows which step they're on even as they scroll the
          per-run list below. */}
      <div className="glass-card rounded-xl p-5 space-y-4">
        {total === 0 ? (
          <div className="rounded-lg border border-border bg-secondary/30 p-4 flex items-start gap-3">
            <XCircle
              className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
            <div className="text-sm text-foreground space-y-1">
              <p className="font-medium">Every run in this cycle is voided.</p>
              <p className="text-xs text-muted-foreground">
                Voided runs are excluded from YTD and filings. Kept here for
                audit. To re-run this cycle, start a new payroll for this pay
                date.
              </p>
            </div>
          </div>
        ) : allDone ? (
          <div className="rounded-lg border border-success/30 bg-success/5 p-4 flex items-start gap-3">
            <Sparkles
              className="h-4 w-4 text-success mt-0.5 flex-shrink-0"
              aria-hidden="true"
            />
            <div className="text-sm text-foreground space-y-1">
              <p className="font-medium">
                Every follow-up for this cycle is complete.
              </p>
              <p className="text-xs text-muted-foreground">
                Wages sent, stubs delivered, tax deposits paid.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              What&apos;s left to do
            </div>
            <ol className="space-y-2.5">
              <ChecklistRow
                num={1}
                state={
                  step1Done ? "done" : activeStep === 1 ? "active" : "pending"
                }
                icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                title={
                  step1Done
                    ? `Runs approved (${approvedCount} of ${total})`
                    : `Approve the remaining ${draftRuns.length} draft${draftRuns.length === 1 ? "" : "s"}`
                }
                detail={
                  step1Done
                    ? "Numbers locked, YTD updated, tax deposits scheduled."
                    : "Open each draft below and approve to lock the numbers."
                }
              />
              <ChecklistRow
                num={2}
                state={
                  step2Done
                    ? "done"
                    : step2Partial
                      ? "partial"
                      : activeStep === 2
                        ? "active"
                        : "pending"
                }
                icon={<Send className="h-4 w-4" aria-hidden="true" />}
                title={
                  step2Done
                    ? `Wages paid and stubs queued (${paidCount} of ${total})`
                    : step2Partial
                      ? `Pay remaining employees (${paidCount} of ${total} done)`
                      : `Pay employees + mark each run paid`
                }
                detail={
                  step2Done
                    ? "Payment recorded for every run in the cycle."
                    : "Send net pay through your bank, then log one payment method for the batch below."
                }
                action={
                  canBulkMarkPaid ? (
                    <Button
                      size="sm"
                      onClick={() => setDialog("markAllPaid")}
                      disabled={submitting}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                      {approvedRuns.length === total
                        ? "Mark all as paid"
                        : `Mark ${approvedRuns.length} as paid`}
                    </Button>
                  ) : null
                }
              />
              <ChecklistRow
                num={3}
                state={
                  step3Done
                    ? "done"
                    : step3Partial
                      ? "partial"
                      : activeStep === 3
                        ? "active"
                        : "pending"
                }
                icon={<Banknote className="h-4 w-4" aria-hidden="true" />}
                title={
                  deposits.length === 0
                    ? "Pay federal + state tax deposits"
                    : step3Done
                      ? `Tax deposits paid (${paidDeposits.length} of ${deposits.length})`
                      : step3Partial
                        ? `Pay remaining deposits (${paidDeposits.length} of ${deposits.length} done)`
                        : `Pay ${deposits.length} tax deposit${deposits.length === 1 ? "" : "s"}`
                }
                detail={
                  deposits.length === 0 ? (
                    "Deposits appear here once this cycle's runs are approved."
                  ) : step3Done ? (
                    "All IRS and state deposits for this cycle are paid."
                  ) : nextDeposit ? (
                    <>
                      Next up{" "}
                      <span className="text-foreground font-medium">
                        {DEPOSIT_TYPE_LABELS[nextDeposit.deposit_type]}
                      </span>
                      {" - "}due {formatDate(nextDeposit.due_date)}.
                    </>
                  ) : null
                }
                action={null}
              />
            </ol>
          </>
        )}
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <HeadlineBox label="Gross" amount={totals.gross} />
        <HeadlineBox label="Employee taxes" amount={totals.employeeTaxes} />
        <HeadlineBox label="Total net paid" amount={totals.net} emphasis />
      </div>

      {/* Per-run list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            Employees in this cycle
          </h2>
          <span className="text-xs text-muted-foreground">
            {total} {total === 1 ? "run" : "runs"}
          </span>
        </div>
        <div className="space-y-2">
          {runs.map((run, index) => {
            const emp = employeeById.get(run.employee_id);
            const isApproved = run.status === "finalized";
            return (
              <div
                key={run.id}
                className={cn(
                  "glass-card rounded-xl p-4 transition-all duration-200",
                  "animate-fade-up",
                  `stagger-${Math.min(index + 1, 6)}`,
                  run.status === "voided" && "opacity-60",
                )}
              >
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex-1 min-w-[180px]">
                    <div className="text-sm font-medium text-foreground truncate">
                      {emp
                        ? `${emp.first_name} ${emp.last_name}`
                        : "(removed employee)"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {emp ? PAY_FREQUENCY_LABELS[emp.pay_frequency] : null}
                      {emp ? ` - ${emp.state_code}` : null}
                    </div>
                  </div>
                  <div className="min-w-[100px]">
                    <div className="text-xs text-muted-foreground">Gross</div>
                    <div className="font-mono text-sm text-foreground">
                      <MaskedValue
                        value={formatCurrency(Number(run.gross_pay || 0))}
                      />
                    </div>
                  </div>
                  <div className="min-w-[100px]">
                    <div className="text-xs text-muted-foreground">Net</div>
                    <div className="font-mono text-sm text-foreground">
                      <MaskedValue
                        value={formatCurrency(Number(run.net_pay || 0))}
                      />
                    </div>
                  </div>
                  <RunStatusBadge status={run.status} />
                  <div className="flex items-center gap-2 ml-auto">
                    {isApproved && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setDialog({ kind: "markOne", runId: run.id })
                        }
                        disabled={submitting}
                      >
                        Mark paid
                      </Button>
                    )}
                    <Link
                      href={`/payroll/runs/${run.id}`}
                      className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
                    >
                      Open
                      <ChevronRight
                        className="h-4 w-4 ml-0.5"
                        aria-hidden="true"
                      />
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Back to runs */}
      <div className="pt-2">
        <Link
          href="/payroll/runs"
          className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
        >
          View all pay runs
        </Link>
      </div>

      {/* Bulk mark-paid modal */}
      <MarkPaidDialog
        open={dialog === "markAllPaid"}
        title={
          approvedRuns.length === total
            ? `Mark ${approvedRuns.length} run${approvedRuns.length === 1 ? "" : "s"} as paid`
            : `Mark ${approvedRuns.length} of ${total} as paid`
        }
        description={
          approvedRuns.length === total
            ? "Applies this payment method and reference to every approved run in the cycle, then queues pay stubs."
            : "Applies this payment method and reference to every approved run. Draft or already-paid runs are skipped."
        }
        confirmLabel={`Mark ${approvedRuns.length} paid`}
        paymentMethod={paymentMethod}
        onPaymentMethodChange={setPaymentMethod}
        paymentReference={paymentReference}
        onPaymentReferenceChange={setPaymentReference}
        submitting={submitting}
        onCancel={closeDialog}
        onConfirm={handleMarkAllPaid}
      />

      {/* Single-run mark-paid modal (parity with run-detail-content) */}
      <MarkPaidDialog
        open={dialog !== null && dialog !== "markAllPaid"}
        title="Mark as paid"
        description="Record the payment method and reference. This captures the pay event in history."
        confirmLabel="Mark paid"
        paymentMethod={paymentMethod}
        onPaymentMethodChange={setPaymentMethod}
        paymentReference={paymentReference}
        onPaymentReferenceChange={setPaymentReference}
        submitting={submitting}
        onCancel={closeDialog}
        onConfirm={() =>
          dialog && dialog !== "markAllPaid"
            ? handleMarkOnePaid(dialog.runId)
            : undefined
        }
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type RowState = "done" | "active" | "partial" | "pending";

function ChecklistRow({
  num,
  state,
  icon,
  title,
  detail,
  action,
}: {
  num: number;
  state: RowState;
  icon: React.ReactNode;
  title: React.ReactNode;
  detail: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg px-3 py-2.5 border transition-colors",
        state === "active" && "bg-primary/5 border-primary/30",
        state === "partial" && "bg-warning/5 border-warning/30",
        state === "done" && "bg-secondary/30 border-border",
        state === "pending" && "bg-transparent border-border",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full flex-shrink-0 text-xs font-semibold mt-0.5",
          state === "done" && "bg-success/15 text-success",
          state === "active" && "bg-primary text-primary-foreground",
          state === "partial" && "bg-warning/15 text-warning",
          state === "pending" && "bg-secondary text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {state === "done" ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : state === "partial" ? (
          <CircleDashed className="h-4 w-4" />
        ) : state === "active" ? (
          icon
        ) : (
          num
        )}
      </span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div
          className={cn(
            "text-sm font-medium",
            state === "done" && "text-muted-foreground line-through",
            state === "pending" && "text-muted-foreground",
            state === "active" && "text-foreground",
            state === "partial" && "text-foreground",
          )}
        >
          {title}
        </div>
        {detail && (
          <div className="text-xs text-muted-foreground">{detail}</div>
        )}
      </div>
      {action && <div className="flex-shrink-0 self-center">{action}</div>}
    </li>
  );
}

function CycleStatusPill({
  allDone,
  activeStep,
}: {
  allDone: boolean;
  activeStep: 1 | 2 | 3 | null;
}) {
  if (allDone) {
    return (
      <span className="inline-flex items-center rounded-md bg-success/10 text-success px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
        Settled
      </span>
    );
  }
  const label =
    activeStep === 1
      ? "In progress"
      : activeStep === 2
        ? "Ready to pay"
        : activeStep === 3
          ? "Deposits pending"
          : "In progress";
  return (
    <span className="inline-flex items-center rounded-md bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
      {label}
    </span>
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

function MarkPaidDialog({
  open,
  title,
  description,
  confirmLabel,
  paymentMethod,
  onPaymentMethodChange,
  paymentReference,
  onPaymentReferenceChange,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  paymentMethod: string;
  onPaymentMethodChange: (value: string) => void;
  paymentReference: string;
  onPaymentReferenceChange: (value: string) => void;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
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
        <DialogDescription>{description}</DialogDescription>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">
              Payment method
            </label>
            <CustomSelect
              value={paymentMethod}
              onChange={onPaymentMethodChange}
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
              onChange={(e) => onPaymentReferenceChange(e.target.value)}
              placeholder="Check # or transaction id"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={submitting}>
            {submitting && (
              <Loader2
                className="h-4 w-4 mr-1 animate-spin"
                aria-hidden="true"
              />
            )}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
