"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Landmark,
  Loader2,
  Lock,
  Mail,
  Pencil,
  Play,
  Trash2,
  UserCircle,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { MaskedValue } from "@/components/ui/masked-value";
import { toast } from "@/components/ui/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import {
  createBatchDrafts,
  finalizeRunsBatch,
  type PreviewBatchResult,
  type PreviewRunItem,
} from "@/lib/payroll/runs-actions";
import type { CalculatedRun } from "@/lib/payroll/engine";
import {
  WITHHOLDING_CATEGORY_LABELS,
  type WithholdingCategory,
  type WithholdingLineItem,
} from "@/types/payroll";
import { CustomSelect } from "@/components/ui/select";
import { Term } from "./term";

const CATEGORY_OPTIONS: { value: WithholdingCategory; label: string }[] = (
  Object.keys(WITHHOLDING_CATEGORY_LABELS) as WithholdingCategory[]
).map((value) => ({ value, label: WITHHOLDING_CATEGORY_LABELS[value] }));

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  initialPreview: PreviewBatchResult;
  initialPayDate: string | null;
  /** When the user arrived from a specific pay-window card, these are the
   *  only employees in scope. Null means "all active employees on this
   *  pay date" (e.g., the custom-date escape hatch). */
  initialEmployeeIds?: string[] | null;
}

interface RowState {
  include: boolean;
  overrideGross: string;
  extraItems: {
    id: string;
    label: string;
    amount: string;
    category: WithholdingCategory;
  }[];
  expanded: boolean;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function initialRowState(_item: PreviewRunItem): RowState {
  return {
    include: true,
    overrideGross: "",
    extraItems: [],
    expanded: false,
  };
}

function itemKey(item: PreviewRunItem): string {
  return item.employee.id;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RunBatchContent({
  initialPreview,
  initialPayDate,
  initialEmployeeIds,
}: Props) {
  const router = useRouter();

  const [preview, setPreview] =
    React.useState<PreviewBatchResult>(initialPreview);
  const [rows, setRows] = React.useState<Record<string, RowState>>(() => {
    const base: Record<string, RowState> = {};
    for (const item of initialPreview.items) {
      base[itemKey(item)] = initialRowState(item);
    }
    return base;
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // Window context derived from the preview items. Since this page is now
  // URL-driven, we only need read-only context for the header banner.
  const windowContext = React.useMemo(() => {
    if (initialPreview.items.length === 0) return null;
    const first = initialPreview.items[0];
    const allSamePeriod = initialPreview.items.every(
      (it) =>
        it.period.period_start === first.period.period_start &&
        it.period.period_end === first.period.period_end &&
        it.period.pay_date === first.period.pay_date,
    );
    return {
      payDate: initialPayDate ?? first.period.pay_date,
      period: allSamePeriod
        ? {
            period_start: first.period.period_start,
            period_end: first.period.period_end,
          }
        : null,
    };
  }, [initialPreview, initialPayDate]);

  // Keep rows synced when initialPreview changes (after router.refresh).
  React.useEffect(() => {
    setPreview(initialPreview);
    setRows((prev) => {
      const next: Record<string, RowState> = {};
      for (const item of initialPreview.items) {
        const key = itemKey(item);
        next[key] = prev[key] ?? initialRowState(item);
      }
      return next;
    });
  }, [initialPreview]);

  const scopedBadge = initialEmployeeIds != null && initialEmployeeIds.length > 0;

  const selectedCount = React.useMemo(
    () =>
      preview.items.filter((it) => rows[itemKey(it)]?.include).length,
    [preview.items, rows],
  );

  const totals = React.useMemo(() => {
    let gross = 0;
    let employeeTaxes = 0;
    let otherDeductions = 0;
    let net = 0;
    let employerTaxes = 0;
    let dirtyCount = 0;
    for (const item of preview.items) {
      const s = rows[itemKey(item)];
      if (!s?.include) continue;
      const eff = effectiveDisplay(item, s);
      // Rows with a gross override OR pre-tax deduction produce stale tax
      // numbers locally (the former because brackets/caps are non-linear,
      // the latter because pre-tax reduces taxable wages the engine hasn't
      // seen yet). Skip them so totals aren't a mix of stale + real engine
      // output. A dirtyCount badge warns the admin.
      if (eff.grossIsDirty) {
        dirtyCount++;
        gross += eff.gross_pay;
        continue;
      }
      const rowEmployeeTaxes =
        eff.federal_income_tax +
        eff.state_income_tax +
        eff.social_security_employee +
        eff.medicare_employee +
        eff.additional_medicare +
        eff.state_disability_employee;
      gross += eff.gross_pay;
      employeeTaxes += rowEmployeeTaxes;
      net += eff.net_pay;
      // Anything left between gross and net that isn't a tax is a pre/post-tax
      // deduction (401k, health, garnishments, user-added extras). Derive from
      // the identity so we don't double-count server-side vs. client-side.
      otherDeductions += Math.max(
        0,
        eff.gross_pay - rowEmployeeTaxes - eff.net_pay,
      );
      employerTaxes +=
        eff.social_security_employer +
        eff.medicare_employer +
        eff.futa +
        eff.suta +
        eff.state_disability_employer;
    }
    const totalCost = gross + employerTaxes;
    return {
      gross,
      employeeTaxes,
      otherDeductions,
      net,
      employerTaxes,
      totalCost,
      dirtyCount,
    };
  }, [preview.items, rows]);

  const updateRow = (id: string, patch: Partial<RowState>) => {
    setRows((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  };

  const handleAddExtra = (id: string) => {
    setRows((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        extraItems: [
          ...prev[id].extraItems,
          { id: uid(), label: "", amount: "", category: "post_tax" },
        ],
      },
    }));
  };

  const handleRemoveExtra = (id: string, extraId: string) => {
    setRows((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        extraItems: prev[id].extraItems.filter((e) => e.id !== extraId),
      },
    }));
  };

  const handleExtraChange = (
    id: string,
    extraId: string,
    field: "label" | "amount",
    value: string,
  ) => {
    setRows((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        extraItems: prev[id].extraItems.map((e) =>
          e.id === extraId ? { ...e, [field]: value } : e,
        ),
      },
    }));
  };

  const handleExtraCategoryChange = (
    id: string,
    extraId: string,
    category: WithholdingCategory,
  ) => {
    setRows((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        extraItems: prev[id].extraItems.map((e) =>
          e.id === extraId ? { ...e, category } : e,
        ),
      },
    }));
  };

  const handleRun = async () => {
    setSubmitting(true);
    try {
      const payload = preview.items
        .filter((it) => rows[itemKey(it)]?.include)
        .map((it) => {
          const s = rows[itemKey(it)];
          const overrideGross =
            s.overrideGross.trim() !== "" ? Number(s.overrideGross) : undefined;
          const other: WithholdingLineItem[] = s.extraItems
            .filter((e) => e.label.trim() && Number(e.amount) > 0)
            .map((e) => ({
              id: e.id,
              label: e.label.trim(),
              amount: Number(e.amount),
              category: e.category,
              taxable: false,
            }));
          return {
            employee_id: it.employee.id,
            pay_date: it.period.pay_date,
            override_gross:
              overrideGross != null && !Number.isNaN(overrideGross)
                ? overrideGross
                : null,
            other_withholdings: other,
          };
        });

      if (payload.length === 0) {
        toast("info", "Select at least one employee to approve");
        return;
      }

      const createRes = await createBatchDrafts({ items: payload });
      if (!createRes.ok || !createRes.data) {
        toast("error", createRes.error ?? "Failed to create drafts");
        return;
      }

      const createdIds = createRes.data.created.map((c) => c.id);
      if (createdIds.length === 0) {
        toast(
          "error",
          `No drafts created. ${createRes.data.failed.length} failed.`,
        );
        return;
      }

      const finalizeRes = await finalizeRunsBatch(createdIds);
      if (!finalizeRes.ok || !finalizeRes.data) {
        toast(
          "warning",
          `Created ${createdIds.length} drafts, but approval failed: ${finalizeRes.error ?? "unknown error"}`,
        );
        router.push("/payroll/runs");
        return;
      }

      const succeededIds = finalizeRes.data.succeeded;
      const ok = succeededIds.length;
      const failed =
        finalizeRes.data.failed.length + createRes.data.failed.length;
      if (failed === 0) {
        toast("success", `Approved ${ok} pay run${ok === 1 ? "" : "s"}`);
      } else {
        toast(
          "warning",
          `Approved ${ok}; ${failed} failed. Check the runs list.`,
        );
      }
      // One employee lands on the run detail. Multi-employee batches land
      // on the dedicated cycle page so the admin can see every run in the
      // cycle and mark them all paid in one step.
      const cyclePayDate = windowContext?.payDate ?? initialPayDate;
      if (ok === 1 && failed === 0) {
        router.push(`/payroll/runs/${succeededIds[0]}`);
      } else if (ok >= 2 && cyclePayDate) {
        router.push(`/payroll/cycles/${cyclePayDate}`);
      } else {
        router.push("/payroll/runs");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      toast("error", msg);
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  };

  const totalErrors = preview.errors.length;
  const nothingToRun = preview.items.length === 0;
  const everyoneAlreadyRun = nothingToRun && totalErrors > 0;
  const subtitle = everyoneAlreadyRun
    ? totalErrors === 1
      ? "This employee already has a run for the current pay cycle."
      : "Every active employee already has a run for the current pay cycle."
    : nothingToRun
      ? "No active employees found for this pay cycle."
      : "Review, adjust, and approve this pay cycle";

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Play className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Calculate Payroll</h1>
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Window context */}
      {windowContext && (
        <div className="glass-card rounded-xl p-4 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarDays
              className="h-4 w-4 text-primary"
              aria-hidden="true"
            />
            <span className="text-sm font-semibold text-foreground">
              Pay date {formatDate(windowContext.payDate)}
            </span>
          </div>
          {windowContext.period && (
            <div className="text-sm text-muted-foreground">
              Period {formatDate(windowContext.period.period_start)}
              {" - "}
              {formatDate(windowContext.period.period_end)}
            </div>
          )}
          {!scopedBadge && (
            <span className="ml-auto text-xs text-muted-foreground">
              Showing all active employees whose schedule matches this date
            </span>
          )}
          {scopedBadge && (
            <span className="ml-auto text-xs text-muted-foreground">
              Scoped to this pay cycle's roster
            </span>
          )}
        </div>
      )}

      {/* Skip warning: only shown when SOME employees are still runnable. When
          everyone is skipped, the full empty state below handles messaging
          and per-employee links. */}
      {totalErrors > 0 && !nothingToRun && (
        <div className="glass-card rounded-xl p-4 border border-warning/30 space-y-2">
          <h3 className="text-sm font-semibold text-foreground">
            {totalErrors} employee
            {totalErrors === 1 ? "" : "s"} skipped
          </h3>
          <ul className="space-y-1 text-sm">
            {preview.errors.map((e) => (
              <li key={e.employee.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {e.employee.first_name} {e.employee.last_name}
                </span>
                {" - "}
                {e.reason}
                {e.existing_run_id && (
                  <>
                    {" "}
                    <Link
                      href={`/payroll/runs/${e.existing_run_id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      Open run &rarr;
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Totals */}
      {preview.items.length > 0 && (
        <div className="glass-card rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <CircleDollarSign
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Payroll summary
              </h3>
            </div>
            <span className="text-xs text-muted-foreground">
              {selectedCount} of {preview.items.length} employee
              {preview.items.length === 1 ? "" : "s"} selected
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Employees take home */}
            <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <UserCircle
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Employees take home
                </span>
              </div>
              <div className="space-y-1.5">
                <SummaryLine label="Gross wages" amount={totals.gross} />
                <SummaryLine
                  label="Employee taxes"
                  amount={totals.employeeTaxes}
                  prefix="-"
                />
                {totals.otherDeductions > 0 && (
                  <SummaryLine
                    label="Other deductions"
                    amount={totals.otherDeductions}
                    prefix="-"
                  />
                )}
              </div>
              <div className="flex items-center justify-between border-t border-border pt-2">
                <span className="text-sm font-semibold text-foreground">
                  Net pay
                </span>
                <span className="font-mono text-lg font-bold text-success">
                  <MaskedValue value={formatCurrency(totals.net)} />
                </span>
              </div>
            </div>

            {/* Employer pays */}
            <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Wallet
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Employer pays
                </span>
              </div>
              <div className="space-y-1.5">
                <SummaryLine label="Gross wages" amount={totals.gross} />
                <SummaryLine
                  label="Employer taxes"
                  amount={totals.employerTaxes}
                  prefix="+"
                />
              </div>
              <div className="flex items-center justify-between border-t border-border pt-2">
                <span className="text-sm font-semibold text-foreground">
                  Total cost
                </span>
                <span className="font-mono text-lg font-bold text-foreground">
                  <MaskedValue value={formatCurrency(totals.totalCost)} />
                </span>
              </div>
            </div>
          </div>

          {totals.dirtyCount > 0 && (
            <p className="text-xs text-warning">
              {totals.dirtyCount} row
              {totals.dirtyCount === 1 ? " has" : "s have"} a gross override
              or pre-tax deduction - taxes, deductions, and net above exclude{" "}
              {totals.dirtyCount === 1 ? "it" : "them"} and will be recomputed
              server-side when you click Approve payroll.
            </p>
          )}
        </div>
      )}

      {/* Employee list */}
      {everyoneAlreadyRun ? (
        <div className="glass-card rounded-xl p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-success/15 flex-shrink-0"
              aria-hidden="true"
            >
              <CheckCircle2 className="h-5 w-5 text-success" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-foreground">
                {totalErrors === 1
                  ? "This cycle is already covered"
                  : "Every employee is already covered for this cycle"}
              </h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                Open the existing{" "}
                {totalErrors === 1 ? "run" : "runs"} below to view, edit, or
                approve{" "}
                {totalErrors === 1 ? "it" : "them"}.
              </p>
            </div>
          </div>

          <ul className="space-y-2 border-t border-border pt-4">
            {preview.errors.map((e) => (
              <li
                key={e.employee.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/20 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {e.employee.first_name} {e.employee.last_name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {e.reason}
                  </div>
                </div>
                {e.existing_run_id ? (
                  <Link
                    href={`/payroll/runs/${e.existing_run_id}`}
                    className="flex-shrink-0"
                  >
                    <Button size="sm">
                      Open run
                      <ArrowRight
                        className="h-3.5 w-3.5 ml-1"
                        aria-hidden="true"
                      />
                    </Button>
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 flex-wrap border-t border-border pt-4">
            <Link href="/payroll/runs">
              <Button variant="outline" size="sm">
                View all pay runs
              </Button>
            </Link>
            <Link href="/payroll">
              <Button variant="ghost" size="sm">
                Back to overview
              </Button>
            </Link>
          </div>
        </div>
      ) : nothingToRun ? (
        <div className="glass-card rounded-xl p-10 text-center space-y-3">
          <div
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted"
            aria-hidden="true"
          >
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold text-foreground">
            No employees to run
          </h3>
          <p className="text-sm text-muted-foreground">
            Add active employees before running payroll.
          </p>
          <div className="pt-2">
            <Link href="/payroll/employees">
              <Button>Manage employees</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {preview.items.map((item) => (
            <RunRow
              key={itemKey(item)}
              item={item}
              state={rows[itemKey(item)] ?? initialRowState(item)}
              onChange={(patch) => updateRow(itemKey(item), patch)}
              onAddExtra={() => handleAddExtra(itemKey(item))}
              onRemoveExtra={(xid) => handleRemoveExtra(itemKey(item), xid)}
              onExtraChange={(xid, field, value) =>
                handleExtraChange(itemKey(item), xid, field, value)
              }
              onExtraCategoryChange={(xid, category) =>
                handleExtraCategoryChange(itemKey(item), xid, category)
              }
            />
          ))}
        </div>
      )}

      {/* Footer action */}
      {preview.items.length > 0 && (
        <div className="glass-card rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 flex-wrap text-sm">
            <span className="text-muted-foreground">
              {selectedCount} of {preview.items.length} selected
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Net
              </span>
              <span className="font-mono font-semibold text-success">
                <MaskedValue value={formatCurrency(totals.net)} />
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Total cost
              </span>
              <span className="font-mono font-semibold text-foreground">
                <MaskedValue value={formatCurrency(totals.totalCost)} />
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/payroll">
              <Button variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </Link>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={submitting || selectedCount === 0}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4 mr-1" aria-hidden="true" />
              )}
              Approve payroll ({selectedCount})
            </Button>
          </div>
        </div>
      )}

      <ConfirmationDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Approve ${selectedCount} pay run${selectedCount === 1 ? "" : "s"}?`}
        description={<ApproveDialogBody count={selectedCount} />}
        confirmLabel="Approve"
        variant="default"
        onConfirm={handleRun}
      />
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface RunRowProps {
  item: PreviewRunItem;
  state: RowState;
  onChange: (patch: Partial<RowState>) => void;
  onAddExtra: () => void;
  onRemoveExtra: (extraId: string) => void;
  onExtraChange: (
    extraId: string,
    field: "label" | "amount",
    value: string,
  ) => void;
  onExtraCategoryChange: (
    extraId: string,
    category: WithholdingCategory,
  ) => void;
}

function RunRow({
  item,
  state,
  onChange,
  onAddExtra,
  onRemoveExtra,
  onExtraChange,
  onExtraCategoryChange,
}: RunRowProps) {
  const display = effectiveDisplay(item, state);
  const [grossEditing, setGrossEditing] = React.useState(false);
  const grossOverridden =
    state.overrideGross.trim() !== "" &&
    Number(state.overrideGross) !== item.calculated.gross_pay &&
    !Number.isNaN(Number(state.overrideGross));

  const taxesEmployee =
    display.federal_income_tax +
    display.state_income_tax +
    display.social_security_employee +
    display.medicare_employee +
    display.additional_medicare +
    display.state_disability_employee;

  const taxesEmployer =
    display.social_security_employer +
    display.medicare_employer +
    display.futa +
    display.suta +
    display.state_disability_employer;

  return (
    <div
      className={cn(
        "glass-card rounded-xl p-4 transition-opacity",
        !state.include && "opacity-50",
      )}
    >
      <div className="flex items-center gap-4 flex-wrap">
        <Checkbox
          checked={state.include}
          onChange={(next) => onChange({ include: next })}
          aria-label={`Include ${item.employee.first_name} ${item.employee.last_name}`}
        />

        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-semibold text-sm flex-shrink-0">
          {initials(item.employee.first_name, item.employee.last_name)}
        </div>

        <div className="flex-1 min-w-[200px] space-y-1">
          <div className="font-medium text-foreground">
            {item.employee.first_name} {item.employee.last_name}
          </div>
          <div className="text-xs text-muted-foreground">
            {item.period.period_start} - {item.period.period_end}
            {" - "}
            pays {item.period.pay_date}
          </div>
        </div>

        {/* Gross */}
        <div className="flex flex-col gap-0.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Gross
          </div>
          {grossEditing ? (
            <NumberInput
              value={
                state.overrideGross !== ""
                  ? state.overrideGross
                  : item.calculated.gross_pay.toFixed(2)
              }
              onChange={(e) => onChange({ overrideGross: e.target.value })}
              onBlur={() => setGrossEditing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder={item.calculated.gross_pay.toFixed(2)}
              className="w-28"
              autoFocus
              aria-label="Gross override"
            />
          ) : (
            <div className="flex items-center gap-1.5 h-9">
              <span
                className={cn(
                  "font-mono font-medium",
                  grossOverridden ? "text-warning" : "text-foreground",
                )}
              >
                <MaskedValue value={formatCurrency(display.gross_pay)} />
              </span>
              <button
                type="button"
                onClick={() => setGrossEditing(true)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label={
                  grossOverridden
                    ? "Edit gross override"
                    : "Override calculated gross"
                }
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )}
          {grossOverridden && !grossEditing && (
            <span className="text-[10px] text-warning uppercase tracking-wider font-semibold">
              Override
            </span>
          )}
        </div>

        {/* Read-out column */}
        <div className="flex flex-col items-end gap-0.5 min-w-[140px]">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Net pay
          </div>
          {display.grossIsDirty ? (
            <>
              <div className="font-mono font-semibold text-muted-foreground">
                -
              </div>
              <div className="text-xs text-warning">
                recomputes on run
              </div>
            </>
          ) : (
            <>
              <div className="font-mono font-semibold text-foreground">
                <MaskedValue value={formatCurrency(display.net_pay)} />
              </div>
              <div className="text-xs text-muted-foreground">
                taxes{" "}
                <span className="font-mono">
                  <MaskedValue value={formatCurrency(taxesEmployee)} />
                </span>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => onChange({ expanded: !state.expanded })}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-expanded={state.expanded}
          aria-label={state.expanded ? "Collapse details" : "Expand details"}
        >
          {state.expanded ? (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Notices */}
      {item.notices.length > 0 && (
        <div className="mt-2 pl-12 space-y-1">
          {item.notices.map((n, i) => (
            <p key={i} className="text-xs text-warning">
              {n}
            </p>
          ))}
        </div>
      )}

      {state.expanded && (
        <div className="mt-4 pt-4 border-t border-border space-y-4">
          {display.grossIsDirty ? (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm space-y-1">
              <p className="text-warning font-medium">
                Preview numbers are stale
              </p>
              <p className="text-muted-foreground">
                Gross overrides or pre-tax deductions change taxable-wage
                bases; the server recomputes FIT/FICA/FUTA and net pay
                against{" "}
                <span className="font-mono text-foreground">
                  {formatCurrency(display.gross_pay)}
                </span>{" "}
                when you click Approve payroll.
              </p>
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Employee deductions
                  </h4>
                  <span className="font-mono text-sm font-semibold text-foreground">
                    <MaskedValue value={formatCurrency(taxesEmployee)} />
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <Breakdown
                    label={<Term slug="fit">Federal income tax</Term>}
                    amount={display.federal_income_tax}
                  />
                  <Breakdown
                    label={<Term slug="sit">State income tax</Term>}
                    amount={display.state_income_tax}
                  />
                  <Breakdown
                    label={<Term slug="fica">Social Security (EE)</Term>}
                    amount={display.social_security_employee}
                  />
                  <Breakdown
                    label={<Term slug="fica">Medicare (EE)</Term>}
                    amount={display.medicare_employee}
                  />
                  {display.additional_medicare > 0 && (
                    <Breakdown
                      label="Add. Medicare (EE)"
                      amount={display.additional_medicare}
                    />
                  )}
                  {display.state_disability_employee > 0 && (
                    <Breakdown
                      label={<Term slug="sdi">State SDI (EE)</Term>}
                      amount={display.state_disability_employee}
                    />
                  )}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Employer contributions
                    </h4>
                    <span className="text-[11px] text-muted-foreground">
                      not deducted from pay
                    </span>
                  </div>
                  <span className="font-mono text-sm font-semibold text-foreground">
                    <MaskedValue value={formatCurrency(taxesEmployer)} />
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <Breakdown
                    label={<Term slug="fica">Social Security (ER)</Term>}
                    amount={display.social_security_employer}
                  />
                  <Breakdown
                    label={<Term slug="fica">Medicare (ER)</Term>}
                    amount={display.medicare_employer}
                  />
                  <Breakdown
                    label={<Term slug="futa">FUTA</Term>}
                    amount={display.futa}
                  />
                  <Breakdown
                    label={<Term slug="suta">SUTA</Term>}
                    amount={display.suta}
                  />
                  {display.state_disability_employer > 0 && (
                    <Breakdown
                      label={<Term slug="sdi">State SDI (ER)</Term>}
                      amount={display.state_disability_employer}
                    />
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-secondary/30 p-3 flex items-center justify-between text-sm">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total cost for this employee
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Gross pay plus employer taxes
                  </div>
                </div>
                <span className="font-mono text-base font-bold text-foreground">
                  <MaskedValue
                    value={formatCurrency(display.gross_pay + taxesEmployer)}
                  />
                </span>
              </div>
            </>
          )}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Withholdings &amp; deductions
              </h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={onAddExtra}
                type="button"
              >
                Add line
              </Button>
            </div>
            {state.extraItems.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No additional deductions for this run.
              </p>
            ) : (
              <div className="space-y-2">
                {state.extraItems.map((extra) => (
                  <div
                    key={extra.id}
                    className="flex flex-wrap items-start gap-2"
                  >
                    <Input
                      value={extra.label}
                      onChange={(e) =>
                        onExtraChange(extra.id, "label", e.target.value)
                      }
                      placeholder="Label (e.g. 401k contribution)"
                      className="flex-1 min-w-[180px]"
                    />
                    <NumberInput
                      value={extra.amount}
                      onChange={(e) =>
                        onExtraChange(extra.id, "amount", e.target.value)
                      }
                      placeholder="0.00"
                      className="w-28"
                      aria-label="Amount"
                    />
                    <CustomSelect
                      value={extra.category}
                      onChange={(next) =>
                        onExtraCategoryChange(
                          extra.id,
                          next as WithholdingCategory,
                        )
                      }
                      options={CATEGORY_OPTIONS}
                      className="min-w-[220px]"
                      aria-label="Withholding category"
                    />
                    <button
                      type="button"
                      onClick={() => onRemoveExtra(extra.id)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Pre-tax §125 (health, HSA via cafeteria, FSA) reduces all
              federal taxes and most state taxes. Pre-tax 401(k) reduces
              FIT/SIT only - FICA and FUTA still apply. Post-tax deductions
              (Roth 401(k), garnishments) reduce net pay only.
            </p>
          </div>
          <div className="text-xs text-muted-foreground">
            <Term slug="ytd">YTD</Term> gross before this run:{" "}
            <span className="font-mono text-foreground">
              <MaskedValue value={formatCurrency(item.ytd.grossYtd)} />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(first: string, last: string): string {
  return `${(first || "").charAt(0)}${(last || "").charAt(0)}`.toUpperCase() || "?";
}

/** Compute effective display numbers for a row given the user's overrides.
 *
 *  Extra post-tax deductions are safe to apply locally (they subtract from
 *  net_pay without touching taxable wages), so we fold those in.
 *
 *  A gross override is NOT safe to apply locally: federal brackets, the FICA
 *  wage-base cap, and the Additional Medicare $200k threshold are all
 *  non-linear in gross. Scaling the preview values would produce numbers
 *  that disagree with the server-side engine and could mislead the admin.
 *  When the gross is dirty we mark the row so the UI can hide the stale tax
 *  lines and advise that totals will be recomputed by createDraftRun. */
interface EffectiveDisplay extends CalculatedRun {
  /** User changed gross from the server-previewed value OR added pre-tax
   *  extras the server hasn't seen yet. Tax lines are stale; consumers
   *  should hide them and show a "recomputes on run" hint. */
  grossIsDirty: boolean;
  /** Post-tax extras total, subtracted from net_pay when not dirty. */
  extraTotal: number;
}

function effectiveDisplay(
  item: PreviewRunItem,
  state: RowState,
): EffectiveDisplay {
  const serverGross = item.calculated.gross_pay;
  const override =
    state.overrideGross.trim() !== "" ? Number(state.overrideGross) : null;
  const grossOverridden =
    override != null && !Number.isNaN(override) && override !== serverGross;

  // Pre-tax extras change the taxable-wage bases the server used in the
  // preview. We can't recompute FIT/FICA/FUTA locally without the tax
  // brackets and caps, so flag the row as dirty and let finalize refresh.
  const hasPreTaxExtras = state.extraItems.some(
    (e) =>
      Number(e.amount) > 0 &&
      (e.category === "pre_tax_401k" || e.category === "pre_tax_125"),
  );

  const extraTotal = state.extraItems.reduce((sum, e) => {
    const amt = Number(e.amount);
    return sum + (Number.isFinite(amt) ? Math.max(0, amt) : 0);
  }, 0);

  const dirty = grossOverridden || hasPreTaxExtras;

  if (dirty) {
    // Show the gross the admin typed so they can review it, but keep all
    // other fields as the original server preview - consumers must treat
    // them as stale and skip or hide them.
    return {
      ...item.calculated,
      gross_pay: grossOverridden
        ? Math.max(0, override as number)
        : item.calculated.gross_pay,
      grossIsDirty: true,
      extraTotal,
    };
  }

  return {
    ...item.calculated,
    net_pay: Math.max(0, item.calculated.net_pay - extraTotal),
    grossIsDirty: false,
    extraTotal,
  };
}

function Breakdown({
  label,
  amount,
}: {
  label: React.ReactNode;
  amount: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-foreground">
        <MaskedValue value={formatCurrency(amount)} />
      </span>
    </div>
  );
}

function SummaryLine({
  label,
  amount,
  prefix,
}: {
  label: string;
  amount: number;
  prefix?: "-" | "+";
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">
        {prefix && <span className="text-muted-foreground mr-1">{prefix}</span>}
        <MaskedValue value={formatCurrency(Math.abs(amount))} />
      </span>
    </div>
  );
}

// ─── Approve dialog body ─────────────────────────────────────────────────────

function ApproveDialogBody({ count }: { count: number }) {
  return (
    <div className="space-y-3 text-left">
      <p>
        Approving{" "}
        <span className="font-semibold text-foreground">
          {count} pay run{count === 1 ? "" : "s"}
        </span>{" "}
        does three things:
      </p>
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
