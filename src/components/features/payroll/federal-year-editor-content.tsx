"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Landmark,
  Loader2,
  Plus,
  Trash2,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { recordConfigChange } from "@/lib/payroll/audit";
import {
  federalTaxConfigWriteSchema,
  formatZodError,
} from "@/lib/payroll/schemas";
import { getTaxYearDefaults, getAvailableTaxYears } from "@/lib/tax-core";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import {
  FILING_STATUS_LABELS,
  type FederalBracket,
  type FederalBrackets,
  type FederalBracketsByStatus,
  type FederalTaxConfig,
  type FicaConfig,
  type FilingStatus,
  type FutaConfig,
  type StdDeductions,
} from "@/types/payroll";

interface Props {
  year: number;
  initial: FederalTaxConfig | null;
  priorYear: FederalTaxConfig | null;
}

const FILING_STATUSES: FilingStatus[] = ["single", "mfj", "mfs", "hoh"];

const PERIOD_OPTIONS: { value: FederalBrackets["period"]; label: string }[] = [
  { value: "annual", label: "Annual" },
  { value: "monthly", label: "Monthly" },
  { value: "semimonthly", label: "Semimonthly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "weekly", label: "Weekly" },
];

// Avoid caret-jumping: show the user's typed value without forced trailing zeros.
// Normalizes decimal rate to display percent, preserving short forms like "6.2" vs "6.200".
function toPercentDisplay(decimal: number): string {
  if (!Number.isFinite(decimal)) return "";
  const pct = decimal * 100;
  return String(Number(pct.toFixed(4)));
}

function emptyBrackets(): FederalBracketsByStatus {
  return {
    single: [],
    mfj: [],
    mfs: [],
    hoh: [],
  };
}

// Pull defaults from tax-core for the requested year. When a year has no
// tax-core entry yet (e.g., admin is pre-seeding a future year), fall back
// to the most recent year that does, and let the admin tweak as needed.
function resolveDefaults(year: number) {
  const direct = getTaxYearDefaults(year);
  if (direct) return direct;
  const latest = getAvailableTaxYears()[0];
  return getTaxYearDefaults(latest);
}

function defaultFica(year: number): FicaConfig {
  const d = resolveDefaults(year);
  if (d) return { ...d.payrollFica };
  return {
    ss_rate: 0.062,
    ss_wage_base: 184500,
    medicare_rate: 0.0145,
    additional_medicare_rate: 0.009,
    additional_medicare_threshold: 200000,
  };
}

function defaultFuta(year: number): FutaConfig {
  const d = resolveDefaults(year);
  if (d) return { ...d.payrollFuta };
  return { rate: 0.006, wage_base: 7000 };
}

function defaultStdDeductions(year: number): StdDeductions {
  const d = resolveDefaults(year);
  if (d) return { ...d.standardDeductions };
  return { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150 };
}

// Deterministic JSON: sort object keys recursively so version_hash is stable
// regardless of insertion order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

async function computeVersionHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(payload));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// FUTA credit-reduction states: IRS publishes an annual list of states that
// haven't repaid federal unemployment loans. Employers in those states pay
// FUTA at an elevated effective rate (0.6% base + reduction). Stored on
// FutaConfig as { state_code: reduction_rate } and applied per-employee by
// engine.ts based on employee.state_code.
interface CreditReductionEditorProps {
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}

function CreditReductionEditor({ value, onChange }: CreditReductionEditorProps) {
  const entries = Object.entries(value);

  const availableOptions = React.useMemo(
    () => STATE_OPTIONS.filter((opt) => !(opt.value in value)),
    [value],
  );

  const addState = () => {
    const first = availableOptions[0];
    if (!first) return;
    onChange({ ...value, [first.value]: 0.003 });
  };

  const updateState = (oldCode: string, newCode: string) => {
    if (oldCode === newCode) return;
    const next: Record<string, number> = {};
    for (const [code, rate] of entries) {
      next[code === oldCode ? newCode : code] = rate;
    }
    onChange(next);
  };

  const updateRate = (code: string, rate: number) => {
    onChange({ ...value, [code]: rate });
  };

  const removeState = (code: string) => {
    const next = { ...value };
    delete next[code];
    onChange(next);
  };

  return (
    <div className="space-y-3 pt-2 border-t border-border/40">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Credit-Reduction States</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Additional FUTA rate applied on top of the base rate for employees
            in these states. Per IRS Schedule A (Form 940).
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-sm text-muted-foreground italic px-2 py-3">
          No credit-reduction states configured.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>State</span>
            <span>Reduction Rate (%)</span>
            <span className="w-8" />
          </div>
          {entries.map(([code, rate]) => {
            const optionsForThisRow = STATE_OPTIONS.filter(
              (opt) => opt.value === code || !(opt.value in value),
            );
            return (
              <div
                key={code}
                className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center"
              >
                <CustomSelect
                  value={code}
                  onChange={(next) => updateState(code, next)}
                  options={optionsForThisRow}
                />
                <NumberInput
                  value={toPercentDisplay(rate)}
                  onChange={(e) =>
                    updateRate(code, Number(e.target.value) / 100)
                  }
                  placeholder="0.3"
                  className="h-9 text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeState(code)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/60 hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  aria-label={`Remove ${code} from credit-reduction states`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={addState}
        disabled={availableOptions.length === 0}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md px-1 py-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add State
      </button>
    </div>
  );
}

export function FederalYearEditorContent({ year, initial, priorYear }: Props) {
  const router = useRouter();
  const supabase = React.useMemo(() => createClient(), []);

  const [brackets, setBrackets] = React.useState<FederalBrackets>(() => {
    if (initial) return initial.brackets;
    return {
      period: "annual",
      source: `Pub 15-T ${year} percentage method`,
      w4_step2_unchecked: emptyBrackets(),
    };
  });

  const [fica, setFica] = React.useState<FicaConfig>(
    initial?.fica ?? defaultFica(year)
  );
  const [futa, setFuta] = React.useState<FutaConfig>(
    initial?.futa ?? defaultFuta(year)
  );
  const [stdDeductions, setStdDeductions] = React.useState<StdDeductions>(
    initial?.std_deductions ?? defaultStdDeductions(year)
  );
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [activeStatus, setActiveStatus] = React.useState<FilingStatus>("single");
  const [saving, setSaving] = React.useState(false);

  const statusBrackets = brackets.w4_step2_unchecked[activeStatus];

  const updateBracket = (idx: number, patch: Partial<FederalBracket>) => {
    setBrackets((prev) => {
      const next = [...prev.w4_step2_unchecked[activeStatus]];
      next[idx] = { ...next[idx], ...patch };
      return {
        ...prev,
        w4_step2_unchecked: {
          ...prev.w4_step2_unchecked,
          [activeStatus]: next,
        },
      };
    });
  };

  const addBracket = () => {
    setBrackets((prev) => {
      const current = prev.w4_step2_unchecked[activeStatus];
      const last = current[current.length - 1];
      const newRow: FederalBracket = {
        min: last?.max ?? 0,
        max: null,
        rate: 0,
        base_tax: 0,
      };
      return {
        ...prev,
        w4_step2_unchecked: {
          ...prev.w4_step2_unchecked,
          [activeStatus]: [...current, newRow],
        },
      };
    });
  };

  const removeBracket = (idx: number) => {
    setBrackets((prev) => {
      const next = prev.w4_step2_unchecked[activeStatus].filter(
        (_, i) => i !== idx
      );
      return {
        ...prev,
        w4_step2_unchecked: {
          ...prev.w4_step2_unchecked,
          [activeStatus]: next,
        },
      };
    });
  };

  const handleCopyFromPriorYear = () => {
    if (!priorYear) return;
    setBrackets(priorYear.brackets);
    setFica(priorYear.fica);
    setFuta(priorYear.futa);
    setStdDeductions(priorYear.std_deductions);
    setNotes(
      priorYear.notes
        ? `${priorYear.notes}\n\nCopied from ${priorYear.tax_year}.`
        : `Copied from ${priorYear.tax_year}.`
    );
    toast("success", `Copied config from ${priorYear.tax_year}`);
  };

  const handleSave = async () => {
    const candidate = {
      tax_year: year,
      brackets,
      fica,
      futa,
      std_deductions: stdDeductions,
      notes: notes.trim() || null,
    };
    const parsed = federalTaxConfigWriteSchema.safeParse(candidate);
    if (!parsed.success) {
      toast("error", formatZodError(parsed.error));
      return;
    }

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not persisted");
      return;
    }

    setSaving(true);
    try {
      const fingerprint = { brackets, fica, futa, std_deductions: stdDeductions };
      const version_hash = await computeVersionHash(fingerprint);

      const payload = {
        ...candidate,
        version_hash,
      };

      let rowId: string;
      let oldValues: Record<string, unknown> | null = null;

      if (initial) {
        oldValues = { ...initial } as unknown as Record<string, unknown>;
        const { error } = await supabase
          .from("federal_tax_configs")
          .update(payload)
          .eq("id", initial.id);
        if (error) throw error;
        rowId = initial.id;
      } else {
        const { data, error } = await supabase
          .from("federal_tax_configs")
          .insert(payload)
          .select("id")
          .single();
        if (error) throw error;
        rowId = data.id;
      }

      await recordConfigChange(supabase, {
        configType: "federal",
        configId: rowId,
        oldValues,
        newValues: payload as unknown as Record<string, unknown>,
        summary: initial
          ? `Updated federal config for ${year}`
          : `Created federal config for ${year}`,
      });

      toast("success", `Saved ${year} federal tax config`);
      router.push("/payroll/config/federal");
      router.refresh();
    } catch (err) {
      console.error("[federal-editor] save failed:", err);
      toast("error", "Failed to save federal config");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#C5A68F]/10">
              <Landmark className="h-5 w-5 text-[#C5A68F]" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{year} Federal Tax Config</h1>
              <p className="text-sm text-muted-foreground">
                IRS Publication 15-T percentage method
              </p>
            </div>
          </div>
        </div>
        {!initial && priorYear && (
          <Button size="sm" variant="outline" onClick={handleCopyFromPriorYear}>
            <Copy className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Copy from {priorYear.tax_year}
          </Button>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            FICA
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="Social Security Rate (%)"
              value={toPercentDisplay(fica.ss_rate)}
              onChange={(e) =>
                setFica({ ...fica, ss_rate: Number(e.target.value) / 100 })
              }
              placeholder="6.2"
            />
            <NumberInput
              label="SS Wage Base ($)"
              value={fica.ss_wage_base}
              onChange={(e) =>
                setFica({ ...fica, ss_wage_base: Number(e.target.value) })
              }
              integer
              placeholder="184500"
            />
            <NumberInput
              label="Medicare Rate (%)"
              value={toPercentDisplay(fica.medicare_rate)}
              onChange={(e) =>
                setFica({ ...fica, medicare_rate: Number(e.target.value) / 100 })
              }
              placeholder="1.45"
            />
            <NumberInput
              label="Additional Medicare Rate (%)"
              value={toPercentDisplay(fica.additional_medicare_rate)}
              onChange={(e) =>
                setFica({
                  ...fica,
                  additional_medicare_rate: Number(e.target.value) / 100,
                })
              }
              placeholder="0.9"
            />
            <NumberInput
              label="Additional Medicare Threshold ($)"
              value={fica.additional_medicare_threshold}
              onChange={(e) =>
                setFica({
                  ...fica,
                  additional_medicare_threshold: Number(e.target.value),
                })
              }
              integer
              placeholder="200000"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            FUTA
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="FUTA Rate (%)"
              value={toPercentDisplay(futa.rate)}
              onChange={(e) =>
                setFuta({ ...futa, rate: Number(e.target.value) / 100 })
              }
              placeholder="6.0"
            />
            <NumberInput
              label="FUTA Wage Base ($)"
              value={futa.wage_base}
              onChange={(e) =>
                setFuta({ ...futa, wage_base: Number(e.target.value) })
              }
              integer
              placeholder="7000"
            />
          </div>

          <CreditReductionEditor
            value={futa.credit_reduction_states ?? {}}
            onChange={(next) =>
              setFuta({
                ...futa,
                credit_reduction_states:
                  Object.keys(next).length === 0 ? undefined : next,
              })
            }
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Standard Deductions
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {FILING_STATUSES.map((status) => (
              <NumberInput
                key={status}
                label={FILING_STATUS_LABELS[status]}
                value={stdDeductions[status]}
                onChange={(e) =>
                  setStdDeductions({
                    ...stdDeductions,
                    [status]: Number(e.target.value),
                  })
                }
                integer
                placeholder="0"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Percentage-Method Brackets
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div className="glass-card rounded-xl p-6 space-y-4">
          <div
            className="flex items-center gap-2 flex-wrap"
            role="tablist"
            aria-label="Filing status"
          >
            {FILING_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                role="tab"
                aria-selected={activeStatus === status}
                aria-pressed={activeStatus === status}
                onClick={() => setActiveStatus(status)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  activeStatus === status
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                )}
              >
                {FILING_STATUS_LABELS[status]}
              </button>
            ))}
          </div>

          <CustomSelect
            label="Period"
            value={brackets.period}
            onChange={(value) =>
              setBrackets({
                ...brackets,
                period: value as FederalBrackets["period"],
              })
            }
            options={PERIOD_OPTIONS}
          />

          <Input
            label="Source"
            value={brackets.source}
            onChange={(e) => setBrackets({ ...brackets, source: e.target.value })}
            placeholder="Pub 15-T 2026 percentage method"
          />

          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Min ($)</span>
              <span>Max ($)</span>
              <span>Rate (%)</span>
              <span>Base Tax ($)</span>
              <span className="w-8" />
            </div>
            {statusBrackets.length === 0 ? (
              <div className="text-sm text-muted-foreground italic px-2 py-3">
                No brackets yet. Click &quot;Add Row&quot; to begin.
              </div>
            ) : (
              statusBrackets.map((row, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-center"
                >
                  <NumberInput
                    value={row.min}
                    onChange={(e) =>
                      updateBracket(idx, { min: Number(e.target.value) })
                    }
                    placeholder="0.00"
                    className="h-9 text-sm"
                  />
                  <NumberInput
                    value={row.max ?? ""}
                    onChange={(e) =>
                      updateBracket(idx, {
                        max:
                          e.target.value === ""
                            ? null
                            : Number(e.target.value),
                      })
                    }
                    placeholder="no cap"
                    className="h-9 text-sm"
                  />
                  <NumberInput
                    value={toPercentDisplay(row.rate)}
                    onChange={(e) =>
                      updateBracket(idx, {
                        rate: Number(e.target.value) / 100,
                      })
                    }
                    placeholder="0.00"
                    className="h-9 text-sm"
                  />
                  <NumberInput
                    value={row.base_tax}
                    onChange={(e) =>
                      updateBracket(idx, {
                        base_tax: Number(e.target.value),
                      })
                    }
                    placeholder="0.00"
                    className="h-9 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeBracket(idx)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/60 hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label={`Remove bracket row ${idx + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))
            )}
          </div>

          <button
            type="button"
            onClick={addBracket}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md px-1 py-0.5"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add Row
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Notes
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. 2025 brackets carried forward pending Pub 15-T 2026 release."
            rows={3}
          />
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />}
          {initial ? "Save Changes" : `Create ${year} Config`}
        </Button>
      </div>
    </div>
  );
}
