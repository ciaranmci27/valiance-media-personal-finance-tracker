"use client";

import * as React from "react";
import { Calculator, Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { demoIncomeEntries } from "@/lib/demo/data";
import {
  FILING_STATUS_LABELS,
  type FilingStatus,
} from "@/lib/tax/constants";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import type { BusinessType, TaxClassification } from "@/types/database";
import { createTemplateIncomeSources } from "@/lib/tax/templates";

// ============================================================================
// Shared constants / helpers (exported for use in settings + estimator)
// ============================================================================

const FILING_STATUS_OPTIONS = (
  Object.entries(FILING_STATUS_LABELS) as [FilingStatus, string][]
).map(([value, label]) => ({ value, label }));

export const BUSINESS_TYPE_OPTIONS = [
  { value: "none", label: "No Business" },
  { value: "sole_prop", label: "Sole Proprietor" },
  { value: "llc", label: "LLC" },
  { value: "s_corp", label: "S-Corp" },
  { value: "c_corp", label: "C-Corp" },
  { value: "partnership", label: "Partnership" },
];

export const TAX_CLASSIFICATION_LABELS: Record<TaxClassification, string> = {
  sole_prop: "Sole Proprietor",
  disregarded: "Disregarded Entity",
  s_corp: "S-Corp (Form 2553)",
  c_corp: "C-Corp (Form 8832)",
  partnership: "Partnership",
};

/** Returns classification options that are valid for the given business structure. */
export function getClassificationOptions(
  businessType: BusinessType
): { value: string; label: string }[] {
  switch (businessType) {
    case "none":
      return [];
    case "sole_prop":
      return [{ value: "sole_prop", label: "Sole Proprietor" }];
    case "llc":
      return [
        { value: "disregarded", label: "Disregarded Entity / Sole Prop" },
        { value: "s_corp", label: "S-Corp (Form 2553)" },
        { value: "c_corp", label: "C-Corp (Form 8832)" },
        { value: "partnership", label: "Partnership (multi-member)" },
      ];
    case "s_corp":
      return [{ value: "s_corp", label: "S-Corp" }];
    case "c_corp":
      return [{ value: "c_corp", label: "C-Corp" }];
    case "partnership":
      return [{ value: "partnership", label: "Partnership" }];
    default:
      return [];
  }
}

/** Returns the default classification for a given business structure. */
export function getDefaultClassification(
  businessType: BusinessType
): TaxClassification | null {
  switch (businessType) {
    case "none":
      return null;
    case "sole_prop":
      return "sole_prop";
    case "llc":
      return "disregarded";
    case "s_corp":
      return "s_corp";
    case "c_corp":
      return "c_corp";
    case "partnership":
      return "partnership";
    default:
      return null;
  }
}

// ============================================================================
// Types
// ============================================================================

interface ProfileConfig {
  filingStatus: FilingStatus;
  state: string | null;
  businessType: BusinessType;
  taxClassification: TaxClassification | null;
  dependents: number;
}

interface TaxSetupWizardProps {
  onComplete: () => void;
  selectedYear: number;
}

// ============================================================================
// Wizard Component
// ============================================================================

export function TaxSetupCard({ onComplete, selectedYear }: TaxSetupWizardProps) {
  const router = useRouter();

  // Step tracking
  const [step, setStep] = React.useState<1 | 2>(1);

  // Base profile (Step 1)
  const [filingStatus, setFilingStatus] = React.useState<FilingStatus>("single");
  const [state, setState] = React.useState<string>("");
  const [businessType, setBusinessType] = React.useState<BusinessType>("none");
  const [taxClassification, setTaxClassification] = React.useState<TaxClassification | null>(null);
  const [dependents, setDependents] = React.useState(0);

  // Step 2 state
  const [eligibleYears, setEligibleYears] = React.useState<number[]>([]);
  const [selectedYears, setSelectedYears] = React.useState<Set<number>>(new Set());
  const [yearOverrides, setYearOverrides] = React.useState<Record<number, ProfileConfig>>({});
  const [expandedYear, setExpandedYear] = React.useState<number | null>(null);
  const [loadingYears, setLoadingYears] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [addYearValue, setAddYearValue] = React.useState("");
  const [showAddYear, setShowAddYear] = React.useState(false);

  const classificationOptions = getClassificationOptions(businessType);
  const showClassification = classificationOptions.length > 1;

  const handleBusinessTypeChange = (val: string) => {
    const bt = val as BusinessType;
    setBusinessType(bt);
    setTaxClassification(getDefaultClassification(bt));
  };

  // ------------------------------------------------------------------
  // Step 1 -> Step 2: detect years with income data
  // ------------------------------------------------------------------

  const handleContinue = async () => {
    setLoadingYears(true);
    setStep(2);

    try {
      let incomeYears: number[] = [];

      if (isDemoMode()) {
        const yearSet = new Set<number>();
        for (const entry of demoIncomeEntries) {
          const year = new Date(entry.month).getFullYear();
          yearSet.add(year);
        }
        incomeYears = Array.from(yearSet);
      } else {
        const supabase = createClient();
        const { data } = await supabase
          .from("income_entries")
          .select("month")
          .is("deleted_at", null);

        if (data) {
          const yearSet = new Set<number>();
          for (const row of data) {
            const year = new Date(row.month).getFullYear();
            yearSet.add(year);
          }
          incomeYears = Array.from(yearSet);
        }
      }

      // Fallback: if no income data at all, offer the current year
      if (incomeYears.length === 0) {
        incomeYears.push(selectedYear);
      }

      incomeYears.sort((a, b) => b - a);
      setEligibleYears(incomeYears);
      setSelectedYears(new Set(incomeYears));
    } catch {
      setEligibleYears([selectedYear]);
      setSelectedYears(new Set([selectedYear]));
    } finally {
      setLoadingYears(false);
    }
  };

  // ------------------------------------------------------------------
  // Get profile for a specific year (base + overrides)
  // ------------------------------------------------------------------

  const getProfileForYear = (year: number): ProfileConfig => {
    if (yearOverrides[year]) return yearOverrides[year];
    return {
      filingStatus,
      state: state || null,
      businessType,
      taxClassification: businessType === "none" ? null : taxClassification,
      dependents,
    };
  };

  const updateYearOverride = (year: number, updates: Partial<ProfileConfig>) => {
    setYearOverrides((prev) => ({
      ...prev,
      [year]: { ...getProfileForYear(year), ...updates },
    }));
  };

  // ------------------------------------------------------------------
  // Create all rows and finish
  // ------------------------------------------------------------------

  const toggleYear = (year: number) => {
    setSelectedYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) {
        next.delete(year);
        if (expandedYear === year) setExpandedYear(null);
      } else {
        next.add(year);
      }
      return next;
    });
  };

  const addYear = () => {
    const year = Number(addYearValue);
    if (!year || year < 2000 || year > 2100) return;
    if (eligibleYears.includes(year)) {
      // Already exists, just make sure it's selected
      setSelectedYears((prev) => new Set(prev).add(year));
    } else {
      setEligibleYears((prev) => [year, ...prev].sort((a, b) => b - a));
      setSelectedYears((prev) => new Set(prev).add(year));
    }
    setAddYearValue("");
    setShowAddYear(false);
  };

  const removeYear = (year: number) => {
    setEligibleYears((prev) => prev.filter((y) => y !== year));
    setSelectedYears((prev) => {
      const next = new Set(prev);
      next.delete(year);
      return next;
    });
    if (expandedYear === year) setExpandedYear(null);
    // Clean up any overrides
    setYearOverrides((prev) => {
      const next = { ...prev };
      delete next[year];
      return next;
    });
  };

  const handleFinish = async () => {
    if (selectedYears.size === 0) return;
    setCreating(true);

    const yearsToCreate = eligibleYears.filter((y) => selectedYears.has(y));

    try {
      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 400));
      } else {
        const supabase = createClient();

        const rows = yearsToCreate.map((year) => {
          const profile = getProfileForYear(year);
          return {
            tax_year: year,
            filing_status: profile.filingStatus,
            state: profile.state,
            business_type: profile.businessType,
            tax_classification: profile.taxClassification,
            dependents: profile.dependents,
            income_sources: createTemplateIncomeSources(profile.businessType, profile.taxClassification) as unknown as Record<string, unknown>[],
            capital_gains: [] as unknown as Record<string, unknown>[],
            payments: [] as unknown as Record<string, unknown>[],
            additional_deductions: 0,
            notes: null,
          };
        });

        await supabase.from("tax_estimates").insert(rows);
      }

      router.refresh();
      onComplete();
    } catch {
      setCreating(false);
    }
  };

  // ------------------------------------------------------------------
  // Render: Step 1
  // ------------------------------------------------------------------

  if (step === 1) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-full max-w-2xl mx-auto animate-fade-up space-y-6">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="flex justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Calculator className="h-6 w-6 text-primary" />
              </div>
            </div>
            <h2 className="text-xl font-semibold text-foreground">
              Set Up Your Tax Estimator
            </h2>
            <p className="text-sm text-muted-foreground">
              A few quick questions to configure your estimate.
            </p>
          </div>

          {/* Filing Profile */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Filing Profile
              </h2>
              <div className="flex-1 h-px bg-border/50" />
            </div>

            <div className="glass-card rounded-xl p-5 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <CustomSelect
                  label="Filing Status"
                  value={filingStatus}
                  onChange={(val) => setFilingStatus(val as FilingStatus)}
                  options={FILING_STATUS_OPTIONS}
                  size="sm"
                />
                <CustomSelect
                  label="State"
                  value={state}
                  onChange={setState}
                  options={[{ value: "", label: "No State Tax" }, ...STATE_OPTIONS]}
                  placeholder="Select state"
                  size="sm"
                />
                <CustomSelect
                  label="Business Structure"
                  value={businessType}
                  onChange={handleBusinessTypeChange}
                  options={BUSINESS_TYPE_OPTIONS}
                  size="sm"
                />
                {showClassification && (
                  <CustomSelect
                    label="Tax Classification"
                    value={taxClassification ?? ""}
                    onChange={(val) => setTaxClassification(val as TaxClassification)}
                    options={classificationOptions}
                    size="sm"
                  />
                )}
                <NumberInput
                  integer
                  label="Dependents"
                  value={dependents || ""}
                  onChange={(e) => setDependents(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="0"
                  className="h-8 text-sm bg-card border-input"
                />
              </div>
            </div>
          </div>

          {/* Continue */}
          <div className="flex justify-end">
            <Button onClick={handleContinue}>
              Continue
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render: Step 2 - Year Detection + Per-Year Customization
  // ------------------------------------------------------------------

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-2xl mx-auto animate-fade-up space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Calculator className="h-6 w-6 text-primary" />
            </div>
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            Tax Years Detected
          </h2>
          <p className="text-sm text-muted-foreground">
            We found income data for {eligibleYears.length} {eligibleYears.length === 1 ? "year" : "years"}.
            Select which years to set up and customize settings per year if needed.
          </p>
        </div>

        {loadingYears ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Year Cards */}
            <div className="space-y-3">
              {eligibleYears.map((year) => {
                const isSelected = selectedYears.has(year);
                const profile = getProfileForYear(year);
                const isExpanded = expandedYear === year;
                const isCustomized = !!yearOverrides[year];
                const yearClassificationOptions = getClassificationOptions(profile.businessType);
                const yearShowClassification = yearClassificationOptions.length > 1;

                return (
                  <div
                    key={year}
                    className={cn(
                      "glass-card rounded-xl overflow-hidden transition-all duration-200",
                      !isSelected && "opacity-50"
                    )}
                  >
                    {/* Year Header */}
                    <div className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-3">
                        {/* Checkbox */}
                        <button
                          type="button"
                          onClick={() => toggleYear(year)}
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/40 bg-transparent"
                          )}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </button>
                        <span className="text-lg font-semibold text-foreground">{year}</span>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span>{FILING_STATUS_LABELS[profile.filingStatus]}</span>
                          {profile.state && (
                            <>
                              <span className="text-border">·</span>
                              <span>{profile.state}</span>
                            </>
                          )}
                          {profile.businessType !== "none" && (
                            <>
                              <span className="text-border">·</span>
                              <span>
                                {BUSINESS_TYPE_OPTIONS.find((o) => o.value === profile.businessType)?.label}
                                {profile.taxClassification && profile.businessType === "llc" && profile.taxClassification !== "disregarded"
                                  ? ` \u203A ${TAX_CLASSIFICATION_LABELS[profile.taxClassification]}`
                                  : ""}
                              </span>
                            </>
                          )}
                          {isCustomized && (
                            <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-primary/10 text-primary">
                              Customized
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {isSelected && (
                          <button
                            onClick={() => setExpandedYear(isExpanded ? null : year)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            {isExpanded ? "Collapse" : "Edit"}
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                        <Tooltip content={`Remove ${year}`}>
                          <button
                            onClick={() => removeYear(year)}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/50 hover:text-error hover:bg-error/10 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </div>

                    {/* Expanded Fields */}
                    {isSelected && isExpanded && (
                      <div className="border-t border-border/50 p-4 pt-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <CustomSelect
                            label="Filing Status"
                            value={profile.filingStatus}
                            onChange={(val) =>
                              updateYearOverride(year, { filingStatus: val as FilingStatus })
                            }
                            options={FILING_STATUS_OPTIONS}
                            size="sm"
                          />
                          <CustomSelect
                            label="State"
                            value={profile.state ?? ""}
                            onChange={(val) =>
                              updateYearOverride(year, { state: val || null })
                            }
                            options={[{ value: "", label: "No State Tax" }, ...STATE_OPTIONS]}
                            placeholder="Select state"
                            size="sm"
                          />
                          <CustomSelect
                            label="Business Structure"
                            value={profile.businessType}
                            onChange={(val) => {
                              const bt = val as BusinessType;
                              updateYearOverride(year, {
                                businessType: bt,
                                taxClassification: getDefaultClassification(bt),
                              });
                            }}
                            options={BUSINESS_TYPE_OPTIONS}
                            size="sm"
                          />
                          {yearShowClassification && (
                            <CustomSelect
                              label="Tax Classification"
                              value={profile.taxClassification ?? ""}
                              onChange={(val) =>
                                updateYearOverride(year, {
                                  taxClassification: val as TaxClassification,
                                })
                              }
                              options={yearClassificationOptions}
                              size="sm"
                            />
                          )}
                          <NumberInput
                            integer
                            label="Dependents"
                            value={profile.dependents || ""}
                            onChange={(e) =>
                              updateYearOverride(year, {
                                dependents: Math.max(0, Number(e.target.value) || 0),
                              })
                            }
                            placeholder="0"
                            className="h-8 text-sm bg-card border-input"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add Year */}
            {showAddYear ? (
              <div className="flex items-center gap-2">
                <NumberInput
                  integer
                  placeholder="e.g. 2024"
                  value={addYearValue}
                  onChange={(e) => setAddYearValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addYear()}
                  className="h-8 w-28 text-sm"
                  autoFocus
                />
                <Button size="sm" variant="ghost" onClick={addYear} className="h-8 text-xs">
                  Add
                </Button>
                <button
                  onClick={() => { setShowAddYear(false); setAddYearValue(""); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAddYear(true)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Add a year manually
              </button>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setStep(1)}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Back
              </button>
              <Button onClick={handleFinish} disabled={creating || selectedYears.size === 0}>
                {creating && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {selectedYears.size === 0
                  ? "Select at least one year"
                  : `Start Estimating (${selectedYears.size} ${selectedYears.size === 1 ? "year" : "years"})`}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
