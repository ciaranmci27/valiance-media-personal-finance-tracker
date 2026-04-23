"use server";

// Payroll run server actions.
//
// Lifecycle:
//   draft -> finalized -> paid
//                     \-> voided
//
// Key rules baked in:
//   - Only finalized + paid runs contribute to YTD. Drafts do not.
//   - On finalize we snapshot the employee row, the federal config,
//     the state config, and the organization config. Those snapshots are
//     the source of truth for the run forever after; config edits never
//     mutate past runs.
//   - History rows are written by the record_payroll_run_history() trigger
//     on every INSERT / status-change / soft-delete / restore. Server actions
//     must NOT also insert into payroll_run_history or events will double up.
//   - A voided run is not deleted; YTD calculations skip it via status.
//
// Nothing in here invents pay-period or tax math - calculateRun in
// engine.ts is the single source of truth for numbers. These actions
// orchestrate which inputs it receives (which YTD, which configs) and
// persist the result.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/demo";
import {
  removeRunFromDeposits,
  upsertDepositsForRun,
} from "@/lib/payroll/deposits-actions";
import { sendPayStubFireAndForget } from "@/lib/payroll/paystub-actions";
import {
  calculateRun,
  getNextPayPeriod,
  getPeriodForPayDate,
  isLegalPayDate,
  aggregateYtd,
  computeYtdThrough,
  ZERO_YTD,
  type PayPeriod,
  type YtdTotals,
} from "@/lib/payroll/engine";
import type { CalculatedRun } from "@/lib/payroll/engine";
import { PAY_FREQUENCY_LABELS } from "@/types/payroll";
import type {
  FederalTaxConfig,
  OrganizationConfig,
  PayFrequency,
  PayrollEmployee,
  PayrollRun,
  RunType,
  StateTaxConfig,
  WithholdingLineItem,
} from "@/types/payroll";

// ─── Result shape ─────────────────────────────────────────────────────────────

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  /** Non-fatal message surfaced alongside ok=true. Used when the primary
   *  action succeeded but a downstream side-effect (e.g. scheduled-deposit
   *  creation) failed and needs admin attention. */
  warning?: string;
  data?: T;
}

// ─── Auth gate ────────────────────────────────────────────────────────────────

/** Defense-in-depth auth check for payroll server actions.
 *
 *  Middleware already redirects unauthenticated browser traffic, and RLS is
 *  the authoritative guard on the DB rows. This is a third layer: any direct
 *  POST to a server action endpoint will be rejected before it touches the
 *  DB or performs any tax math. Returns null on success, or an error string. */
async function requireActionAuth(): Promise<string | null> {
  if (isDemoMode()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return "Not authenticated";
  return null;
}

// ─── Preview types ────────────────────────────────────────────────────────────

export interface PreviewRunItem {
  employee: PayrollEmployee;
  period: PayPeriod;
  ytd: YtdTotals;
  calculated: CalculatedRun;
  /** True if no federal config exists for this run's tax year. */
  missingFederal: boolean;
  /** True if no state config exists for this employee's state + tax year. */
  missingState: boolean;
  /** True when the engine fell back to any default (e.g. employee has no
   *  state election yet and the state expects one). */
  usedDefaults: boolean;
  /** Advisory messages surfaced by the engine for this employee. */
  notices: string[];
}

export interface PreviewBatchResult {
  items: PreviewRunItem[];
  /** Employees that could not be calculated at all (missing configs, etc.). */
  errors: {
    employee: PayrollEmployee;
    reason: string;
    /** When the block is caused by an existing run colliding on this period,
     *  the existing run's id so the UI can link directly to it. */
    existing_run_id?: string;
  }[];
  /** The tax year the batch falls into (derived from pay_date). */
  taxYear: number;
}

// ─── Internal: config loaders ─────────────────────────────────────────────────

interface TaxYearConfigs {
  federal: FederalTaxConfig | null;
  statesByCode: Map<string, StateTaxConfig>;
  organization: OrganizationConfig | null;
}

async function loadTaxYearConfigs(
  taxYear: number,
): Promise<TaxYearConfigs> {
  const supabase = await createClient();
  const [fedRes, statesRes, orgRes] = await Promise.all([
    supabase
      .from("federal_tax_configs")
      .select("*")
      .eq("tax_year", taxYear)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("state_tax_configs")
      .select("*")
      .eq("tax_year", taxYear)
      .is("deleted_at", null),
    supabase
      .from("organization_config")
      .select("*")
      .is("deleted_at", null)
      .maybeSingle(),
  ]);

  const federal = (fedRes.data as FederalTaxConfig | null) ?? null;
  const states = (statesRes.data as StateTaxConfig[] | null) ?? [];
  const organization = (orgRes.data as OrganizationConfig | null) ?? null;

  const statesByCode = new Map<string, StateTaxConfig>();
  for (const s of states) statesByCode.set(s.state_code, s);

  return { federal, statesByCode, organization };
}

/** Tax year for a YYYY-MM-DD date string. */
function taxYearOf(ymd: string): number {
  return Number(ymd.split("-")[0]);
}

// ─── Internal: YTD loader (one query per batch, split per employee) ───────────

async function loadYtdByEmployee(
  employeeIds: string[],
  taxYear: number,
  /** Runs with pay_date >= this value are NOT counted (the run we are about
   *  to finalize should not be part of its own YTD). */
  cutoffPayDate?: string,
): Promise<Map<string, YtdTotals>> {
  const out = new Map<string, YtdTotals>();
  if (employeeIds.length === 0) return out;

  const supabase = await createClient();
  const yearStart = `${taxYear}-01-01`;
  const yearEnd = `${taxYear}-12-31`;

  let query = supabase
    .from("payroll_runs")
    .select("*")
    .in("employee_id", employeeIds)
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .gte("pay_date", yearStart)
    .lte("pay_date", yearEnd);

  if (cutoffPayDate) query = query.lt("pay_date", cutoffPayDate);

  const { data, error } = await query;
  if (error) {
    console.error("[payroll/runs-actions] loadYtdByEmployee failed:", error);
    for (const id of employeeIds) out.set(id, { ...ZERO_YTD });
    return out;
  }

  const byEmp = new Map<string, PayrollRun[]>();
  for (const run of (data as PayrollRun[]) ?? []) {
    const list = byEmp.get(run.employee_id) ?? [];
    list.push(run);
    byEmp.set(run.employee_id, list);
  }

  for (const id of employeeIds) {
    const runs = byEmp.get(id) ?? [];
    out.set(id, aggregateYtd(runs));
  }

  return out;
}

/** Sum of supplemental (off-cycle) gross paid to an employee this tax year
 *  before cutoffPayDate. Needed to bracket the 22% vs 37% federal flat rate. */
async function loadSupplementalYtd(
  employeeId: string,
  taxYear: number,
  cutoffPayDate?: string,
): Promise<number> {
  const supabase = await createClient();
  const yearStart = `${taxYear}-01-01`;
  const yearEnd = `${taxYear}-12-31`;

  let query = supabase
    .from("payroll_runs")
    .select("gross_pay, pay_date, run_type, status")
    .eq("employee_id", employeeId)
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .eq("run_type", "off_cycle")
    .gte("pay_date", yearStart)
    .lte("pay_date", yearEnd);

  if (cutoffPayDate) query = query.lt("pay_date", cutoffPayDate);

  const { data, error } = await query;
  if (error) {
    console.error("[payroll/runs-actions] loadSupplementalYtd failed:", error);
    return 0;
  }
  return ((data as { gross_pay: number }[]) ?? []).reduce(
    (s, r) => s + Number(r.gross_pay || 0),
    0,
  );
}

// History rows are written by record_payroll_run_history() in Postgres; we
// deliberately do not insert them here. See header comment.

// ─── Preview a batch of upcoming runs ─────────────────────────────────────────

export interface PreviewBatchInput {
  /** Optional target pay date (YYYY-MM-DD). If omitted, uses each employee's
   *  next upcoming pay date individually. */
  pay_date?: string | null;
  /** Optional explicit employee id filter. Empty means "all active". */
  employee_ids?: string[] | null;
}

export async function previewBatch(
  input: PreviewBatchInput = {},
): Promise<ActionResult<PreviewBatchResult>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) {
    return {
      ok: true,
      data: { items: [], errors: [], taxYear: new Date().getUTCFullYear() },
    };
  }

  const supabase = await createClient();

  // Load active employees.
  let employeesQuery = supabase
    .from("payroll_employees")
    .select("*")
    .is("deleted_at", null)
    .eq("status", "active")
    .order("last_name", { ascending: true });

  if (input.employee_ids && input.employee_ids.length > 0) {
    employeesQuery = employeesQuery.in("id", input.employee_ids);
  }

  const { data: employeesData, error: employeesError } = await employeesQuery;
  if (employeesError) {
    return { ok: false, error: employeesError.message };
  }
  const employees = (employeesData as PayrollEmployee[] | null) ?? [];

  if (employees.length === 0) {
    return {
      ok: true,
      data: {
        items: [],
        errors: [],
        taxYear: new Date().getUTCFullYear(),
      },
    };
  }

  // Derive tax year from either the explicit pay date or the first employee's
  // next pay date. In a mixed batch across year boundaries, each employee is
  // evaluated against their own pay-date's tax year below.
  const today = new Date();
  const anchorPayDate =
    input.pay_date ?? deriveFirstPayDate(employees[0], today);
  const taxYear = taxYearOf(anchorPayDate);

  const configs = await loadTaxYearConfigs(taxYear);

  // Load ALL runs for these employees in the tax year (one query), so we can
  // both (a) apply a per-employee pay_date cutoff when aggregating YTD and
  // (b) detect existing runs that collide with the period we are previewing.
  const supabase2 = await createClient();
  const yearStart = `${taxYear}-01-01`;
  const yearEnd = `${taxYear}-12-31`;
  const { data: allRunsData } = await supabase2
    .from("payroll_runs")
    .select(
      "id, employee_id, pay_date, period_start, period_end, run_type, status, gross_pay, federal_income_tax, state_income_tax, social_security_employee, medicare_employee, additional_medicare, state_disability_employee, other_withholdings, net_pay, social_security_employer, medicare_employer, futa, suta, state_disability_employer",
    )
    .in("employee_id", employees.map((e) => e.id))
    .is("deleted_at", null)
    .gte("pay_date", yearStart)
    .lte("pay_date", yearEnd);
  const allRuns = (allRunsData as PayrollRun[] | null) ?? [];
  const runsByEmployee = new Map<string, PayrollRun[]>();
  for (const run of allRuns) {
    const list = runsByEmployee.get(run.employee_id) ?? [];
    list.push(run);
    runsByEmployee.set(run.employee_id, list);
  }

  const items: PreviewRunItem[] = [];
  const errors: PreviewBatchResult["errors"] = [];

  for (const employee of employees) {
    const scheduleInput = {
      pay_frequency: employee.pay_frequency,
      pay_anchor_date: employee.pay_anchor_date,
      pay_lag_days: employee.pay_lag_days,
      semimonthly_days: employee.semimonthly_days,
      monthly_day: employee.monthly_day,
    };

    // H3: preview is for regular-cadence runs. If an admin typed a pay date
    // that this employee's schedule doesn't generate, flag them instead of
    // silently deriving a mismatched period. A common case is a batch across
    // employees on different cadences.
    if (
      input.pay_date &&
      !isLegalPayDate(scheduleInput, parseYmd(input.pay_date))
    ) {
      errors.push({
        employee,
        reason: `${input.pay_date} is not a scheduled ${employee.pay_frequency} pay date - run separately on their own schedule, or use an off-cycle run.`,
      });
      continue;
    }

    // Determine period for this employee.
    let period: PayPeriod;
    try {
      if (input.pay_date) {
        period = getPeriodForPayDate(
          scheduleInput,
          parseYmd(input.pay_date),
        );
      } else {
        period = getNextPayPeriod(scheduleInput, today);
      }
    } catch (err) {
      errors.push({
        employee,
        reason: err instanceof Error ? err.message : "Schedule error",
      });
      continue;
    }

    const empTaxYear = taxYearOf(period.pay_date);
    const empConfigs =
      empTaxYear === taxYear ? configs : await loadTaxYearConfigs(empTaxYear);
    const missingFederal = empConfigs.federal == null;
    const state = empConfigs.statesByCode.get(employee.state_code) ?? null;
    const missingState = state == null;

    if (missingFederal || missingState) {
      errors.push({
        employee,
        reason: missingFederal
          ? `No federal tax config for ${empTaxYear}`
          : `No ${employee.state_code} state tax config for ${empTaxYear}`,
      });
      continue;
    }

    // C5: if a non-voided regular run already exists for this exact period,
    // flag as an error instead of letting the admin accidentally duplicate it.
    const empRuns = runsByEmployee.get(employee.id) ?? [];
    const collidingRun = empRuns.find(
      (r) =>
        r.status !== "voided" &&
        r.run_type === "regular" &&
        r.period_start === period.period_start &&
        r.period_end === period.period_end,
    );
    if (collidingRun) {
      errors.push({
        employee,
        reason: `A ${collidingRun.status} run already exists for ${period.period_start} to ${period.period_end} (pay date ${collidingRun.pay_date})`,
        existing_run_id: collidingRun.id,
      });
      continue;
    }

    // C2: YTD must only include finalized+paid runs strictly BEFORE this
    // employee's period.pay_date. Runs on or after the preview date would
    // contaminate FICA caps and federal bracket math.
    const ytd =
      empTaxYear === taxYear
        ? aggregateYtd(
            empRuns.filter(
              (r) =>
                (r.status === "finalized" || r.status === "paid") &&
                r.pay_date < period.pay_date,
            ),
          )
        : aggregateYtd([]); // different year, empty - rare edge

    let calculated: CalculatedRun;
    try {
      calculated = calculateRun({
        employee,
        federalConfig: empConfigs.federal as FederalTaxConfig,
        stateConfig: state as StateTaxConfig,
        period,
        ytd,
        runType: "regular",
      });
    } catch (err) {
      errors.push({
        employee,
        reason: err instanceof Error ? err.message : "Calculation failed",
      });
      continue;
    }

    items.push({
      employee,
      period,
      ytd,
      calculated,
      missingFederal: false,
      missingState: false,
      usedDefaults: false,
      notices: calculated.meta.notices,
    });
  }

  return {
    ok: true,
    data: { items, errors, taxYear },
  };
}

// ─── List upcoming pay windows (landing page) ────────────────────────────────

/** A "pay window" is the next upcoming pay cycle for one or more employees
 *  who share an identical period + pay_date. Employees on different schedules
 *  produce different windows, so a mixed-cadence org sees one card per
 *  schedule on the landing page. */
export interface PayWindowEmployee {
  id: string;
  first_name: string;
  last_name: string;
  pay_frequency: PayFrequency;
}

export interface PayWindow {
  /** Stable id: `${pay_date}|${period_start}|${period_end}`. Used as URL key. */
  id: string;
  /** Best label for the card heading. If all employees share a frequency,
   *  that frequency's label. Otherwise "Multiple schedules". */
  frequency_label: string;
  /** Short schedule descriptor (weekday for weekly/biweekly, days for
   *  semimonthly, etc.). Empty string if the window mixes schedules. */
  schedule_detail: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  employees: PayWindowEmployee[];
  /** Pay date is within 7 days of asOf. */
  imminent: boolean;
  /** Pay date is before asOf - should have been run already. */
  overdue: boolean;
  /** At least one employee in this window already has a non-voided regular
   *  run for this exact period. */
  has_existing_run: boolean;
}

export interface ListPayWindowsResult {
  windows: PayWindow[];
  /** Employees we couldn't schedule at all (misconfigured schedule, etc.). */
  errors: { employee: PayWindowEmployee; reason: string }[];
}

export async function listPayWindows(): Promise<
  ActionResult<ListPayWindowsResult>
> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true, data: { windows: [], errors: [] } };

  const supabase = await createClient();
  const { data: employeesData, error } = await supabase
    .from("payroll_employees")
    .select("*")
    .is("deleted_at", null)
    .eq("status", "active")
    .order("last_name", { ascending: true });
  if (error) return { ok: false, error: error.message };

  const employees = (employeesData as PayrollEmployee[] | null) ?? [];
  if (employees.length === 0) {
    return { ok: true, data: { windows: [], errors: [] } };
  }

  const today = new Date();
  const todayYmd = formatUtcYmd(today);
  const soonCutoff = addDaysYmd(todayYmd, 7);

  // Compute each employee's next period. Group by (period_start, period_end,
  // pay_date). Employees whose schedule explodes go into errors.
  const grouped = new Map<string, PayWindow>();
  const errors: { employee: PayWindowEmployee; reason: string }[] = [];
  const allPeriods: { employee: PayrollEmployee; period: PayPeriod }[] = [];

  for (const employee of employees) {
    try {
      const period = getNextPayPeriod(
        {
          pay_frequency: employee.pay_frequency,
          pay_anchor_date: employee.pay_anchor_date,
          pay_lag_days: employee.pay_lag_days,
          semimonthly_days: employee.semimonthly_days,
          monthly_day: employee.monthly_day,
        },
        today,
      );
      allPeriods.push({ employee, period });

      const key = `${period.pay_date}|${period.period_start}|${period.period_end}`;
      const slim: PayWindowEmployee = {
        id: employee.id,
        first_name: employee.first_name,
        last_name: employee.last_name,
        pay_frequency: employee.pay_frequency,
      };

      const existing = grouped.get(key);
      if (existing) {
        existing.employees.push(slim);
      } else {
        grouped.set(key, {
          id: key,
          frequency_label: "",
          schedule_detail: "",
          period_start: period.period_start,
          period_end: period.period_end,
          pay_date: period.pay_date,
          employees: [slim],
          imminent: period.pay_date <= soonCutoff && period.pay_date >= todayYmd,
          overdue: period.pay_date < todayYmd,
          has_existing_run: false,
        });
      }
    } catch (err) {
      errors.push({
        employee: {
          id: employee.id,
          first_name: employee.first_name,
          last_name: employee.last_name,
          pay_frequency: employee.pay_frequency,
        },
        reason: err instanceof Error ? err.message : "Schedule error",
      });
    }
  }

  // Resolve labels per window now that rosters are final.
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  for (const w of grouped.values()) {
    const frequencies = new Set(w.employees.map((e) => e.pay_frequency));
    if (frequencies.size === 1) {
      const freq = w.employees[0].pay_frequency;
      w.frequency_label = PAY_FREQUENCY_LABELS[freq];
      const first = employeesById.get(w.employees[0].id);
      w.schedule_detail = first ? scheduleDetail(first) : "";
    } else {
      w.frequency_label = "Multiple schedules";
      w.schedule_detail = "";
    }
  }

  // Flag windows where an existing non-voided regular run already covers
  // any employee's period. One batched query spanning all the periods we
  // just computed.
  if (allPeriods.length > 0) {
    const employeeIds = Array.from(new Set(allPeriods.map((p) => p.employee.id)));
    const payDates = Array.from(new Set(allPeriods.map((p) => p.period.pay_date)));
    const { data: runsData } = await supabase
      .from("payroll_runs")
      .select("employee_id, period_start, period_end, pay_date, run_type, status")
      .in("employee_id", employeeIds)
      .in("pay_date", payDates)
      .is("deleted_at", null)
      .neq("status", "voided")
      .eq("run_type", "regular");
    const existingKeys = new Set(
      (runsData ?? []).map(
        (r) =>
          `${r.employee_id}|${r.period_start}|${r.period_end}|${r.pay_date}`,
      ),
    );
    for (const { employee, period } of allPeriods) {
      const runKey = `${employee.id}|${period.period_start}|${period.period_end}|${period.pay_date}`;
      if (existingKeys.has(runKey)) {
        const wKey = `${period.pay_date}|${period.period_start}|${period.period_end}`;
        const w = grouped.get(wKey);
        if (w) w.has_existing_run = true;
      }
    }
  }

  const windows = Array.from(grouped.values()).sort((a, b) =>
    a.pay_date.localeCompare(b.pay_date),
  );

  return { ok: true, data: { windows, errors } };
}

function scheduleDetail(employee: PayrollEmployee): string {
  switch (employee.pay_frequency) {
    case "weekly":
    case "biweekly": {
      const anchor = parseYmd(employee.pay_anchor_date);
      const weekday = anchor.toLocaleDateString("en-US", {
        weekday: "long",
        timeZone: "UTC",
      });
      return weekday;
    }
    case "semimonthly": {
      const days = employee.semimonthly_days ?? [];
      if (days.length !== 2) return "";
      return `${ordinal(days[0])} & ${days[1] >= 28 ? "last" : ordinal(days[1])}`;
    }
    case "monthly": {
      const d = employee.monthly_day;
      if (d == null) return "";
      return d >= 28 ? "Last day" : ordinal(d);
    }
    case "annual": {
      const anchor = parseYmd(employee.pay_anchor_date);
      return anchor.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
    }
  }
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function formatUtcYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtcYmd(d);
}

// ─── Create a draft run ───────────────────────────────────────────────────────

export interface CreateDraftInput {
  employee_id: string;
  /** YYYY-MM-DD - determines the pay period via employee schedule. */
  pay_date: string;
  run_type?: RunType;
  /** Override the employee's pay_amount for this run (gross). Required for
   *  off_cycle runs; optional for regular (undefined = use employee.pay_amount). */
  override_gross?: number | null;
  other_withholdings?: WithholdingLineItem[];
  notes?: string | null;
}

export async function createDraftRun(
  input: CreateDraftInput,
): Promise<ActionResult<{ id: string }>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true, data: { id: "demo-run-id" } };

  if (!input.employee_id) return { ok: false, error: "Missing employee" };
  if (!input.pay_date) return { ok: false, error: "Missing pay date" };
  const runType: RunType = input.run_type ?? "regular";
  if (runType === "off_cycle") {
    if (
      input.override_gross == null ||
      !(Number(input.override_gross) > 0)
    ) {
      return {
        ok: false,
        error: "Off-cycle runs require an override gross amount > 0",
      };
    }
  }

  const supabase = await createClient();

  const { data: empRow, error: empError } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("id", input.employee_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (empError) return { ok: false, error: empError.message };
  if (!empRow) return { ok: false, error: "Employee not found" };
  const employee = empRow as PayrollEmployee;

  const scheduleInput = {
    pay_frequency: employee.pay_frequency,
    pay_anchor_date: employee.pay_anchor_date,
    pay_lag_days: employee.pay_lag_days,
    semimonthly_days: employee.semimonthly_days,
    monthly_day: employee.monthly_day,
  };

  // H3: regular runs MUST land on a scheduled pay date; otherwise their
  // period would not line up with neighbouring runs, producing YTD gaps or
  // overlapping coverage. Off-cycle runs (bonuses, early-holiday checks,
  // final paychecks) are exempt because admins legitimately pick arbitrary
  // dates for them - the off_cycle path is how you tell the system
  // "don't treat this as part of the regular cadence".
  if (runType === "regular") {
    if (!isLegalPayDate(scheduleInput, parseYmd(input.pay_date))) {
      return {
        ok: false,
        error: `${input.pay_date} is not a scheduled ${employee.pay_frequency} pay date for ${employee.first_name} ${employee.last_name}. Pick a date from their schedule, or create an off-cycle run instead.`,
      };
    }
  }

  let period: PayPeriod;
  try {
    period = getPeriodForPayDate(scheduleInput, parseYmd(input.pay_date));
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Schedule error",
    };
  }

  const taxYear = taxYearOf(period.pay_date);
  const configs = await loadTaxYearConfigs(taxYear);
  if (!configs.federal) {
    return { ok: false, error: `No federal tax config for ${taxYear}` };
  }
  const state = configs.statesByCode.get(employee.state_code);
  if (!state) {
    return {
      ok: false,
      error: `No ${employee.state_code} state tax config for ${taxYear}`,
    };
  }

  // C4: duplicate-draft guard. A partial unique index in SQL is the final
  // line of defense, but this check surfaces a friendlier error and avoids
  // a round-trip for the common case (double-clicked "Run & finalize").
  const { data: colliding } = await supabase
    .from("payroll_runs")
    .select("id, status, pay_date")
    .eq("employee_id", employee.id)
    .eq("run_type", runType)
    .eq("period_start", period.period_start)
    .eq("period_end", period.period_end)
    .neq("status", "voided")
    .is("deleted_at", null)
    .limit(1);
  if (colliding && colliding.length > 0) {
    const c = colliding[0] as { id: string; status: string; pay_date: string };
    return {
      ok: false,
      error: `A ${c.status} ${runType} run already exists for ${period.period_start} to ${period.period_end} (pay date ${c.pay_date}). Void it first if you need to replace it.`,
    };
  }

  // CRITICAL: pass period.pay_date as the YTD cutoff. Without this, an
  // earlier-dated draft would count later finalized runs toward its own YTD,
  // which would corrupt FICA wage-base, Additional Medicare, and FUTA math.
  const ytdMap = await loadYtdByEmployee(
    [employee.id],
    taxYear,
    period.pay_date,
  );
  const ytd = ytdMap.get(employee.id) ?? { ...ZERO_YTD };
  const supplementalYtd =
    runType === "off_cycle"
      ? await loadSupplementalYtd(employee.id, taxYear, period.pay_date)
      : 0;

  // Apply override gross by briefly swapping employee.pay_amount for regular.
  // For off_cycle the engine reads supplementalAmount directly.
  const employeeForCalc: PayrollEmployee =
    runType === "regular" && input.override_gross != null
      ? { ...employee, pay_amount: Number(input.override_gross) }
      : employee;

  let calc: CalculatedRun;
  try {
    calc = calculateRun({
      employee: employeeForCalc,
      federalConfig: configs.federal,
      stateConfig: state,
      period,
      ytd,
      runType,
      supplementalAmount:
        runType === "off_cycle" ? Number(input.override_gross ?? 0) : undefined,
      supplementalYtd,
      otherWithholdings: input.other_withholdings ?? [],
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Calculation failed",
    };
  }

  // H1: deductions must never exceed gross - you cannot cut a negative check.
  if (calc.net_pay < 0) {
    return {
      ok: false,
      error: `Deductions exceed gross pay - net would be ${calc.net_pay.toFixed(2)}. Reduce other withholdings or increase gross.`,
    };
  }

  const { data, error } = await supabase
    .from("payroll_runs")
    .insert({
      employee_id: employee.id,
      run_type: runType,
      status: "draft",
      period_start: period.period_start,
      period_end: period.period_end,
      pay_date: period.pay_date,
      gross_pay: calc.gross_pay,
      federal_income_tax: calc.federal_income_tax,
      state_income_tax: calc.state_income_tax,
      social_security_employee: calc.social_security_employee,
      medicare_employee: calc.medicare_employee,
      additional_medicare: calc.additional_medicare,
      state_disability_employee: calc.state_disability_employee,
      other_withholdings: calc.other_withholdings,
      net_pay: calc.net_pay,
      social_security_employer: calc.social_security_employer,
      medicare_employer: calc.medicare_employer,
      futa: calc.futa,
      suta: calc.suta,
      state_disability_employer: calc.state_disability_employer,
      social_security_wages: calc.meta.ssTaxableThisPeriod,
      medicare_wages: calc.meta.medicareTaxableThisPeriod,
      additional_medicare_wages: calc.meta.additionalMedicareWagesThisPeriod,
      futa_wages: calc.meta.futaTaxableThisPeriod,
      suta_wages: calc.meta.sutaTaxableThisPeriod,
      state_taxable_wages: calc.meta.stateTaxableThisPeriod,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[payroll/runs-actions] createDraftRun failed:", error);
    // Postgres unique_violation: our partial unique index fired. This should
    // be rare because of the SELECT-based duplicate guard above, but a race
    // between two concurrent calls can still slip through.
    if ((error as { code?: string }).code === "23505") {
      return {
        ok: false,
        error: `A run already exists for this employee and period (${period.period_start} to ${period.period_end}). Void it first if you need to replace it.`,
      };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/run");
  revalidatePath("/payroll/runs");
  return { ok: true, data: { id: data.id } };
}

// ─── Batch create drafts from a preview ───────────────────────────────────────

export interface CreateBatchDraftInput {
  items: Array<{
    employee_id: string;
    pay_date: string;
    override_gross?: number | null;
    other_withholdings?: WithholdingLineItem[];
  }>;
}

export async function createBatchDrafts(
  input: CreateBatchDraftInput,
): Promise<
  ActionResult<{
    created: { id: string; employee_id: string }[];
    failed: { employee_id: string; reason: string }[];
  }>
> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) {
    return {
      ok: true,
      data: {
        created: input.items.map((i, idx) => ({
          id: `demo-draft-${idx}`,
          employee_id: i.employee_id,
        })),
        failed: [],
      },
    };
  }

  const created: { id: string; employee_id: string }[] = [];
  const failed: { employee_id: string; reason: string }[] = [];

  for (const item of input.items) {
    const res = await createDraftRun({
      employee_id: item.employee_id,
      pay_date: item.pay_date,
      run_type: "regular",
      override_gross: item.override_gross,
      other_withholdings: item.other_withholdings,
    });
    if (res.ok && res.data) {
      created.push({ id: res.data.id, employee_id: item.employee_id });
    } else {
      failed.push({
        employee_id: item.employee_id,
        reason: res.error ?? "Unknown error",
      });
    }
  }

  return { ok: true, data: { created, failed } };
}

// ─── Recalculate an existing draft ────────────────────────────────────────────

export interface RecalculateDraftInput {
  run_id: string;
  /** Replace gross. undefined = keep existing gross_pay from row. */
  override_gross?: number | null;
  /** Replace other_withholdings list. undefined = keep existing. */
  other_withholdings?: WithholdingLineItem[];
  notes?: string | null;
}

export async function recalculateDraftRun(
  input: RecalculateDraftInput,
): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!input.run_id) return { ok: false, error: "Missing run id" };

  const supabase = await createClient();
  const { data: runRow, error: runError } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("id", input.run_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (runError) return { ok: false, error: runError.message };
  if (!runRow) return { ok: false, error: "Run not found" };
  const run = runRow as PayrollRun;

  if (run.status !== "draft") {
    return {
      ok: false,
      error: "Only draft runs can be recalculated. Approved runs are immutable.",
    };
  }

  const { data: empRow, error: empError } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("id", run.employee_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (empError) return { ok: false, error: empError.message };
  if (!empRow) return { ok: false, error: "Employee not found" };
  const employee = empRow as PayrollEmployee;

  const taxYear = taxYearOf(run.pay_date);
  const configs = await loadTaxYearConfigs(taxYear);
  if (!configs.federal) {
    return { ok: false, error: `No federal tax config for ${taxYear}` };
  }
  const state = configs.statesByCode.get(employee.state_code);
  if (!state) {
    return {
      ok: false,
      error: `No ${employee.state_code} state tax config for ${taxYear}`,
    };
  }

  const ytdMap = await loadYtdByEmployee([employee.id], taxYear, run.pay_date);
  const ytd = ytdMap.get(employee.id) ?? { ...ZERO_YTD };
  const supplementalYtd =
    run.run_type === "off_cycle"
      ? await loadSupplementalYtd(employee.id, taxYear, run.pay_date)
      : 0;

  const nextOther = input.other_withholdings ?? run.other_withholdings ?? [];

  // Two distinct modes:
  //   - override_gross provided: treat the value as a pre-proration base,
  //     matching createDraft semantics. Engine will prorate for a mid-period
  //     hire or termination.
  //   - No override: preserve the existing draft gross_pay via grossOverride
  //     so taxes refresh against current configs without double-prorating an
  //     already post-proration value.
  const hasOverride = input.override_gross != null;
  const overrideBase = hasOverride ? Number(input.override_gross) : 0;
  const employeeForCalc: PayrollEmployee =
    hasOverride && run.run_type === "regular"
      ? { ...employee, pay_amount: overrideBase }
      : employee;

  let calc: CalculatedRun;
  try {
    calc = calculateRun({
      employee: employeeForCalc,
      federalConfig: configs.federal,
      stateConfig: state,
      period: {
        period_start: run.period_start,
        period_end: run.period_end,
        pay_date: run.pay_date,
      },
      ytd,
      runType: run.run_type,
      supplementalAmount:
        hasOverride && run.run_type === "off_cycle" ? overrideBase : undefined,
      grossOverride: hasOverride ? undefined : Number(run.gross_pay),
      supplementalYtd,
      otherWithholdings: nextOther,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Calculation failed",
    };
  }

  // H1: block persistence if deductions exceed gross.
  if (calc.net_pay < 0) {
    return {
      ok: false,
      error: `Deductions exceed gross pay - net would be ${calc.net_pay.toFixed(2)}. Reduce other withholdings or increase gross.`,
    };
  }

  const { error: updateError } = await supabase
    .from("payroll_runs")
    .update({
      gross_pay: calc.gross_pay,
      federal_income_tax: calc.federal_income_tax,
      state_income_tax: calc.state_income_tax,
      social_security_employee: calc.social_security_employee,
      medicare_employee: calc.medicare_employee,
      additional_medicare: calc.additional_medicare,
      state_disability_employee: calc.state_disability_employee,
      other_withholdings: calc.other_withholdings,
      net_pay: calc.net_pay,
      social_security_employer: calc.social_security_employer,
      medicare_employer: calc.medicare_employer,
      futa: calc.futa,
      suta: calc.suta,
      state_disability_employer: calc.state_disability_employer,
      social_security_wages: calc.meta.ssTaxableThisPeriod,
      medicare_wages: calc.meta.medicareTaxableThisPeriod,
      additional_medicare_wages: calc.meta.additionalMedicareWagesThisPeriod,
      futa_wages: calc.meta.futaTaxableThisPeriod,
      suta_wages: calc.meta.sutaTaxableThisPeriod,
      state_taxable_wages: calc.meta.stateTaxableThisPeriod,
      notes: input.notes ?? run.notes,
    })
    .eq("id", run.id);

  if (updateError) {
    console.error("[payroll/runs-actions] recalculateDraftRun failed:", updateError);
    return { ok: false, error: updateError.message };
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/run");
  revalidatePath(`/payroll/runs/${run.id}`);
  return { ok: true };
}

// ─── Finalize a draft ─────────────────────────────────────────────────────────

export async function finalizeRun(runId: string): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!runId) return { ok: false, error: "Missing run id" };

  const supabase = await createClient();
  const { data: runRow, error: runError } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("id", runId)
    .is("deleted_at", null)
    .maybeSingle();
  if (runError) return { ok: false, error: runError.message };
  if (!runRow) return { ok: false, error: "Run not found" };
  const run = runRow as PayrollRun;

  if (run.status !== "draft") {
    return { ok: false, error: "Only draft runs can be approved" };
  }

  // Snapshot: pull fresh employee + configs + organization.
  const { data: empRow } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("id", run.employee_id)
    .maybeSingle();
  const employee = (empRow as PayrollEmployee | null) ?? null;
  if (!employee) return { ok: false, error: "Employee not found" };

  const taxYear = taxYearOf(run.pay_date);
  const configs = await loadTaxYearConfigs(taxYear);
  if (!configs.federal) {
    return { ok: false, error: `No federal tax config for ${taxYear}` };
  }
  const state = configs.statesByCode.get(employee.state_code);
  if (!state) {
    return {
      ok: false,
      error: `No ${employee.state_code} state tax config for ${taxYear}`,
    };
  }

  // C3: Recalculate at finalize using the CURRENT employee + configs so the
  // numbers we freeze into the snapshot are internally consistent with the
  // snapshot itself. Without this, a config or W-4 edit between draft and
  // finalize would produce a row where stored tax amounts disagree with the
  // attached snapshot - an audit hazard and a real risk of under/over-
  // withholding.
  //
  // We preserve the draft's gross_pay verbatim via grossOverride. Mutating
  // employee.pay_amount here would double-prorate mid-period hire /
  // termination because run.gross_pay is already post-proration from draft
  // creation.
  const ytdMap = await loadYtdByEmployee(
    [employee.id],
    taxYear,
    run.pay_date,
  );
  const ytd = ytdMap.get(employee.id) ?? { ...ZERO_YTD };
  const supplementalYtd =
    run.run_type === "off_cycle"
      ? await loadSupplementalYtd(employee.id, taxYear, run.pay_date)
      : 0;

  const storedGross = Number(run.gross_pay);

  let calc: CalculatedRun;
  try {
    calc = calculateRun({
      employee,
      federalConfig: configs.federal,
      stateConfig: state,
      period: {
        period_start: run.period_start,
        period_end: run.period_end,
        pay_date: run.pay_date,
      },
      ytd,
      runType: run.run_type,
      grossOverride: storedGross,
      supplementalYtd,
      otherWithholdings: run.other_withholdings ?? [],
    });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Finalize recalculation failed: ${err.message}`
          : "Finalize recalculation failed",
    };
  }

  if (calc.net_pay < 0) {
    return {
      ok: false,
      error:
        "Finalize would produce negative net pay. Review deductions and other withholdings.",
    };
  }

  // Strip encrypted SSN from the employee snapshot - we do not need it in
  // the run record, and keeping it out limits the blast radius if a run
  // row ever leaks (e.g. via a logs export).
  const employeeSnapshot = {
    ...employee,
    ssn_encrypted: null,
    ssn_key_version: null,
  };

  const { error: updateError } = await supabase
    .from("payroll_runs")
    .update({
      status: "finalized",
      finalized_at: new Date().toISOString(),
      // Fresh recalc so stored numbers match the snapshot configs.
      gross_pay: calc.gross_pay,
      federal_income_tax: calc.federal_income_tax,
      state_income_tax: calc.state_income_tax,
      social_security_employee: calc.social_security_employee,
      medicare_employee: calc.medicare_employee,
      additional_medicare: calc.additional_medicare,
      state_disability_employee: calc.state_disability_employee,
      other_withholdings: calc.other_withholdings,
      net_pay: calc.net_pay,
      social_security_employer: calc.social_security_employer,
      medicare_employer: calc.medicare_employer,
      futa: calc.futa,
      suta: calc.suta,
      state_disability_employer: calc.state_disability_employer,
      social_security_wages: calc.meta.ssTaxableThisPeriod,
      medicare_wages: calc.meta.medicareTaxableThisPeriod,
      additional_medicare_wages: calc.meta.additionalMedicareWagesThisPeriod,
      futa_wages: calc.meta.futaTaxableThisPeriod,
      suta_wages: calc.meta.sutaTaxableThisPeriod,
      state_taxable_wages: calc.meta.stateTaxableThisPeriod,
      // Immutable snapshots.
      employee_snapshot: employeeSnapshot,
      federal_config_snapshot: configs.federal,
      state_config_snapshot: state,
      organization_snapshot: configs.organization,
    })
    .eq("id", runId);

  if (updateError) {
    console.error("[payroll/runs-actions] finalizeRun failed:", updateError);
    return { ok: false, error: updateError.message };
  }

  // Auto-create / update scheduled tax deposits for this run. A failure here
  // does not fail the finalize itself (the run is already committed). The
  // reason is captured as a warning on the action result so the admin sees
  // it in the UI and can investigate instead of ending up with a finalized
  // run that has no matching deposits.
  let depositWarning: string | undefined;
  try {
    const depRes = await upsertDepositsForRun(runId);
    if (!depRes.ok) {
      console.error(
        "[payroll/runs-actions] finalizeRun deposits upsert failed:",
        depRes.error,
      );
      depositWarning = `Run approved, but scheduled tax deposits were not created: ${depRes.error ?? "unknown error"}`;
    }
  } catch (err) {
    console.error(
      "[payroll/runs-actions] finalizeRun deposits upsert threw:",
      err,
    );
    depositWarning = `Run approved, but scheduled tax deposits were not created: ${err instanceof Error ? err.message : String(err)}`;
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/run");
  revalidatePath("/payroll/runs");
  revalidatePath("/payroll/deposits");
  revalidatePath(`/payroll/runs/${runId}`);
  revalidatePath("/payroll/cycles/[payDate]", "page");
  return { ok: true, warning: depositWarning };
}

export async function finalizeRunsBatch(
  runIds: string[],
): Promise<
  ActionResult<{
    succeeded: string[];
    failed: { run_id: string; reason: string }[];
  }>
> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) {
    return { ok: true, data: { succeeded: runIds, failed: [] } };
  }
  const succeeded: string[] = [];
  const failed: { run_id: string; reason: string }[] = [];
  for (const id of runIds) {
    const r = await finalizeRun(id);
    if (r.ok) succeeded.push(id);
    else failed.push({ run_id: id, reason: r.error ?? "Unknown error" });
  }
  return { ok: true, data: { succeeded, failed } };
}

// ─── Mark a finalized run as paid ─────────────────────────────────────────────

export interface MarkPaidInput {
  run_id: string;
  paid_at?: string | null;
  payment_method?: string | null;
  payment_reference?: string | null;
}

export async function markRunPaid(input: MarkPaidInput): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!input.run_id) return { ok: false, error: "Missing run id" };

  const supabase = await createClient();
  const { data: runRow, error: runError } = await supabase
    .from("payroll_runs")
    .select("id, status, gross_pay, net_pay")
    .eq("id", input.run_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (runError) return { ok: false, error: runError.message };
  if (!runRow) return { ok: false, error: "Run not found" };
  if (runRow.status !== "finalized") {
    return {
      ok: false,
      error: "Only approved runs can be marked paid",
    };
  }

  const paidAt = input.paid_at ?? new Date().toISOString();
  const { error: updateError } = await supabase
    .from("payroll_runs")
    .update({
      status: "paid",
      paid_at: paidAt,
      payment_method: input.payment_method ?? null,
      payment_reference: input.payment_reference ?? null,
    })
    .eq("id", input.run_id);

  if (updateError) {
    console.error("[payroll/runs-actions] markRunPaid failed:", updateError);
    return { ok: false, error: updateError.message };
  }

  // AZ ARS § 23-351(D): deliver the itemized earnings statement now that
  // payment has been released. Fire-and-forget so an SMTP failure never
  // blocks the paid transition; a manual "Resend stub" button surfaces
  // when stub_sent_at stays null.
  await sendPayStubFireAndForget(input.run_id);

  revalidatePath("/payroll");
  revalidatePath("/payroll/runs");
  revalidatePath(`/payroll/runs/${input.run_id}`);
  // Invalidate the cycle hub (dynamic by pay_date) so a second admin viewing
  // /payroll/cycles/[payDate] in another tab sees fresh status on navigation.
  revalidatePath("/payroll/cycles/[payDate]", "page");
  return { ok: true };
}

export interface MarkRunsPaidBatchInput {
  run_ids: string[];
  paid_at?: string | null;
  payment_method?: string | null;
  payment_reference?: string | null;
}

// Bulk mark-paid for a pay cycle. Loops through markRunPaid so per-run
// validation (only approved runs flip to paid), snapshotting, and pay-stub
// delivery all happen exactly as they would for a single-run call. Returns
// succeeded/failed lists so the caller can surface partial outcomes.
export async function markRunsPaidBatch(
  input: MarkRunsPaidBatchInput,
): Promise<
  ActionResult<{
    succeeded: string[];
    failed: { run_id: string; reason: string }[];
  }>
> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) {
    return { ok: true, data: { succeeded: input.run_ids, failed: [] } };
  }
  // One timestamp for every run in the batch. Without this, each iteration
  // would stamp a slightly different millisecond via markRunPaid's default
  // fallback, which would break grouping when reconciling a cycle later.
  const paidAt = input.paid_at ?? new Date().toISOString();
  const succeeded: string[] = [];
  const failed: { run_id: string; reason: string }[] = [];
  for (const id of input.run_ids) {
    const r = await markRunPaid({
      run_id: id,
      paid_at: paidAt,
      payment_method: input.payment_method ?? null,
      payment_reference: input.payment_reference ?? null,
    });
    if (r.ok) succeeded.push(id);
    else failed.push({ run_id: id, reason: r.error ?? "Unknown error" });
  }
  return { ok: true, data: { succeeded, failed } };
}

// ─── Void a run ───────────────────────────────────────────────────────────────

export interface VoidRunInput {
  run_id: string;
  reason: string;
  /** Acknowledge that voiding will leave downstream finalized/paid runs
   *  with stale YTD inputs (FICA caps, FUTA, supplemental thresholds all
   *  depend on earlier gross). When this is false or omitted, voidRun
   *  refuses and surfaces the downstream run count so the admin has to
   *  make the decision explicitly. */
  acknowledge_downstream?: boolean;
}

export interface VoidDownstreamInfo {
  /** Number of finalized/paid runs this employee has AFTER the target's
   *  pay_date. Those runs used the target's gross when computing their YTD
   *  and are now subtly incorrect until recalculated. */
  count: number;
}

export async function voidRun(
  input: VoidRunInput,
): Promise<ActionResult<VoidDownstreamInfo | undefined>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!input.run_id) return { ok: false, error: "Missing run id" };
  if (!input.reason || !input.reason.trim()) {
    return { ok: false, error: "Reason is required to void a run" };
  }

  const supabase = await createClient();
  const { data: runRow, error: runError } = await supabase
    .from("payroll_runs")
    .select("id, employee_id, pay_date, status, gross_pay, net_pay")
    .eq("id", input.run_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (runError) return { ok: false, error: runError.message };
  if (!runRow) return { ok: false, error: "Run not found" };
  if (runRow.status === "voided") {
    return { ok: false, error: "Run is already voided" };
  }

  // H4: look for later finalized/paid runs that were computed with this
  // run's gross as part of their YTD. Voiding leaves their FICA caps,
  // Additional Medicare threshold, FUTA wage-base, and supplemental
  // thresholds silently incorrect. Force the admin to acknowledge so they
  // know they'll likely need to file corrections or re-run later periods.
  const { data: downstream, error: downstreamError } = await supabase
    .from("payroll_runs")
    .select("id")
    .eq("employee_id", runRow.employee_id)
    .gt("pay_date", runRow.pay_date)
    .in("status", ["finalized", "paid"])
    .is("deleted_at", null);
  if (downstreamError) {
    return { ok: false, error: downstreamError.message };
  }
  const downstreamIds = (downstream ?? []).map((r) => r.id);
  const downstreamCount = downstreamIds.length;
  if (downstreamCount > 0 && !input.acknowledge_downstream) {
    return {
      ok: false,
      error: `${downstreamCount} later finalized or paid run${downstreamCount === 1 ? "" : "s"} exist for this employee. Voiding this run will make their YTD totals stale and may require amended filings. Acknowledge to proceed.`,
      data: { count: downstreamCount },
    };
  }

  const { error: updateError } = await supabase
    .from("payroll_runs")
    .update({
      status: "voided",
      void_reason: input.reason.trim(),
    })
    .eq("id", input.run_id);

  if (updateError) {
    console.error("[payroll/runs-actions] voidRun failed:", updateError);
    return { ok: false, error: updateError.message };
  }

  // Tag each downstream finalized/paid run so the UI surfaces the fact
  // that its stored YTD-dependent values (FICA cap, Additional Medicare,
  // FUTA cap, supplemental thresholds) were derived against wages that
  // no longer apply. The admin may then correct those runs manually.
  if (downstreamIds.length > 0) {
    const newReason = `Upstream run voided on ${new Date().toISOString().slice(0, 10)}: ${input.reason.trim()}`;
    // Fetch existing reasons so a second upstream void against the same
    // downstream run appends rather than overwrites. Preserves the full
    // chain of invalidations for the admin review banner.
    const { data: priorRows, error: priorErr } = await supabase
      .from("payroll_runs")
      .select("id, ytd_stale_reason")
      .in("id", downstreamIds);
    if (priorErr) {
      console.error(
        "[payroll/runs-actions] voidRun failed to read prior ytd_stale_reason:",
        priorErr,
      );
    }
    const priorById = new Map<string, string | null>(
      (priorRows ?? []).map((r) => [r.id as string, (r.ytd_stale_reason as string | null) ?? null]),
    );
    for (const id of downstreamIds) {
      const prior = priorById.get(id);
      const composed = prior && prior.length > 0 ? `${prior} | ${newReason}` : newReason;
      const { error: staleError } = await supabase
        .from("payroll_runs")
        .update({ ytd_stale: true, ytd_stale_reason: composed })
        .eq("id", id);
      if (staleError) {
        // Non-fatal: the void already committed. Log so the admin knows to
        // inspect downstream runs manually.
        console.error(
          "[payroll/runs-actions] voidRun failed to flag downstream run as ytd_stale:",
          { id, error: staleError },
        );
      }
    }
  }

  // Strip this run from any scheduled tax deposits and recompute their
  // amounts. Paid deposits are untouched - the money was actually sent and
  // the admin reconciles manually (and may need to file amended returns per
  // the H4 downstream warning above).
  try {
    const depRes = await removeRunFromDeposits(input.run_id);
    if (!depRes.ok) {
      console.error(
        "[payroll/runs-actions] voidRun deposits cleanup failed:",
        depRes.error,
      );
    }
  } catch (err) {
    console.error(
      "[payroll/runs-actions] voidRun deposits cleanup threw:",
      err,
    );
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/runs");
  revalidatePath("/payroll/deposits");
  revalidatePath(`/payroll/runs/${input.run_id}`);
  return { ok: true };
}

// ─── Delete a draft ───────────────────────────────────────────────────────────

export async function deleteDraftRun(runId: string): Promise<ActionResult> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) return { ok: true };
  if (!runId) return { ok: false, error: "Missing run id" };

  const supabase = await createClient();
  const { data: runRow, error: runError } = await supabase
    .from("payroll_runs")
    .select("id, status, gross_pay, net_pay")
    .eq("id", runId)
    .is("deleted_at", null)
    .maybeSingle();
  if (runError) return { ok: false, error: runError.message };
  if (!runRow) return { ok: false, error: "Run not found" };
  if (runRow.status !== "draft") {
    return {
      ok: false,
      error: "Only draft runs can be deleted. Use void for approved runs.",
    };
  }

  const { error: updateError } = await supabase
    .from("payroll_runs")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", runId);

  if (updateError) {
    console.error("[payroll/runs-actions] deleteDraftRun failed:", updateError);
    return { ok: false, error: updateError.message };
  }

  revalidatePath("/payroll");
  revalidatePath("/payroll/run");
  revalidatePath("/payroll/runs");
  return { ok: true };
}

// ─── Utility used by a detail page ────────────────────────────────────────────

/** Compute YTD up to (but not including) this run's pay date. */
export async function getRunYtdContext(
  runId: string,
): Promise<ActionResult<{ ytdBefore: YtdTotals; ytdIncluding: YtdTotals }>> {
  const authError = await requireActionAuth();
  if (authError) return { ok: false, error: authError };
  if (isDemoMode()) {
    return {
      ok: true,
      data: { ytdBefore: { ...ZERO_YTD }, ytdIncluding: { ...ZERO_YTD } },
    };
  }
  const supabase = await createClient();
  const { data: runRow, error: runError } = await supabase
    .from("payroll_runs")
    .select("id, employee_id, pay_date")
    .eq("id", runId)
    .is("deleted_at", null)
    .maybeSingle();
  if (runError) return { ok: false, error: runError.message };
  if (!runRow) return { ok: false, error: "Run not found" };

  const taxYear = taxYearOf(runRow.pay_date);
  const yearStart = `${taxYear}-01-01`;
  const yearEnd = `${taxYear}-12-31`;

  const { data, error } = await supabase
    .from("payroll_runs")
    .select("*")
    .eq("employee_id", runRow.employee_id)
    .is("deleted_at", null)
    .in("status", ["finalized", "paid"])
    .gte("pay_date", yearStart)
    .lte("pay_date", yearEnd);

  if (error) return { ok: false, error: error.message };

  const all = (data as PayrollRun[]) ?? [];
  const ytdBefore = computeYtdThrough(all, taxYear, runRow.pay_date);
  const ytdIncluding = computeYtdThrough(all, taxYear);

  return { ok: true, data: { ytdBefore, ytdIncluding } };
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function deriveFirstPayDate(employee: PayrollEmployee, asOf: Date): string {
  try {
    const period = getNextPayPeriod(
      {
        pay_frequency: employee.pay_frequency,
        pay_anchor_date: employee.pay_anchor_date,
        pay_lag_days: employee.pay_lag_days,
        semimonthly_days: employee.semimonthly_days,
        monthly_day: employee.monthly_day,
      },
      asOf,
    );
    return period.pay_date;
  } catch {
    // Fall back to today's date string if schedule is misconfigured.
    const y = asOf.getUTCFullYear();
    const m = String(asOf.getUTCMonth() + 1).padStart(2, "0");
    const d = String(asOf.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}
