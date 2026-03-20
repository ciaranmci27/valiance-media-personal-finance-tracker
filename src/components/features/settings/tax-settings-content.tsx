"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Calculator,
  Loader2,
  Check,
  Pencil,
  ChevronDown,
  ChevronRight,
  Copy,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { demoTaxEstimates } from "@/lib/demo/data";
import { FILING_STATUS_LABELS, type FilingStatus } from "@/lib/tax/constants";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import {
  BUSINESS_TYPE_OPTIONS,
  TAX_CLASSIFICATION_LABELS,
  getClassificationOptions,
  getDefaultClassification,
} from "@/components/features/tax/tax-setup-card";
import type { BusinessType, TaxClassification, TaxEstimate } from "@/types/database";

const FILING_STATUS_OPTIONS = (
  Object.entries(FILING_STATUS_LABELS) as [FilingStatus, string][]
).map(([value, label]) => ({ value, label }));

interface YearProfile {
  id: string;
  taxYear: number;
  filingStatus: FilingStatus;
  state: string;
  businessType: BusinessType;
  taxClassification: TaxClassification | null;
  dirty: boolean;
}

function profileFromEstimate(est: TaxEstimate): YearProfile {
  return {
    id: est.id,
    taxYear: est.tax_year,
    filingStatus: est.filing_status,
    state: est.state ?? "",
    businessType: (est.business_type as BusinessType) ?? "none",
    taxClassification: (est.tax_classification as TaxClassification) ?? null,
    dirty: false,
  };
}

export function TaxSettingsContent() {
  const searchParams = useSearchParams();
  const initialYear = searchParams.get("year");
  const { confirm, dialog: confirmDialog } = useConfirmationDialog();

  const [loading, setLoading] = React.useState(true);
  const [yearProfiles, setYearProfiles] = React.useState<YearProfile[]>([]);
  const [expandedYear, setExpandedYear] = React.useState<number | null>(
    initialYear ? Number(initialYear) : null
  );

  // Per-year save state
  const [savingYear, setSavingYear] = React.useState<number | null>(null);
  const [savedYear, setSavedYear] = React.useState<number | null>(null);

  // "Apply to all" state
  const [applyingAll, setApplyingAll] = React.useState(false);

  // Add year state
  const [showAddYear, setShowAddYear] = React.useState(false);
  const [addYearValue, setAddYearValue] = React.useState("");
  const [addingYear, setAddingYear] = React.useState(false);

  // Load estimates
  React.useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        let data: TaxEstimate[];

        if (isDemoMode()) {
          data = demoTaxEstimates;
        } else {
          const supabase = createClient();
          const result = await supabase
            .from("tax_estimates")
            .select("*")
            .is("deleted_at", null)
            .order("tax_year", { ascending: false });
          data = (result.data as TaxEstimate[]) ?? [];
        }

        setYearProfiles(data.map(profileFromEstimate));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  // Update a single year's profile field
  const updateYear = (taxYear: number, updates: Partial<YearProfile>) => {
    setYearProfiles((prev) =>
      prev.map((p) =>
        p.taxYear === taxYear ? { ...p, ...updates, dirty: true } : p
      )
    );
  };

  // Save a single year
  const saveYear = async (taxYear: number) => {
    const profile = yearProfiles.find((p) => p.taxYear === taxYear);
    if (!profile) return;

    setSavingYear(taxYear);
    setSavedYear(null);

    try {
      const updates = {
        filing_status: profile.filingStatus,
        state: profile.state || null,
        business_type: profile.businessType,
        tax_classification: profile.businessType === "none" ? null : profile.taxClassification,
      };

      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const supabase = createClient();
        await supabase
          .from("tax_estimates")
          .update(updates)
          .eq("id", profile.id);
      }

      setYearProfiles((prev) =>
        prev.map((p) => (p.taxYear === taxYear ? { ...p, dirty: false } : p))
      );
      setSavedYear(taxYear);
      setTimeout(() => setSavedYear(null), 2000);
    } finally {
      setSavingYear(null);
    }
  };

  // Apply one year's profile to all other years
  const applyToAll = async (sourceTaxYear: number) => {
    const source = yearProfiles.find((p) => p.taxYear === sourceTaxYear);
    if (!source) return;

    const otherCount = yearProfiles.length - 1;
    if (otherCount === 0) return;

    const confirmed = await confirm({
      title: "Apply to all years?",
      description: `This will overwrite the filing profile for ${otherCount} other year${otherCount > 1 ? "s" : ""} with ${sourceTaxYear}'s settings (${FILING_STATUS_LABELS[source.filingStatus]}${source.state ? `, ${source.state}` : ""}).`,
      confirmLabel: "Apply to All",
      variant: "danger",
      doubleConfirm: true,
      doubleConfirmLabel: "Overwrite All",
    });
    if (!confirmed) return;

    setApplyingAll(true);

    try {
      const updates = {
        filing_status: source.filingStatus,
        state: source.state || null,
        business_type: source.businessType,
        tax_classification: source.businessType === "none" ? null : source.taxClassification,
      };

      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const supabase = createClient();
        for (const profile of yearProfiles) {
          await supabase
            .from("tax_estimates")
            .update(updates)
            .eq("id", profile.id);
        }
      }

      // Update local state to reflect the change
      setYearProfiles((prev) =>
        prev.map((p) => ({
          ...p,
          filingStatus: source.filingStatus,
          state: source.state,
          businessType: source.businessType,
          taxClassification: source.taxClassification,
          dirty: false,
        }))
      );
      toast("success", `Applied ${sourceTaxYear} settings to all years`);
    } finally {
      setApplyingAll(false);
    }
  };

  // Add a new year manually
  const addYear = async () => {
    const year = Number(addYearValue);
    if (!year || year < 2000 || year > 2100) return;
    if (yearProfiles.some((p) => p.taxYear === year)) {
      // Already exists, just expand it
      setExpandedYear(year);
      setShowAddYear(false);
      setAddYearValue("");
      return;
    }

    setAddingYear(true);

    try {
      const baseProfile = yearProfiles[0];
      const newRow = {
        tax_year: year,
        filing_status: baseProfile?.filingStatus ?? ("single" as FilingStatus),
        state: baseProfile?.state || null,
        business_type: baseProfile?.businessType ?? ("none" as BusinessType),
        tax_classification: baseProfile?.taxClassification ?? null,
        income_sources: [] as unknown as Record<string, unknown>[],
        capital_gains: [] as unknown as Record<string, unknown>[],
        payments: [] as unknown as Record<string, unknown>[],
        additional_deductions: 0,
        notes: null,
      };

      let newId = `new-${year}`;

      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const supabase = createClient();
        const { data } = await supabase
          .from("tax_estimates")
          .insert(newRow)
          .select("id")
          .single();
        if (data) newId = data.id;
      }

      const newProfile: YearProfile = {
        id: newId,
        taxYear: year,
        filingStatus: newRow.filing_status as FilingStatus,
        state: newRow.state ?? "",
        businessType: newRow.business_type as BusinessType,
        taxClassification: newRow.tax_classification as TaxClassification | null,
        dirty: false,
      };

      setYearProfiles((prev) =>
        [...prev, newProfile].sort((a, b) => b.taxYear - a.taxYear)
      );
      setExpandedYear(year);
      setShowAddYear(false);
      setAddYearValue("");
    } finally {
      setAddingYear(false);
    }
  };

  // Soft-delete a year
  const [deletingYear, setDeletingYear] = React.useState<number | null>(null);

  const deleteYear = async (taxYear: number) => {
    const profile = yearProfiles.find((p) => p.taxYear === taxYear);
    if (!profile) return;

    const confirmed = await confirm({
      title: `Delete ${taxYear} estimate?`,
      description: "This tax year will be moved to trash. You can restore it later from Settings > Trash.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!confirmed) return;

    setDeletingYear(taxYear);

    try {
      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const supabase = createClient();
        await supabase
          .from("tax_estimates")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", profile.id);
      }

      setYearProfiles((prev) => prev.filter((p) => p.taxYear !== taxYear));
      if (expandedYear === taxYear) setExpandedYear(null);
    } finally {
      setDeletingYear(null);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {confirmDialog}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
            <Calculator className="h-5 w-5 text-violet-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Tax Settings</h1>
            <p className="text-sm text-muted-foreground">
              Manage filing profiles for each tax year
            </p>
          </div>
        </div>
        <Link href="/settings">
          <Button size="sm" className="rounded-xl gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : yearProfiles.length === 0 ? (
        <div className="glass-card rounded-xl p-8 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            No tax years set up yet. Head to the tax estimator to get started.
          </p>
          <Link href="/tax-payments">
            <Button size="sm">Go to Tax Estimator</Button>
          </Link>
        </div>
      ) : (
        <>
          {/* Year Cards */}
          <div className="space-y-3">
            {yearProfiles.map((profile) => {
              const isExpanded = expandedYear === profile.taxYear;
              const isSaving = savingYear === profile.taxYear;
              const isSaved = savedYear === profile.taxYear;
              const classOptions = getClassificationOptions(profile.businessType);
              const showClassification = classOptions.length > 1;

              // Summary line
              const businessLabel = (() => {
                if (profile.businessType === "none") return undefined;
                const structLabel = BUSINESS_TYPE_OPTIONS.find(
                  (o) => o.value === profile.businessType
                )?.label;
                if (
                  profile.taxClassification &&
                  profile.businessType === "llc" &&
                  profile.taxClassification !== "disregarded"
                ) {
                  return `${structLabel} \u203A ${TAX_CLASSIFICATION_LABELS[profile.taxClassification]}`;
                }
                return structLabel;
              })();

              const summaryParts = [
                FILING_STATUS_LABELS[profile.filingStatus],
                profile.state || undefined,
                businessLabel,
              ].filter(Boolean);

              return (
                <div
                  key={profile.taxYear}
                  className="glass-card rounded-xl overflow-hidden transition-all duration-200"
                >
                  {/* Year Header */}
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-semibold text-foreground">
                        {profile.taxYear}
                      </span>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {summaryParts.map((part, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && <span className="text-border">·</span>}
                            <span>{part}</span>
                          </React.Fragment>
                        ))}
                        {profile.dirty && (
                          <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-warning/10 text-warning">
                            Unsaved
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isSaved && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Check className="h-3 w-3" />
                          Saved
                        </span>
                      )}
                      <button
                        onClick={() =>
                          setExpandedYear(isExpanded ? null : profile.taxYear)
                        }
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
                      <button
                        onClick={() => deleteYear(profile.taxYear)}
                        disabled={deletingYear === profile.taxYear}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/50 hover:text-error hover:bg-error/10 transition-colors disabled:opacity-50"
                        title={`Delete ${profile.taxYear}`}
                      >
                        {deletingYear === profile.taxYear ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Fields */}
                  {isExpanded && (
                    <div className="border-t border-border/50 p-4 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <CustomSelect
                          label="Filing Status"
                          value={profile.filingStatus}
                          onChange={(val) =>
                            updateYear(profile.taxYear, {
                              filingStatus: val as FilingStatus,
                            })
                          }
                          options={FILING_STATUS_OPTIONS}
                          size="sm"
                        />
                        <CustomSelect
                          label="State"
                          value={profile.state}
                          onChange={(val) =>
                            updateYear(profile.taxYear, { state: val })
                          }
                          options={[
                            { value: "", label: "No State Tax" },
                            ...STATE_OPTIONS,
                          ]}
                          placeholder="Select state"
                          size="sm"
                        />
                        <CustomSelect
                          label="Business Structure"
                          value={profile.businessType}
                          onChange={(val) => {
                            const bt = val as BusinessType;
                            updateYear(profile.taxYear, {
                              businessType: bt,
                              taxClassification: getDefaultClassification(bt),
                            });
                          }}
                          options={BUSINESS_TYPE_OPTIONS}
                          size="sm"
                        />
                        {showClassification && (
                          <CustomSelect
                            label="Tax Classification"
                            value={profile.taxClassification ?? ""}
                            onChange={(val) =>
                              updateYear(profile.taxYear, {
                                taxClassification: val as TaxClassification,
                              })
                            }
                            options={classOptions}
                            size="sm"
                          />
                        )}
                      </div>

                      {/* Per-year actions */}
                      <div className="flex items-center justify-between pt-2 border-t border-border/30">
                        {yearProfiles.length > 1 ? (
                          <button
                            onClick={() => applyToAll(profile.taxYear)}
                            disabled={applyingAll}
                            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                          >
                            {applyingAll ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                            Apply these settings to all years
                          </button>
                        ) : (
                          <div />
                        )}
                        <Button
                          size="sm"
                          onClick={() => saveYear(profile.taxYear)}
                          disabled={isSaving || !profile.dirty}
                          className="gap-1.5"
                        >
                          {isSaving && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          )}
                          Save {profile.taxYear}
                        </Button>
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
                placeholder="e.g. 2024"
                value={addYearValue}
                onChange={(e) => setAddYearValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addYear()}
                className="h-8 w-28 text-sm"
                autoFocus
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={addYear}
                disabled={addingYear}
                className="h-8 text-xs gap-1.5"
              >
                {addingYear && <Loader2 className="h-3 w-3 animate-spin" />}
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
        </>
      )}
    </div>
  );
}
