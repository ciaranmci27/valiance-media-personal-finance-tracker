"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Eye,
  EyeOff,
  Loader2,
  Save,
  Trash2,
  User,
  UserCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import { FILING_STATUS_LABELS } from "@/lib/tax/constants";
import {
  createEmployee,
  updateEmployee,
  softDeleteEmployee,
  revealEmployeeSsn,
  type EmployeeFormInput,
} from "@/lib/payroll/actions";
import {
  getPayPeriodsInRange,
  dateUtils,
  type PayScheduleInput,
} from "@/lib/payroll/schedule";
import type {
  EmployeeStateElection,
  EmployeeStatus,
  EmploymentType,
  FilingStatus,
  PayFrequency,
  PayrollAddress,
  PayrollEmployee,
  StateTaxConfig,
} from "@/types/payroll";
import { cn } from "@/lib/utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAY_FREQUENCY_OPTIONS: { value: PayFrequency; label: string }[] = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly (every 2 weeks)" },
  { value: "semimonthly", label: "Semimonthly (2x per month)" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

const FILING_STATUS_OPTIONS = (
  Object.entries(FILING_STATUS_LABELS) as [FilingStatus, string][]
).map(([value, label]) => ({ value, label }));

const EMPLOYMENT_TYPE_OPTIONS: { value: EmploymentType; label: string }[] = [
  { value: "w2", label: "W-2 Employee" },
  { value: "1099", label: "1099 Contractor" },
];

const STATUS_OPTIONS: { value: EmployeeStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "terminated", label: "Terminated" },
];

// Day-of-month dropdown. "31" displays as "Last day of month" because the
// schedule engine rolls it back to whatever the month's actual last day is
// (Feb 28/29, Apr 30, etc). `ordinal` is hoisted from the schedule-preview
// helpers further down.
const DAY_OF_MONTH_OPTIONS: { value: string; label: string }[] = (() => {
  const out: { value: string; label: string }[] = [];
  for (let i = 1; i <= 31; i += 1) {
    out.push({
      value: String(i),
      label: i === 31 ? "Last day of month" : ordinal(i),
    });
  }
  return out;
})();

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  /** null -> create mode, employee -> edit mode */
  initial: PayrollEmployee | null;
  /** For rendering the correct state-election sub-fields. */
  stateConfigs: StateTaxConfig[];
}

interface FormState {
  // Personal
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: PayrollAddress;

  // Employment
  employment_type: EmploymentType;
  hire_date: string;
  termination_date: string;
  status: EmployeeStatus;

  // Pay config
  pay_amount: string;
  pay_frequency: PayFrequency;
  pay_anchor_date: string;
  /** User-facing "pay on this weekday" for weekly/biweekly; derived from
   *  pay_anchor_date in edit mode. The stored anchor remains the source of
   *  truth for calculations. */
  pay_weekday: Weekday;
  semimonthly_day_1: string;
  semimonthly_day_2: string;
  monthly_day: string;
  pay_lag_days: string;
  target_annual_comp: string;

  // W-4
  w4_filing_status: FilingStatus;
  w4_multiple_jobs: boolean;
  w4_exempt: boolean;
  w4_dependents_amount: string;
  w4_other_income: string;
  w4_deductions: string;
  w4_extra_withholding: string;

  // State election
  state_code: string;
  state_config: EmployeeStateElection;

  notes: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_ADDRESS: PayrollAddress = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",
};

function toAddress(value: unknown): PayrollAddress {
  const a = (value && typeof value === "object" ? value : {}) as Partial<PayrollAddress>;
  return {
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    zip: a.zip ?? "",
  };
}

function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function initialFormState(initial: PayrollEmployee | null): FormState {
  if (!initial) {
    return {
      first_name: "",
      last_name: "",
      email: "",
      phone: "",
      address: { ...EMPTY_ADDRESS },
      employment_type: "w2",
      hire_date: today(),
      termination_date: "",
      status: "active",
      pay_amount: "",
      pay_frequency: "biweekly",
      pay_anchor_date: nextWeekdayOnOrAfter(today(), "friday"),
      pay_weekday: "friday",
      semimonthly_day_1: "15",
      semimonthly_day_2: "31",
      monthly_day: "15",
      pay_lag_days: "0",
      target_annual_comp: "",
      w4_filing_status: "single",
      w4_multiple_jobs: false,
      w4_exempt: false,
      w4_dependents_amount: "0",
      w4_other_income: "0",
      w4_deductions: "0",
      w4_extra_withholding: "0",
      state_code: "",
      state_config: {},
      notes: "",
    };
  }

  const [sd1 = 15, sd2 = 31] = initial.semimonthly_days ?? [];
  return {
    first_name: initial.first_name,
    last_name: initial.last_name,
    email: initial.email ?? "",
    phone: initial.phone ?? "",
    address: toAddress(initial.address),
    employment_type: initial.employment_type,
    hire_date: initial.hire_date,
    termination_date: initial.termination_date ?? "",
    status: initial.status,
    pay_amount: String(initial.pay_amount ?? ""),
    pay_frequency: initial.pay_frequency,
    pay_anchor_date: initial.pay_anchor_date,
    pay_weekday: weekdayFromYmd(initial.pay_anchor_date),
    semimonthly_day_1: String(sd1),
    semimonthly_day_2: String(sd2),
    monthly_day: String(initial.monthly_day ?? 15),
    pay_lag_days: String(initial.pay_lag_days ?? 0),
    target_annual_comp:
      initial.target_annual_comp == null
        ? ""
        : String(initial.target_annual_comp),
    w4_filing_status: initial.w4_filing_status,
    w4_multiple_jobs: initial.w4_multiple_jobs,
    w4_exempt: initial.w4_exempt ?? false,
    w4_dependents_amount: String(initial.w4_dependents_amount ?? 0),
    w4_other_income: String(initial.w4_other_income ?? 0),
    w4_deductions: String(initial.w4_deductions ?? 0),
    w4_extra_withholding: String(initial.w4_extra_withholding ?? 0),
    state_code: initial.state_code,
    state_config: initial.state_config,
    notes: initial.notes ?? "",
  };
}

function currentYear(): number {
  return new Date().getUTCFullYear();
}

// ─── Schedule-derivation helpers ──────────────────────────────────────────────
// These translate Gusto-style user intent ("pay on the 15th", "pay every Friday")
// into the pay_anchor_date the calculation engine expects. The data model is
// unchanged: we just hide pay_anchor_date from the UI and derive it on the fly.

type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const WEEKDAY_FROM_INDEX: Record<number, Weekday> = {
  0: "sunday",
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
};

const WEEKDAY_OPTIONS: { value: Weekday; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

function weekdayFromYmd(ymd: string): Weekday {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "friday";
  const [y, m, d] = ymd.split("-").map(Number);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAY_FROM_INDEX[idx];
}

function daysInUtcMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function nextWeekdayOnOrAfter(startYmd: string, weekday: Weekday): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startYmd)) return startYmd;
  const [y, m, d] = startYmd.split("-").map(Number);
  const target = WEEKDAY_INDEX[weekday];
  const base = new Date(Date.UTC(y, m - 1, d));
  const diff = (target - base.getUTCDay() + 7) % 7;
  const next = new Date(base.getTime() + diff * 86_400_000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Build a valid pay_anchor_date from a "pay day of month" (1-31) and a
 * reference date (usually hire_date). Uses the reference month's occurrence
 * of that day, rolling back to the last day of the month when the month is
 * shorter than the requested day (Feb 31 -> Feb 28/29, Apr 31 -> Apr 30).
 */
function anchorForDayOfMonth(referenceYmd: string, day: number): string {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(referenceYmd) ? referenceYmd : today();
  const [y, m] = base.split("-").map(Number);
  const safeDay = Math.max(1, Math.min(31, day || 15));
  const capped = Math.min(safeDay, daysInUtcMonth(y, m));
  return `${y}-${String(m).padStart(2, "0")}-${String(capped).padStart(2, "0")}`;
}

/**
 * Reconcile pay_anchor_date with the user-facing inputs. Only returns a new
 * anchor when the current one is INCONSISTENT with the user's intent. This
 * prevents silent DB mutations in edit mode when the admin opens a form,
 * doesn't change anything, and clicks save.
 *
 * "Consistent" means:
 *   - Weekly: current anchor's weekday equals pay_weekday
 *   - Monthly: current anchor's day-of-month equals monthly_day (or matches
 *     the rolled-back "last day" semantics when monthly_day = 31)
 *   - Semimonthly: current anchor's day-of-month equals sd1 (with same
 *     last-day semantics)
 *   - Biweekly / annual: user picks the anchor directly, never override
 */
function reconcileAnchor(form: FormState): string {
  switch (form.pay_frequency) {
    case "biweekly":
    case "annual":
      return form.pay_anchor_date;

    case "weekly": {
      if (weekdayFromYmd(form.pay_anchor_date) === form.pay_weekday) {
        return form.pay_anchor_date;
      }
      return nextWeekdayOnOrAfter(
        form.hire_date || today(),
        form.pay_weekday,
      );
    }

    case "monthly": {
      const requested = Math.max(1, Math.min(31, Number(form.monthly_day) || 15));
      if (anchorDayMatches(form.pay_anchor_date, requested)) {
        return form.pay_anchor_date;
      }
      return anchorForDayOfMonth(form.hire_date || today(), requested);
    }

    case "semimonthly": {
      const sd1 = Math.max(1, Math.min(31, Number(form.semimonthly_day_1) || 15));
      const sd2 = Math.max(1, Math.min(31, Number(form.semimonthly_day_2) || 31));
      // Anchor is valid if it falls on EITHER pay day (the engine treats the
      // two days symmetrically; any occurrence of either day is a valid
      // starting reference).
      if (
        anchorDayMatches(form.pay_anchor_date, sd1) ||
        anchorDayMatches(form.pay_anchor_date, sd2)
      ) {
        return form.pay_anchor_date;
      }
      // Current anchor doesn't match either day; re-derive from the earlier
      // of the two in the hire-month.
      return anchorForDayOfMonth(
        form.hire_date || today(),
        Math.min(sd1, sd2),
      );
    }
  }
}

/**
 * True iff `ymd`'s day-of-month equals `requestedDay`, honoring the
 * "31 means last day" convention (so requestedDay=31 matches Feb 28, Apr 30,
 * etc).
 */
function anchorDayMatches(ymd: string, requestedDay: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, m, d] = ymd.split("-").map(Number);
  if (d === requestedDay) return true;
  if (requestedDay === 31 && d === daysInUtcMonth(y, m)) return true;
  return false;
}

/**
 * Subtract N business days from a YYYY-MM-DD date. Used for the "approve by"
 * reminder: ACH requires ~2 banking days of lead time. This ignores federal
 * holidays (close-enough for a reminder; if it happens to land on a holiday
 * the user will notice and approve a day earlier).
 */
function subtractBusinessDays(ymd: string, n: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  let remaining = n;
  while (remaining > 0) {
    date = new Date(date.getTime() - 86_400_000);
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Pick the most recent state_tax_config for the given state; null if none. */
function findStateConfig(
  stateConfigs: StateTaxConfig[],
  stateCode: string,
): StateTaxConfig | null {
  if (!stateCode) return null;
  const matches = stateConfigs.filter((c) => c.state_code === stateCode);
  if (matches.length === 0) return null;
  return matches.reduce((best, c) =>
    c.tax_year > best.tax_year ? c : best,
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EmployeeFormContent({ initial, stateConfigs }: Props) {
  const router = useRouter();
  const isEdit = initial !== null;

  const [form, setForm] = React.useState<FormState>(() =>
    initialFormState(initial),
  );

  // SSN handling: separate from form state so we can distinguish
  // "user hasn't touched it" (undefined) from "user cleared it" ("").
  const [ssnInput, setSsnInput] = React.useState<string>(""); // plaintext being typed now
  const [editingSsn, setEditingSsn] = React.useState(!isEdit); // new mode defaults to typing
  const [revealedSsn, setRevealedSsn] = React.useState<string | null>(null);
  const [revealing, setRevealing] = React.useState(false);
  // While typing a new or replacement SSN, default to masked input so the
  // digits aren't visible to anyone glancing at the screen. User can toggle.
  const [showSsnInput, setShowSsnInput] = React.useState(false);
  const hasExistingSsn = !!initial?.ssn_encrypted;

  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  // Keep pay_anchor_date (the stored value, used by all calculations) in
  // lockstep with the user-facing inputs. Key correctness rule: only override
  // when the existing anchor is INCONSISTENT with the user's intent. Multiple
  // valid anchors exist for the same schedule (any Friday works for "weekly
  // on Fridays"), so re-deriving every time would silently mutate stored
  // values on mount in edit mode even when nothing user-meaningful changed.
  React.useEffect(() => {
    setForm((prev) => {
      const nextAnchor = reconcileAnchor(prev);
      if (nextAnchor === prev.pay_anchor_date) return prev;
      return { ...prev, pay_anchor_date: nextAnchor };
    });
  }, [
    form.pay_frequency,
    form.pay_weekday,
    form.monthly_day,
    form.semimonthly_day_1,
    form.semimonthly_day_2,
    form.hire_date,
  ]);

  const updateAddress = (patch: Partial<PayrollAddress>) =>
    setForm((prev) => ({ ...prev, address: { ...prev.address, ...patch } }));

  const updateStateConfig = (patch: Partial<EmployeeStateElection>) =>
    setForm((prev) => ({
      ...prev,
      state_config: { ...prev.state_config, ...patch },
    }));

  // Clear state_config when state changes (the shape may not apply).
  const handleStateChange = (value: string) => {
    setForm((prev) => ({
      ...prev,
      state_code: value,
      state_config: {},
    }));
  };

  const stateConfig = React.useMemo(
    () => findStateConfig(stateConfigs, form.state_code),
    [stateConfigs, form.state_code],
  );

  // ── SSN handlers ──────────────────────────────────────────────────────────

  const handleRevealSsn = async () => {
    if (!initial) return;
    setRevealing(true);
    const result = await revealEmployeeSsn(initial.id);
    setRevealing(false);
    if (!result.ok || !result.data) {
      toast("error", result.error ?? "Failed to reveal SSN");
      return;
    }
    setRevealedSsn(result.data.ssn);
  };

  const handleHideSsn = () => setRevealedSsn(null);

  // ── Save ──────────────────────────────────────────────────────────────────

  const buildPayload = (): EmployeeFormInput => {
    const semimonthly_days =
      form.pay_frequency === "semimonthly"
        ? (() => {
            // Engine contract (schedule.ts): semimonthly_days = [a, b] with
            // a < b. Sort here so the user can pick the two days in any order
            // without breaking downstream pay-date generation.
            const a = Math.max(
              1,
              Math.min(31, Number(form.semimonthly_day_1) || 15),
            );
            const b = Math.max(
              1,
              Math.min(31, Number(form.semimonthly_day_2) || 31),
            );
            return a === b ? [a, b] : [Math.min(a, b), Math.max(a, b)];
          })()
        : null;

    const monthly_day =
      form.pay_frequency === "monthly"
        ? Math.max(1, Math.min(31, Number(form.monthly_day) || 15))
        : null;

    // Only include SSN in payload if the user edited it.
    // `editingSsn=true` + `ssnInput=""` on edit mode means "clear it";
    // `editingSsn=false` means "leave ssn_encrypted alone".
    let ssnField: string | null | undefined;
    if (!isEdit) {
      // create mode: always pass (may be empty -> stored as null)
      ssnField = ssnInput.trim() || null;
    } else if (editingSsn) {
      ssnField = ssnInput.trim() === "" ? null : ssnInput.trim();
    } else {
      ssnField = undefined; // leave unchanged
    }

    return {
      first_name: form.first_name,
      last_name: form.last_name,
      email: form.email || null,
      phone: form.phone || null,
      address: form.address,
      ssn: ssnField,
      employment_type: form.employment_type,
      hire_date: form.hire_date,
      termination_date: form.termination_date || null,
      status: form.status,
      pay_amount: Number(form.pay_amount) || 0,
      pay_frequency: form.pay_frequency,
      pay_anchor_date: form.pay_anchor_date,
      semimonthly_days,
      monthly_day,
      pay_lag_days: Number(form.pay_lag_days) || 0,
      target_annual_comp:
        form.target_annual_comp === "" ? null : Number(form.target_annual_comp),
      w4_filing_status: form.w4_filing_status,
      w4_multiple_jobs: form.w4_multiple_jobs,
      w4_exempt: form.w4_exempt,
      w4_dependents_amount: Number(form.w4_dependents_amount) || 0,
      w4_other_income: Number(form.w4_other_income) || 0,
      w4_deductions: Number(form.w4_deductions) || 0,
      w4_extra_withholding: Number(form.w4_extra_withholding) || 0,
      state_code: form.state_code,
      state_config: form.state_config,
      notes: form.notes,
    };
  };

  const handleSave = async () => {
    if (saving) return;

    // Guard against semimonthly configurations where both pay days are the
    // same. The engine would generate duplicate pay dates; blocking here
    // gives the admin a clear error rather than silently producing garbage.
    if (
      form.pay_frequency === "semimonthly" &&
      Number(form.semimonthly_day_1) === Number(form.semimonthly_day_2)
    ) {
      toast(
        "error",
        "Semimonthly requires two different pay days each month.",
      );
      return;
    }

    setSaving(true);
    try {
      const payload = buildPayload();

      if (isEdit && initial) {
        const result = await updateEmployee(initial.id, payload);
        if (!result.ok) {
          toast("error", result.error ?? "Failed to update employee");
          return;
        }
        toast("success", "Employee updated");
        setSsnInput("");
        setEditingSsn(false);
        setRevealedSsn(null);
        router.refresh();
      } else {
        const result = await createEmployee(payload);
        if (!result.ok || !result.data) {
          toast("error", result.error ?? "Failed to create employee");
          return;
        }
        toast("success", "Employee created");
        router.push(`/payroll/employees/${result.data.id}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!initial) return;
    setDeleting(true);
    const result = await softDeleteEmployee(initial.id);
    setDeleting(false);
    if (!result.ok) {
      toast("error", result.error ?? "Failed to delete employee");
      return;
    }
    toast("success", "Employee removed");
    router.push("/payroll/employees");
    router.refresh();
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <UserCircle className="h-5 w-5 text-primary" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">
                {isEdit
                  ? `${initial?.first_name} ${initial?.last_name}`
                  : "Add Employee"}
              </h1>
              <p className="text-sm text-muted-foreground">
                {isEdit
                  ? "Edit pay configuration, W-4, and state election"
                  : "Full W-4 and pay configuration for a new hire"}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isEdit && (
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
              className="text-error hover:text-error"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" aria-hidden="true" />
              )}
              Delete
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="h-4 w-4 mr-1" aria-hidden="true" />
            )}
            {isEdit ? "Save Changes" : "Create Employee"}
          </Button>
        </div>
      </div>

      {/* Personal */}
      <Section title="Personal">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="First Name"
            value={form.first_name}
            onChange={(e) => update("first_name", e.target.value)}
            placeholder="Jane"
          />
          <Input
            label="Last Name"
            value={form.last_name}
            onChange={(e) => update("last_name", e.target.value)}
            placeholder="Doe"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Email (optional)"
            type="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="jane@example.com"
          />
          <Input
            label="Phone (optional)"
            type="tel"
            value={form.phone}
            onChange={(e) => update("phone", e.target.value)}
            placeholder="(555) 555-5555"
          />
        </div>

        {/* SSN */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Social Security Number
          </label>
          {isEdit && !editingSsn ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 font-mono text-sm text-muted-foreground bg-input rounded-lg px-3 py-2 border border-border">
                {revealedSsn ?? (hasExistingSsn ? "•••-••-••••" : "No SSN on file")}
              </div>
              {hasExistingSsn && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={revealedSsn ? handleHideSsn : handleRevealSsn}
                  disabled={revealing}
                >
                  {revealing ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : revealedSsn ? (
                    <EyeOff className="h-4 w-4 mr-1" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4 mr-1" aria-hidden="true" />
                  )}
                  {revealedSsn ? "Hide" : "Reveal"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingSsn(true);
                  setSsnInput("");
                  setRevealedSsn(null);
                }}
              >
                {hasExistingSsn ? "Change" : "Add"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                value={ssnInput}
                onChange={(e) =>
                  setSsnInput(e.target.value.replace(/\D/g, "").slice(0, 9))
                }
                placeholder="9 digits, no dashes"
                inputMode="numeric"
                type={showSsnInput ? "text" : "password"}
                autoComplete="off"
                className="flex-1"
                rightIcon={
                  showSsnInput ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )
                }
                onRightIconClick={() => setShowSsnInput((v) => !v)}
                rightIconLabel={
                  showSsnInput ? "Hide social security number" : "Show social security number"
                }
              />
              {isEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingSsn(false);
                    setSsnInput("");
                    setShowSsnInput(false);
                  }}
                >
                  <X className="h-4 w-4 mr-1" aria-hidden="true" />
                  Cancel
                </Button>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Encrypted with AES-256-GCM before storage. Required for W-2 output.
          </p>
        </div>
      </Section>

      {/* Address */}
      <Section title="Mailing Address">
        <Input
          label="Address Line 1 (optional)"
          value={form.address.line1}
          onChange={(e) => updateAddress({ line1: e.target.value })}
          placeholder="123 Main St"
        />
        <Input
          label="Address Line 2 (optional)"
          value={form.address.line2 ?? ""}
          onChange={(e) => updateAddress({ line2: e.target.value })}
          placeholder="Apt 4B"
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="City"
            value={form.address.city}
            onChange={(e) => updateAddress({ city: e.target.value })}
            placeholder="Phoenix"
          />
          <CustomSelect
            label="State"
            value={form.address.state}
            onChange={(val) => updateAddress({ state: val })}
            options={STATE_OPTIONS}
            placeholder="Select"
          />
          <Input
            label="ZIP"
            value={form.address.zip}
            onChange={(e) => updateAddress({ zip: e.target.value })}
            inputMode="numeric"
            placeholder="85001"
          />
        </div>
      </Section>

      {/* Employment */}
      <Section title="Employment">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CustomSelect
            label="Type"
            value={form.employment_type}
            onChange={(v) => update("employment_type", v as EmploymentType)}
            options={EMPLOYMENT_TYPE_OPTIONS}
          />
          <CustomSelect
            label="Status"
            value={form.status}
            onChange={(v) => update("status", v as EmployeeStatus)}
            options={STATUS_OPTIONS}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <DateInput
            label="Hire Date"
            value={form.hire_date}
            onChange={(v) => update("hire_date", v)}
          />
          <DateInput
            label="Termination Date (optional)"
            value={form.termination_date}
            onChange={(v) => update("termination_date", v)}
            clearable
          />
        </div>
      </Section>

      {/* Pay Config */}
      <Section title="Pay Configuration">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput
            label="Pay Amount (per period)"
            value={form.pay_amount}
            onChange={(e) => update("pay_amount", e.target.value)}
            placeholder="0.00"
          />
          <CustomSelect
            label="How often are they paid?"
            value={form.pay_frequency}
            onChange={(v) => update("pay_frequency", v as PayFrequency)}
            options={PAY_FREQUENCY_OPTIONS}
          />
        </div>

        {form.pay_frequency === "weekly" && (
          <CustomSelect
            label="Pay day (every week)"
            value={form.pay_weekday}
            onChange={(v) => update("pay_weekday", v as Weekday)}
            options={WEEKDAY_OPTIONS}
          />
        )}

        {form.pay_frequency === "biweekly" && (
          <DateInput
            label="First pay date"
            value={form.pay_anchor_date}
            onChange={(v) => update("pay_anchor_date", v)}
          />
        )}

        {form.pay_frequency === "semimonthly" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CustomSelect
              label="First pay day of month"
              value={form.semimonthly_day_1}
              onChange={(v) => update("semimonthly_day_1", v)}
              options={DAY_OF_MONTH_OPTIONS}
            />
            <CustomSelect
              label="Second pay day of month"
              value={form.semimonthly_day_2}
              onChange={(v) => update("semimonthly_day_2", v)}
              options={DAY_OF_MONTH_OPTIONS}
            />
          </div>
        )}

        {form.pay_frequency === "monthly" && (
          <CustomSelect
            label="Pay day of month"
            value={form.monthly_day}
            onChange={(v) => update("monthly_day", v)}
            options={DAY_OF_MONTH_OPTIONS}
          />
        )}

        {form.pay_frequency === "annual" && (
          <DateInput
            label="Pay date each year"
            value={form.pay_anchor_date}
            onChange={(v) => update("pay_anchor_date", v)}
          />
        )}

        <NumberInput
          label="Target Annual Comp (optional, S Corp benchmark)"
          value={form.target_annual_comp}
          onChange={(e) => update("target_annual_comp", e.target.value)}
          placeholder="e.g. 80000"
        />

        <SchedulePreview
          pay_amount={form.pay_amount}
          pay_frequency={form.pay_frequency}
          pay_anchor_date={form.pay_anchor_date}
          monthly_day={form.monthly_day}
          semimonthly_day_1={form.semimonthly_day_1}
          semimonthly_day_2={form.semimonthly_day_2}
          pay_lag_days={form.pay_lag_days}
        />

        <AdvancedPaySettings
          pay_lag_days={form.pay_lag_days}
          onChange={(v) => update("pay_lag_days", v)}
        />
      </Section>

      {/* W-4 */}
      <Section title="Federal W-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CustomSelect
            label="Filing Status"
            value={form.w4_filing_status}
            onChange={(v) => update("w4_filing_status", v as FilingStatus)}
            options={FILING_STATUS_OPTIONS}
          />
          <div className="flex items-end pb-1">
            <Switch
              checked={form.w4_multiple_jobs}
              onChange={(v) => update("w4_multiple_jobs", v)}
              label="Step 2(c): Multiple jobs / spouse works"
            />
          </div>
        </div>

        <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
          <Switch
            checked={form.w4_exempt}
            onChange={(v) => update("w4_exempt", v)}
            label='Exempt: employee wrote "Exempt" below Step 4(c)'
          />
          {form.w4_exempt && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              Federal income tax withholding will be zero. FICA and FUTA still
              apply. IRS requires a fresh W-4 by February 15 each year to
              keep an exempt claim active.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput
            label="Step 3: Dependents Amount"
            value={form.w4_dependents_amount}
            onChange={(e) => update("w4_dependents_amount", e.target.value)}
            placeholder="0.00"
            disabled={form.w4_exempt}
          />
          <NumberInput
            label="Step 4(a): Other Income (annual)"
            value={form.w4_other_income}
            onChange={(e) => update("w4_other_income", e.target.value)}
            placeholder="0.00"
            disabled={form.w4_exempt}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput
            label="Step 4(b): Deductions (annual)"
            value={form.w4_deductions}
            onChange={(e) => update("w4_deductions", e.target.value)}
            placeholder="0.00"
            disabled={form.w4_exempt}
          />
          <NumberInput
            label="Step 4(c): Extra Withholding (per period)"
            value={form.w4_extra_withholding}
            onChange={(e) => update("w4_extra_withholding", e.target.value)}
            placeholder="0.00"
            disabled={form.w4_exempt}
          />
        </div>
      </Section>

      {/* State Election */}
      <Section title="State Withholding">
        <CustomSelect
          label="Work State"
          value={form.state_code}
          onChange={handleStateChange}
          options={STATE_OPTIONS}
          placeholder="Select state"
        />

        {form.state_code && (
          <StateElectionFields
            stateConfig={stateConfig}
            stateCode={form.state_code}
            taxYear={currentYear()}
            value={form.state_config}
            onChange={updateStateConfig}
          />
        )}
      </Section>

      {/* Notes */}
      <Section title="Notes">
        <Textarea
          value={form.notes}
          onChange={(e) => update("notes", e.target.value)}
          placeholder="Internal notes (not visible to the employee)"
          className="min-h-[100px]"
        />
      </Section>

      {/* Delete confirmation */}
      {initial && (
        <ConfirmationDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete this employee?"
          description={`${initial.first_name} ${initial.last_name} will be soft-deleted. Past payroll runs remain intact; future pay periods will skip them.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <div className="flex-1 h-px bg-border/50" />
      </div>
      <div className="glass-card rounded-xl p-5 space-y-4">{children}</div>
    </div>
  );
}

// ─── Schedule preview (plain-English summary + next 3 pay dates) ──────────────

const PERIODS_PER_YEAR_LOOKUP: Record<PayFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  annual: 1,
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatLongDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAY_NAMES[date.getUTCDay()];
  return `${weekday}, ${MONTH_NAMES_SHORT[m - 1]} ${d}, ${y}`;
}

function formatShortDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTH_NAMES_SHORT[m - 1]} ${d}`;
}

function cadenceDescription(
  frequency: PayFrequency,
  anchorYmd: string,
  monthlyDay: number,
  sd1: number,
  sd2: number,
): string {
  switch (frequency) {
    case "weekly":
    case "biweekly": {
      const [y, m, d] = anchorYmd.split("-").map(Number);
      const weekday = WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      return frequency === "weekly"
        ? `every ${weekday}`
        : `every other ${weekday}`;
    }
    case "semimonthly": {
      const low = Math.min(sd1, sd2);
      const high = Math.max(sd1, sd2);
      const lowLabel = low === 31 ? "last day" : ordinal(low);
      const highLabel = high === 31 ? "last day" : ordinal(high);
      return `on the ${lowLabel} and ${highLabel} of each month`;
    }
    case "monthly": {
      const label = monthlyDay === 31 ? "last day" : ordinal(monthlyDay);
      return `on the ${label} of each month`;
    }
    case "annual":
      return "once per year";
  }
}

interface SchedulePreviewProps {
  pay_amount: string;
  pay_frequency: PayFrequency;
  pay_anchor_date: string;
  monthly_day: string;
  semimonthly_day_1: string;
  semimonthly_day_2: string;
  pay_lag_days: string;
}

function SchedulePreview(props: SchedulePreviewProps) {
  const sameDayError =
    props.pay_frequency === "semimonthly" &&
    Number(props.semimonthly_day_1) === Number(props.semimonthly_day_2);

  const preview = React.useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(props.pay_anchor_date)) return null;
    if (
      props.pay_frequency === "semimonthly" &&
      Number(props.semimonthly_day_1) === Number(props.semimonthly_day_2)
    ) {
      return null;
    }

    const sd1 = Math.max(1, Math.min(31, Number(props.semimonthly_day_1) || 15));
    const sd2 = Math.max(1, Math.min(31, Number(props.semimonthly_day_2) || 31));
    const monthlyDay = Math.max(1, Math.min(31, Number(props.monthly_day) || 15));
    const lag = Math.max(0, Number(props.pay_lag_days) || 0);

    const scheduleInput: PayScheduleInput = {
      pay_frequency: props.pay_frequency,
      pay_anchor_date: props.pay_anchor_date,
      pay_lag_days: lag,
      semimonthly_days:
        props.pay_frequency === "semimonthly" ? [sd1, sd2] : null,
      monthly_day: props.pay_frequency === "monthly" ? monthlyDay : null,
    };

    const now = new Date();
    const from = dateUtils.addDays(now, -1);
    const to = dateUtils.addDays(now, 400);

    let periods;
    try {
      periods = getPayPeriodsInRange(scheduleInput, from, to).slice(0, 3);
    } catch {
      return null;
    }
    if (periods.length === 0) return null;

    const amount = Number(props.pay_amount) || 0;
    const annualized =
      amount * PERIODS_PER_YEAR_LOOKUP[props.pay_frequency];

    return {
      amount,
      annualized,
      cadence: cadenceDescription(
        props.pay_frequency,
        props.pay_anchor_date,
        monthlyDay,
        sd1,
        sd2,
      ),
      periods,
      lag,
    };
  }, [
    props.pay_amount,
    props.pay_frequency,
    props.pay_anchor_date,
    props.monthly_day,
    props.semimonthly_day_1,
    props.semimonthly_day_2,
    props.pay_lag_days,
  ]);

  if (sameDayError) {
    return (
      <div className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
        Semimonthly needs two different pay days each month — pick distinct
        values for the first and second pay day.
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground">
        Set a pay amount, frequency, and anchor date above to preview the
        schedule.
      </div>
    );
  }

  const freqWord = {
    weekly: "weekly",
    biweekly: "biweekly",
    semimonthly: "twice a month",
    monthly: "monthly",
    annual: "annually",
  }[props.pay_frequency];

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-primary">
          Schedule preview
        </div>
      </div>

      <p className="text-sm text-foreground leading-relaxed">
        {preview.amount > 0 ? (
          <>
            Paid{" "}
            <span className="font-semibold">{formatMoney(preview.amount)}</span>{" "}
            {freqWord} {preview.cadence} ({formatMoney(preview.annualized)}{" "}
            annualized).
          </>
        ) : (
          <>
            Paid {freqWord} {preview.cadence}.
          </>
        )}
        {preview.lag > 0 && (
          <>
            {" "}
            Each check arrives {preview.lag} day
            {preview.lag === 1 ? "" : "s"} after the work period ends.
          </>
        )}
      </p>

      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Next {preview.periods.length} pay date
          {preview.periods.length === 1 ? "" : "s"}
        </div>
        <ul className="text-sm space-y-1">
          {preview.periods.map((p) => {
            const approveBy = subtractBusinessDays(p.pay_date, 2);
            const todayStr = today();
            const approveIsPast = approveBy < todayStr;
            const payDateIsPast = p.pay_date < todayStr;
            return (
              <li key={p.pay_date} className="space-y-0.5">
                <div className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-foreground">
                    {formatLongDate(p.pay_date)}
                  </span>
                  <span className="text-muted-foreground">
                    — covers {formatShortDate(p.period_start)} to{" "}
                    {formatShortDate(p.period_end)}
                  </span>
                </div>
                {!payDateIsPast && !approveIsPast && (
                  <div className="text-xs text-muted-foreground">
                    Approve this cycle by {formatLongDate(approveBy)} so the
                    ACH settles on time.
                  </div>
                )}
                {!payDateIsPast && approveIsPast && (
                  <div className="text-xs text-warning">
                    Approve ASAP — the 2-business-day ACH window has already
                    started.
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ─── Advanced pay settings (collapsed by default) ─────────────────────────────

function AdvancedPaySettings({
  pay_lag_days,
  onChange,
}: {
  pay_lag_days: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = React.useState(() => Number(pay_lag_days) > 0);
  return (
    <div className="border-t border-border/40 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md px-1 py-0.5"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Advanced settings
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <NumberInput
            label="Pay lag (days after period end)"
            integer
            value={pay_lag_days}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0"
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Days between when the work period ends and when the employee is
            paid. Most salaried setups use 0 (period ends on pay day). Use a
            positive value only if you need time to collect timesheets.
          </p>
        </div>
      )}
    </div>
  );
}

interface StateElectionFieldsProps {
  stateConfig: StateTaxConfig | null;
  stateCode: string;
  taxYear: number;
  value: EmployeeStateElection;
  onChange: (patch: Partial<EmployeeStateElection>) => void;
}

function StateElectionFields({
  stateConfig,
  stateCode,
  taxYear,
  value,
  onChange,
}: StateElectionFieldsProps) {
  // No config for this state/year -> show advisory + generic extra withholding.
  if (!stateConfig) {
    const v = value as { extra_withholding?: number };
    return (
      <div className="space-y-3">
        <div
          className={cn(
            "flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm",
          )}
        >
          <User className="h-4 w-4 shrink-0 text-warning mt-0.5" aria-hidden="true" />
          <p className="text-muted-foreground">
            No {stateCode} tax config loaded for {taxYear}. Add one in{" "}
            <Link
              href="/payroll/config/states"
              className="font-medium text-primary hover:underline"
            >
              Payroll Settings
            </Link>{" "}
            before running payroll in this state.
          </p>
        </div>
        <NumberInput
          label="Extra State Withholding (per period)"
          value={String(v.extra_withholding ?? "")}
          onChange={(e) =>
            onChange({ extra_withholding: Number(e.target.value) || 0 })
          }
          placeholder="0.00"
        />
      </div>
    );
  }

  switch (stateConfig.calculation_method) {
    case "none":
      return (
        <p className="text-sm text-muted-foreground">
          {stateCode} has no state income tax. No election needed.
        </p>
      );

    case "flat": {
      const v = value as { rate?: number; extra_withholding?: number };
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput
            label="Rate Override (optional)"
            value={v.rate != null ? String(v.rate * 100) : ""}
            onChange={(e) => {
              const pct = Number(e.target.value);
              onChange({
                rate: e.target.value === "" ? undefined : pct / 100,
              });
            }}
            placeholder="Default rate used if blank"
          />
          <NumberInput
            label="Extra Withholding (per period)"
            value={String(v.extra_withholding ?? "")}
            onChange={(e) =>
              onChange({ extra_withholding: Number(e.target.value) || 0 })
            }
            placeholder="0.00"
          />
        </div>
      );
    }

    case "flat_employee_elected": {
      const cfg = stateConfig.config as {
        rates: number[];
        defaultRate: number;
        form?: string;
      };
      const v = value as { rate?: number; extra_withholding?: number };
      const rateOptions = (cfg.rates ?? []).map((r) => ({
        value: String(r),
        label: `${(r * 100).toFixed(1)}%`,
      }));
      return (
        <div className="space-y-4">
          <CustomSelect
            label={`Elected Rate${cfg.form ? ` (${cfg.form})` : ""}`}
            value={v.rate != null ? String(v.rate) : ""}
            onChange={(val) =>
              onChange({ rate: val === "" ? undefined : Number(val) })
            }
            options={[
              { value: "", label: `Default (${(cfg.defaultRate * 100).toFixed(1)}%)` },
              ...rateOptions,
            ]}
            placeholder={`Default (${(cfg.defaultRate * 100).toFixed(1)}%)`}
          />
          <NumberInput
            label="Extra Withholding (per period)"
            value={String(v.extra_withholding ?? "")}
            onChange={(e) =>
              onChange({ extra_withholding: Number(e.target.value) || 0 })
            }
            placeholder="0.00"
          />
        </div>
      );
    }

    case "progressive": {
      const v = value as {
        filing_status?: FilingStatus;
        allowances?: number;
        extra_withholding?: number;
      };
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CustomSelect
            label="State Filing Status (optional)"
            value={v.filing_status ?? ""}
            onChange={(val) =>
              onChange({
                filing_status: val === "" ? undefined : (val as FilingStatus),
              })
            }
            options={[
              { value: "", label: "Same as federal W-4" },
              ...FILING_STATUS_OPTIONS,
            ]}
          />
          <NumberInput
            label="Allowances (optional)"
            integer
            value={String(v.allowances ?? "")}
            onChange={(e) =>
              onChange({
                allowances:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            placeholder="0"
          />
          <div className="sm:col-span-2">
            <NumberInput
              label="Extra Withholding (per period)"
              value={String(v.extra_withholding ?? "")}
              onChange={(e) =>
                onChange({ extra_withholding: Number(e.target.value) || 0 })
              }
              placeholder="0.00"
            />
          </div>
        </div>
      );
    }

    case "custom":
      return (
        <p className="text-sm text-muted-foreground">
          Custom state calculation - contact your tax advisor to configure
          employee election fields.
        </p>
      );
  }
}
