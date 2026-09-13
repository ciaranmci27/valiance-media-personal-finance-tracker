"use client";

import * as React from "react";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
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
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { cn } from "@/lib/utils";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { demoTaxEstimates } from "@/lib/demo/data";
import {
  FILING_STATUS_LABELS,
  getAvailableTaxYears,
  type FilingStatus,
} from "@/lib/tax/constants";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import {
  BUSINESS_TYPE_OPTIONS,
  TAX_CLASSIFICATION_LABELS,
  getClassificationOptions,
  getDefaultClassification,
} from "@/components/features/tax/tax-setup-card";
import type {
  BusinessType,
  TaxClassification,
  TaxEstimate,
} from "@/types/database";
import {
  businessTypeForYear,
  classificationForYear,
  describeTaxProfileForYear,
  loadBusinessProfile,
  type BusinessProfile,
} from "@/lib/business-profile";

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
  // Structure and classification live on the business profile once it exists.
  const [businessProfile, setBusinessProfile] =
    React.useState<BusinessProfile | null>(null);
  React.useEffect(() => {
    loadBusinessProfile()
      .then((result) => {
        if (result.status === "ready") setBusinessProfile(result.profile);
      })
      .catch(() => {
        /* The per-year controls stay available when the profile cannot load. */
      });
  }, []);
  // With a business profile, a year's structure is the profile's answer for
  // that year; the per-year controls only apply while no profile exists.
  const structureFor = (
    year: Pick<YearProfile, "taxYear" | "businessType" | "taxClassification">,
  ) =>
    businessProfile
      ? {
          business_type: businessTypeForYear(businessProfile, year.taxYear),
          tax_classification: classificationForYear(businessProfile, year.taxYear),
        }
      : {
          business_type: year.businessType,
          tax_classification:
            year.businessType === "none" ? null : year.taxClassification,
        };
  const [expandedYear, setExpandedYear] = React.useState<number | null>(
    initialYear ? Number(initialYear) : null,
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
  const [addYearError, setAddYearError] = React.useState<string | null>(null);

  const supportedYears = React.useMemo(() => getAvailableTaxYears(), []);

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
          // Falling back to [] on a failed read renders an empty list that looks
          // exactly like "you have no tax years", which invites the user to
          // re-add years that already exist.
          if (result.error) throw result.error;
          data = (result.data as TaxEstimate[]) ?? [];
        }

        setYearProfiles(data.map(profileFromEstimate));
      } catch (err) {
        console.error("Failed to load tax years", err);
        toast("error", "Could not load your tax years. Refresh to try again.");
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
        p.taxYear === taxYear ? { ...p, ...updates, dirty: true } : p,
      ),
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
        ...structureFor(profile),
      };

      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const supabase = createClient();
        const { error } = await supabase
          .from("tax_estimates")
          .update(updates)
          .eq("id", profile.id);
        // supabase-js resolves with { error } instead of throwing. Without this
        // the row stays dirty in the database while the UI shows a saved tick.
        if (error) throw error;
      }

      setYearProfiles((prev) =>
        prev.map((p) => (p.taxYear === taxYear ? { ...p, dirty: false } : p)),
      );
      setSavedYear(taxYear);
      setTimeout(() => setSavedYear(null), 2000);
    } catch (err) {
      console.error("Failed to save tax year profile", err);
      toast(
        "error",
        err instanceof Error
          ? err.message
          : "Could not save. Please try again.",
      );
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
      };
      // Structure follows each year, not the source year, once a profile exists.
      const structure = (p: YearProfile) =>
        structureFor({ ...source, taxYear: p.taxYear });

      if (isDemoMode()) {
        await new Promise((r) => setTimeout(r, 300));
      } else {
        const supabase = createClient();
        for (const profile of yearProfiles) {
          const { error } = await supabase
            .from("tax_estimates")
            .update({ ...updates, ...structure(profile) })
            .eq("id", profile.id);
          if (error) throw error;
        }
      }

      // Update local state to reflect the change
      setYearProfiles((prev) =>
        prev.map((p) => {
          const s = structure(p);
          return {
            ...p,
            filingStatus: source.filingStatus,
            state: source.state,
            businessType: s.business_type as BusinessType,
            taxClassification: s.tax_classification as TaxClassification | null,
            dirty: false,
          };
        }),
      );
      toast("success", `Applied ${sourceTaxYear} settings to all years`);
    } catch (err) {
      console.error("Failed to apply settings to all years", err);
      toast(
        "error",
        err instanceof Error ? err.message : "Could not apply to all years.",
      );
    } finally {
      setApplyingAll(false);
    }
  };

  // Add a new year manually
  const addYear = async () => {
    const year = Number(addYearValue);
    if (!year || year < 2000 || year > 2100) {
      setAddYearError("Enter a valid year.");
      return;
    }
    if (!supportedYears.includes(year)) {
      setAddYearError(
        `Tax rules for ${year} aren't loaded yet. Hang tight for an update, or add them yourself at src/lib/tax-core/years/${year}.ts. Loaded years: ${supportedYears.join(", ")}.`,
      );
      return;
    }
    if (yearProfiles.some((p) => p.taxYear === year)) {
      // Already exists, just expand it
      setExpandedYear(year);
      setShowAddYear(false);
      setAddYearValue("");
      setAddYearError(null);
      return;
    }

    setAddingYear(true);

    try {
      const baseProfile = yearProfiles[0];
      const newRow = {
        tax_year: year,
        filing_status: baseProfile?.filingStatus ?? ("single" as FilingStatus),
        state: baseProfile?.state || null,
        ...structureFor({
          taxYear: year,
          businessType: baseProfile?.businessType ?? ("none" as BusinessType),
          taxClassification: baseProfile?.taxClassification ?? null,
        }),
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
        const { data, error } = await supabase
          .from("tax_estimates")
          .insert(newRow)
          .select("id")
          .single();
        // Without this the row is added to local state carrying the fabricated
        // "new-<year>" id. Saving it then issues an UPDATE against a uuid column
        // with a non-uuid value, which Postgres rejects as 22P02 while the UI
        // still renders a saved tick.
        if (error) throw error;
        if (!data?.id)
          throw new Error("The year was not created. Please try again.");
        newId = data.id;
      }

      const newProfile: YearProfile = {
        id: newId,
        taxYear: year,
        filingStatus: newRow.filing_status as FilingStatus,
        state: newRow.state ?? "",
        businessType: newRow.business_type as BusinessType,
        taxClassification:
          newRow.tax_classification as TaxClassification | null,
        dirty: false,
      };

      setYearProfiles((prev) =>
        [...prev, newProfile].sort((a, b) => b.taxYear - a.taxYear),
      );
      setExpandedYear(year);
      setShowAddYear(false);
      setAddYearValue("");
      setAddYearError(null);
    } catch (err) {
      console.error("Failed to add tax year", err);
      setAddYearError(
        err instanceof Error ? err.message : "Could not add this year.",
      );
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
      description:
        "This tax year will be moved to trash. You can restore it later from Settings > Trash.",
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
        const { error } = await supabase
          .from("tax_estimates")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", profile.id);
        if (error) throw error;
      }

      setYearProfiles((prev) => prev.filter((p) => p.taxYear !== taxYear));
      if (expandedYear === taxYear) setExpandedYear(null);
    } catch (err) {
      console.error("Failed to delete tax year", err);
      toast(
        "error",
        err instanceof Error ? err.message : "Could not delete this year.",
      );
    } finally {
      setDeletingYear(null);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {confirmDialog}
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-copper/10">
            <Calculator className="h-5 w-5 text-copper" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Tax years</h1>
            <p className="text-sm text-muted-foreground">
              Filing status and state for each tax year
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings">
            <Button size="sm" className="rounded-xl gap-1">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
          <HeaderControls />
        </div>
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
              const classOptions = getClassificationOptions(
                profile.businessType,
              );
              const showClassification = classOptions.length > 1;

              // Summary line
              const businessLabel = (() => {
                if (profile.businessType === "none") return undefined;
                const structLabel = BUSINESS_TYPE_OPTIONS.find(
                  (o) => o.value === profile.businessType,
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
                    <div className="border-t border-white/[0.06] p-4 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <Select
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
                        <Select
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
                        {businessProfile ? (
                          <div className="sm:col-span-2 glass-card rounded-xl bg-[rgba(var(--ink),0.03)] px-3 py-2.5 text-sm">
                            <p className="text-xs font-medium text-muted-foreground">
                              Business structure
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2">
                              <span>
                                {describeTaxProfileForYear(
                                  businessProfile,
                                  profile.taxYear,
                                )}
                              </span>
                              <Link
                                href="/settings/business"
                                className="text-teal-light underline-offset-4 hover:underline"
                              >
                                Edit in Business settings
                              </Link>
                            </p>
                          </div>
                        ) : (
                          <>
                            <Select
                              label="Business Structure"
                              value={profile.businessType}
                              onChange={(val) => {
                                const bt = val as BusinessType;
                                updateYear(profile.taxYear, {
                                  businessType: bt,
                                  taxClassification:
                                    getDefaultClassification(bt),
                                });
                              }}
                              options={BUSINESS_TYPE_OPTIONS}
                              size="sm"
                            />
                            {showClassification && (
                              <Select
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
                          </>
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
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <TextInput
                  aria-label="Year"
                  size="sm"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={`e.g. ${supportedYears[0] ?? 2026}`}
                  value={addYearValue}
                  onChange={(nextValue) => {
                    const digitsOnly = nextValue.replace(/\D/g, "").slice(0, 4);
                    setAddYearValue(digitsOnly);
                    if (addYearError) setAddYearError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && addYear()}
                  className="w-28"
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
                  onClick={() => {
                    setShowAddYear(false);
                    setAddYearValue("");
                    setAddYearError(null);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
              {addYearError && (
                <p className="text-xs text-error">{addYearError}</p>
              )}
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
