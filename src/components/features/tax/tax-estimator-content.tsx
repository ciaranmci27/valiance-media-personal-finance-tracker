"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  X,
  Landmark,
  DollarSign,
  TrendingUp,
  CreditCard,
  Calculator,
  Loader2,
  Check,
  Unlink,
  Link2,
  Settings,
  ChevronDown,
  MapPin,
  StickyNote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { StatCard } from "@/components/ui/stat-card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { formatCurrency, cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { calculateFullTax } from "@/lib/tax/calculations";
import type { FullTaxBreakdown, BracketLine } from "@/lib/tax/calculations";
import {
  getTaxYearConfig,
  FILING_STATUS_LABELS,
  type FilingStatus,
} from "@/lib/tax/constants";
import type {
  TaxEstimate,
  TaxIncomeSource,
  TaxCapitalGainEntry,
  TaxPaymentEntry,
  BusinessType,
  TaxClassification,
  IncomeType,
} from "@/types/database";
import { ImportIncomeModal } from "./import-income-modal";
import { TaxSetupCard, TAX_CLASSIFICATION_LABELS } from "./tax-setup-card";
import { IncomeTypePicker } from "./income-type-picker";
import { AddIncomePopover } from "./add-income-popover";

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}


function emptyIncomeSource(): TaxIncomeSource {
  return {
    id: generateId(),
    name: "",
    amount: 0,
    income_type: "1099",
    subject_to_se: true,
  };
}

function emptyCapitalGain(): TaxCapitalGainEntry {
  return { id: generateId(), description: "", amount: 0, term: "long" };
}

function emptyPayment(category: "withholding" | "payment" = "withholding"): TaxPaymentEntry {
  return {
    id: generateId(),
    type: "federal",
    category,
    label: "",
    amount: 0,
    ...(category === "payment" && { quarter: "Q1" as const }),
  };
}

const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  none: "",
  sole_prop: "Sole Prop",
  llc: "LLC",
  s_corp: "S-Corp",
  c_corp: "C-Corp",
  partnership: "Partnership",
};

// ============================================================================
// Main Component
// ============================================================================

interface TaxEstimatorContentProps {
  estimates: TaxEstimate[];
}

export function TaxEstimatorContent({ estimates }: TaxEstimatorContentProps) {
  const router = useRouter();

  // Derive year tabs from estimates that actually exist
  const yearTabs = React.useMemo(
    () => estimates.map((e) => e.tax_year).sort((a, b) => b - a),
    [estimates]
  );

  // Current selected year
  const [selectedYear, setSelectedYear] = React.useState(() => {
    if (yearTabs.length > 0) return yearTabs[0];
    return new Date().getFullYear();
  });

  // Form state
  const [filingStatus, setFilingStatus] = React.useState<FilingStatus>("single");
  const [incomeSources, setIncomeSources] = React.useState<TaxIncomeSource[]>([]);
  const [capitalGains, setCapitalGains] = React.useState<TaxCapitalGainEntry[]>([]);
  const [payments, setPayments] = React.useState<TaxPaymentEntry[]>([]);
  const [additionalDeductions, setAdditionalDeductions] = React.useState(0);
  const [notes, setNotes] = React.useState("");
  const [existingId, setExistingId] = React.useState<string | null>(null);
  const [state, setState] = React.useState<string | null>(null);
  const [businessType, setBusinessType] = React.useState<BusinessType | null>(null);
  const [taxClassification, setTaxClassification] = React.useState<TaxClassification | null>(null);
  const [dependents, setDependents] = React.useState(0);
  const [otherDependents, setOtherDependents] = React.useState(0);
  const [additionalCredits, setAdditionalCredits] = React.useState(0);

  // UI state
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saving" | "saved">("idle");
  const [dirty, setDirty] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const saveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingRef = React.useRef(true); // prevents auto-save on initial load

  // Load data for selected year
  React.useEffect(() => {
    isLoadingRef.current = true;
    const existing = estimates.find((e) => e.tax_year === selectedYear);
    if (existing) {
      setFilingStatus(existing.filing_status);
      setIncomeSources(existing.income_sources || []);
      setCapitalGains(existing.capital_gains || []);
      setPayments(existing.payments || []);
      setAdditionalDeductions(Number(existing.additional_deductions) || 0);
      setNotes(existing.notes || "");
      setExistingId(existing.id);
      setState(existing.state ?? null);
      setBusinessType((existing.business_type as BusinessType) ?? null);
      setTaxClassification((existing.tax_classification as TaxClassification) ?? null);
      setDependents(existing.dependents ?? 0);
      setOtherDependents(existing.other_dependents ?? 0);
      setAdditionalCredits(existing.additional_credits ?? 0);
    } else {
      setFilingStatus("single");
      setIncomeSources([]);
      setCapitalGains([]);
      setPayments([]);
      setAdditionalDeductions(0);
      setNotes("");
      setExistingId(null);
      setState(null);
      setBusinessType(null);
      setTaxClassification(null);
      setDependents(0);
      setOtherDependents(0);
      setAdditionalCredits(0);
    }
    setDirty(false);
    setSaveStatus("idle");
    // Allow auto-save after a tick so the state settles
    requestAnimationFrame(() => {
      isLoadingRef.current = false;
    });
  }, [selectedYear, estimates]);

  // Tax config for selected year
  const taxConfig = React.useMemo(() => getTaxYearConfig(selectedYear), [selectedYear]);

  // Live recalculation
  const breakdown: FullTaxBreakdown | null = React.useMemo(() => {
    if (!taxConfig) return null;
    return calculateFullTax(
      incomeSources,
      capitalGains,
      payments,
      additionalDeductions,
      filingStatus,
      taxConfig,
      state,
      dependents,
      otherDependents,
      additionalCredits
    );
  }, [incomeSources, capitalGains, payments, additionalDeductions, filingStatus, taxConfig, state, dependents, otherDependents, additionalCredits]);

  // Mark dirty and schedule auto-save
  const markDirty = React.useCallback(() => {
    if (isLoadingRef.current) return;
    setDirty(true);
    setSaveStatus("idle");
  }, []);

  // ============================================================================
  // Withholding auto-management
  // ============================================================================

  const createWithholdingsForSource = (source: TaxIncomeSource) => {
    const withholdings: TaxPaymentEntry[] = [];
    if (source.income_type === "w2") {
      withholdings.push({
        id: generateId(),
        type: "federal",
        category: "withholding",
        label: source.name || "W-2",
        amount: 0,
        linked_income_id: source.id,
      });
      if (state) {
        withholdings.push({
          id: generateId(),
          type: "state",
          category: "withholding",
          label: source.name || "W-2",
          amount: 0,
          linked_income_id: source.id,
        });
      }
    }
    return withholdings;
  };

  const removeWithholdingsForSource = (sourceId: string, keepWithAmounts = false) => {
    setPayments((prev) =>
      prev.filter((p) =>
        p.linked_income_id !== sourceId || (keepWithAmounts && p.amount > 0)
      )
    );
  };

  // ============================================================================
  // Income Sources
  // ============================================================================

  const addIncome = () => {
    setIncomeSources((prev) => [...prev, emptyIncomeSource()]);
    markDirty();
  };

  const updateIncome = (id: string, field: keyof TaxIncomeSource, value: string | number | boolean) => {
    setIncomeSources((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [field]: value } : s))
    );
    // Sync withholding labels when source name changes
    if (field === "name" && typeof value === "string") {
      setPayments((prev) =>
        prev.map((p) =>
          p.linked_income_id === id ? { ...p, label: value } : p
        )
      );
    }
    markDirty();
  };

  const removeIncome = (id: string) => {
    setIncomeSources((prev) => prev.filter((s) => s.id !== id));
    removeWithholdingsForSource(id);
    markDirty();
  };

  const unlinkIncome = (id: string) => {
    setIncomeSources((prev) =>
      prev.map((s) => (s.id === id ? { ...s, is_unlinked: true } : s))
    );
    markDirty();
  };

  const relinkIncome = (id: string) => {
    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, is_unlinked: false, amount: s.linked_amount ?? s.amount }
          : s
      )
    );
    markDirty();
  };

  // ============================================================================
  // Capital Gains
  // ============================================================================

  const addCapitalGain = () => {
    setCapitalGains((prev) => [...prev, emptyCapitalGain()]);
    markDirty();
  };

  const updateCapitalGain = (id: string, field: keyof TaxCapitalGainEntry, value: string | number) => {
    setCapitalGains((prev) =>
      prev.map((g) => (g.id === id ? { ...g, [field]: value } : g))
    );
    markDirty();
  };

  const removeCapitalGain = (id: string) => {
    setCapitalGains((prev) => prev.filter((g) => g.id !== id));
    markDirty();
  };

  // ============================================================================
  // Payments
  // ============================================================================

  const addWithholding = () => {
    setPayments((prev) => [...prev, emptyPayment("withholding")]);
    markDirty();
  };

  const addPayment = () => {
    setPayments((prev) => [...prev, emptyPayment("payment")]);
    markDirty();
  };

  const updatePayment = (id: string, field: keyof TaxPaymentEntry, value: string | number) => {
    setPayments((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
    markDirty();
  };

  const removePayment = (id: string) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
    markDirty();
  };

  // ============================================================================
  // Import callback
  // ============================================================================

  const handleImport = (imported: TaxIncomeSource[]) => {
    setIncomeSources((prev) => {
      // Build a map of existing linked sources by their linked_source_id
      const linkedMap = new Map<string, number>();
      prev.forEach((s, idx) => {
        if (s.linked_source_id && !s.is_unlinked) {
          linkedMap.set(s.linked_source_id, idx);
        }
      });

      const updated = [...prev];
      const toAdd: TaxIncomeSource[] = [];

      for (const src of imported) {
        const existingIdx = src.linked_source_id
          ? linkedMap.get(src.linked_source_id)
          : undefined;

        if (existingIdx !== undefined) {
          // Update existing linked source in-place
          updated[existingIdx] = {
            ...updated[existingIdx],
            amount: src.amount,
            linked_amount: src.linked_amount,
          };
        } else {
          toAdd.push(src);
        }
      }

      return [...updated, ...toAdd];
    });
    // Create withholdings for newly added W-2 imports
    const newW2Sources = imported.filter(
      (src) => src.income_type === "w2" && !incomeSources.some(
        (s) => s.linked_source_id === src.linked_source_id && !s.is_unlinked
      )
    );
    const withholdings = newW2Sources.flatMap(createWithholdingsForSource);
    if (withholdings.length > 0) {
      setPayments((prev) => [...prev, ...withholdings]);
    }
    markDirty();
  };

  // ============================================================================
  // Income type change
  // ============================================================================

  const toggleSe = (sourceId: string) => {
    setIncomeSources((prev) =>
      prev.map((s) => s.id === sourceId ? { ...s, subject_to_se: !s.subject_to_se } : s)
    );
    markDirty();
  };

  const handleIncomeTypeChange = (sourceId: string, newType: IncomeType) => {
    const source = incomeSources.find((s) => s.id === sourceId);
    const wasW2 = source?.income_type === "w2";
    const isNowW2 = newType === "w2";

    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === sourceId
          ? { ...s, income_type: newType, subject_to_se: newType === "1099" }
          : s
      )
    );

    if (!wasW2 && isNowW2 && source) {
      const withholdings = createWithholdingsForSource({ ...source, income_type: "w2" });
      if (withholdings.length > 0) {
        setPayments((prev) => [...prev, ...withholdings]);
      }
    } else if (wasW2 && !isNowW2) {
      removeWithholdingsForSource(sourceId, true);
    }

    markDirty();
  };

  // ============================================================================
  // Setup mode handler (wizard handles row creation, just refresh)
  // ============================================================================

  const handleSetupComplete = () => {
    router.refresh();
  };

  // ============================================================================
  // Auto-save (debounced 1.5s after last change)
  // ============================================================================

  React.useEffect(() => {
    if (!dirty || isLoadingRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(async () => {
      if (isDemoMode()) {
        setDirty(false);
        setSaveStatus("saved");
        return;
      }

      setSaveStatus("saving");
      try {
        const supabase = createClient();
        const payload = {
          tax_year: selectedYear,
          filing_status: filingStatus,
          income_sources: incomeSources as unknown as Record<string, unknown>[],
          capital_gains: capitalGains as unknown as Record<string, unknown>[],
          payments: payments as unknown as Record<string, unknown>[],
          additional_deductions: additionalDeductions,
          state: state,
          business_type: businessType,
          tax_classification: taxClassification,
          dependents: dependents,
          other_dependents: otherDependents,
          additional_credits: additionalCredits,
          notes: notes || null,
        };

        if (existingId) {
          await supabase.from("tax_estimates").update(payload).eq("id", existingId);
        } else {
          const { data } = await supabase
            .from("tax_estimates")
            .insert(payload)
            .select("id")
            .single();
          if (data) setExistingId(data.id);
        }

        setDirty(false);
        setSaveStatus("saved");
      } catch {
        setSaveStatus("idle");
      }
    }, 1500);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, filingStatus, incomeSources, capitalGains, payments, additionalDeductions, notes, selectedYear, existingId, state, businessType, taxClassification, dependents, otherDependents, additionalCredits]);

  // ============================================================================
  // Stat card helpers
  // ============================================================================

  const federalTaxTotal = breakdown
    ? breakdown.federalTaxAfterCredits + breakdown.niit
    : 0;

  // ============================================================================
  // Render
  // ============================================================================

  // Setup mode: no data for any year
  const isSetupMode = estimates.length === 0;

  if (isSetupMode) {
    return (
      <div className="animate-fade-up">
        <TaxSetupCard onComplete={handleSetupComplete} selectedYear={selectedYear} />
      </div>
    );
  }

  // Profile summary pieces
  // Show classification instead of structure when they differ (e.g. "LLC > S-Corp")
  const businessLabel = (() => {
    if (!businessType || businessType === "none") return undefined;
    const structLabel = BUSINESS_TYPE_LABELS[businessType];
    if (taxClassification && businessType === "llc") {
      const classLabel = TAX_CLASSIFICATION_LABELS[taxClassification];
      // Only show both if classification differs from the default
      if (taxClassification !== "disregarded") {
        return `${structLabel} \u203A ${classLabel}`;
      }
    }
    return structLabel;
  })();

  const profileParts = [
    FILING_STATUS_LABELS[filingStatus],
    state ?? undefined,
    businessLabel,
  ].filter(Boolean);

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Filters Row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Profile summary + settings link */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {profileParts.join(" \u00B7 ")}
          </span>
          <Tooltip content="Edit year settings">
            <Link
              href={`/settings/tax?year=${selectedYear}`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <Settings className="h-4 w-4" />
            </Link>
          </Tooltip>
        </div>

        <div className="flex items-center gap-3">
          {/* Save Status */}
          {saveStatus === "saving" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground animate-pulse">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}

          {/* Year Tabs - dropdown on mobile, buttons on desktop */}
          <div className="sm:hidden w-28">
            <CustomSelect
              value={String(selectedYear)}
              onChange={(value) => setSelectedYear(Number(value))}
              options={yearTabs.map((year) => ({
                value: String(year),
                label: String(year),
              }))}
              size="sm"
            />
          </div>
          <div className="hidden sm:flex rounded-lg border border-border bg-card/50 p-0.5">
            {yearTabs.map((year) => (
              <button
                key={year}
                onClick={() => setSelectedYear(year)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-200",
                  selectedYear === year
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {year}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      {breakdown && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard
            title="Federal Tax"
            value={federalTaxTotal}
            icon={<Landmark className="h-5 w-5" />}
          />
          <StatCard
            title="Payroll Tax"
            value={breakdown.selfEmploymentTax.total + breakdown.ficaTax.total}
            icon={<Calculator className="h-5 w-5" />}
          />
          <StatCard
            title="Total Paid"
            value={breakdown.totalPaid}
            icon={<CreditCard className="h-5 w-5" />}
          />
          <StatCard
            title="Net Remaining"
            value={breakdown.netRemaining}
            icon={<DollarSign className="h-5 w-5" />}
            trend={breakdown.netRemaining <= 0 ? "down" : "up"}
          />
        </div>
      )}

      {/* Two-Column Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left: Input Builder */}
        <div className="space-y-4">
          {/* Income Sources */}
          <Card glass>
            <CardHeader className="px-4 pt-3 pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <DollarSign className="h-4 w-4 text-primary" />
                  Income Sources
                </CardTitle>
                <AddIncomePopover
                  taxClassification={taxClassification}
                  businessType={businessType}
                  filingStatus={filingStatus}
                  onAddTemplates={(templates) => {
                    setIncomeSources((prev) => [...prev, ...templates]);
                    const withholdings = templates.flatMap(createWithholdingsForSource);
                    if (withholdings.length > 0) {
                      setPayments((prev) => [...prev, ...withholdings]);
                    }
                    markDirty();
                  }}
                  onAddCustom={addIncome}
                  onOpenImport={() => setImportOpen(true)}
                  existingSources={incomeSources}
                />
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-2">
              {incomeSources.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No income sources added yet.
                </p>
              )}
              {/* Column headers (hidden on mobile) */}
              {incomeSources.length > 0 && (
                <div className="hidden sm:grid grid-cols-[1fr_auto_140px] gap-2 px-1 text-xs text-muted-foreground font-medium">
                  <span>Source</span>
                  <span className="w-7" />
                  <span>Amount</span>
                </div>
              )}
              {incomeSources.map((source) => {
                const isLinked = !!source.linked_source_id && !source.is_unlinked;
                const isOverridden = !!source.linked_source_id && !!source.is_unlinked;
                const isManual = !source.linked_source_id;
                const fieldsDisabled = isLinked;

                return (
                  <div
                    key={source.id}
                    className={cn(
                      "group/row flex flex-col gap-1.5 sm:grid sm:grid-cols-[1fr_auto_140px] sm:gap-2 sm:items-center rounded-md py-1 px-2 transition-colors border-x-[3px] border-y",
                      isLinked && "border-x-success/60 border-y-success/20 bg-success/[0.04]",
                      isOverridden && "border-x-copper/50 border-y-copper/20 bg-copper/[0.04]",
                      isManual && "border-x-copper/50 border-y-copper/20 bg-copper/[0.04]",
                      source.amount === 0 && !source.linked_source_id && "ring-1 ring-primary/15"
                    )}
                  >
                    {/* Row 1: Name + badges */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Input
                        placeholder="Name"
                        value={source.name}
                        onChange={(e) => updateIncome(source.id, "name", e.target.value)}
                        disabled={fieldsDisabled}
                        className={cn(
                          "h-8 text-sm flex-1 min-w-0",
                          fieldsDisabled && "opacity-60"
                        )}
                      />
                      <IncomeTypePicker
                        incomeType={source.income_type}
                        taxClassification={taxClassification}
                        onChange={(type) => handleIncomeTypeChange(source.id, type)}
                      />
                      {(source.income_type === "1099" || source.income_type === "k1") && (
                        <button
                          type="button"
                          onClick={() => toggleSe(source.id)}
                          className={cn(
                            "shrink-0 h-8 px-1.5 inline-flex items-center text-[10px] font-semibold uppercase tracking-wider rounded border cursor-pointer transition-colors",
                            source.subject_to_se
                              ? "bg-primary/15 text-primary border-primary/25"
                              : "bg-muted text-muted-foreground/40 border-border line-through"
                          )}
                        >
                          SE
                        </button>
                      )}
                      {isOverridden && (
                        <span className="shrink-0 h-8 px-1.5 inline-flex items-center text-[10px] font-semibold uppercase tracking-wider rounded bg-copper/15 text-copper border border-copper/25">
                          Unlinked
                        </span>
                      )}
                      {(isLinked || isOverridden) && (
                        <Tooltip
                          content={
                            isLinked
                              ? `Synced from income tracking for ${selectedYear}. Updates automatically.`
                              : "Manually edited. Click re-link to restore synced amount."
                          }
                        >
                          <span className="relative flex h-2 w-2 shrink-0">
                            {isLinked && (
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                            )}
                            <span className={cn(
                              "relative inline-flex rounded-full h-2 w-2",
                              isLinked && "bg-success",
                              isOverridden && "bg-copper/60"
                            )} />
                          </span>
                        </Tooltip>
                      )}
                    </div>
                    {/* Row 2 (mobile) / Cols 2-3 (desktop): Actions + Amount */}
                    <div className="flex items-center gap-2 sm:contents">
                      {isLinked && (
                        <div className="flex items-center order-1 sm:order-none">
                          <button
                            onClick={() => removeIncome(source.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground sm:opacity-0 sm:group-hover/row:opacity-100 hover:!text-error hover:!bg-error/10 transition-all cursor-pointer"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                          <Tooltip content="Edit manually">
                            <button
                              onClick={() => unlinkIncome(source.id)}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-copper hover:bg-copper/10 transition-colors cursor-pointer"
                            >
                              <Unlink className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                      {isOverridden && (
                        <div className="flex items-center order-1 sm:order-none">
                          <button
                            onClick={() => removeIncome(source.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground sm:opacity-0 sm:group-hover/row:opacity-100 hover:!text-error hover:!bg-error/10 transition-all cursor-pointer"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                          <Tooltip content="Restore synced amount">
                            <button
                              onClick={() => relinkIncome(source.id)}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-success hover:bg-success/10 transition-colors cursor-pointer"
                            >
                              <Link2 className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                      {isManual && (
                        <button
                          onClick={() => removeIncome(source.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-error hover:bg-error/10 transition-colors order-1 sm:order-none"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <NumberInput
                        placeholder="0"
                        value={source.amount || ""}
                        onChange={(e) =>
                          updateIncome(source.id, "amount", Number(e.target.value) || 0)
                        }
                        disabled={fieldsDisabled}
                        className={cn(
                          "h-8 text-sm font-mono flex-1 sm:flex-initial",
                          fieldsDisabled && "opacity-60"
                        )}
                      />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Capital Gains */}
          <Card glass>
            <CardHeader className="px-4 pt-3 pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Capital Gains & Losses
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={addCapitalGain}
                  className="h-7 gap-1 text-xs px-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-2">
              {capitalGains.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No capital gains or losses entered.
                </p>
              )}
              {capitalGains.length > 0 && (
                <div className="hidden sm:grid grid-cols-[1fr_auto_140px] gap-2 px-1 text-xs text-muted-foreground font-medium">
                  <span>Description</span>
                  <span className="w-7" />
                  <span>Amount</span>
                </div>
              )}
              {capitalGains.map((gain) => (
                <div
                  key={gain.id}
                  className="flex flex-col gap-1.5 sm:grid sm:grid-cols-[1fr_auto_140px] sm:gap-2 sm:items-center rounded-md py-1 px-2 border-x-[3px] border-x-copper/50 border-y border-y-copper/20 bg-copper/[0.04]"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Input
                      placeholder="Description"
                      value={gain.description}
                      onChange={(e) =>
                        updateCapitalGain(gain.id, "description", e.target.value)
                      }
                      className="h-8 text-sm flex-1 min-w-0"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        updateCapitalGain(
                          gain.id,
                          "term",
                          gain.term === "short" ? "long" : "short"
                        )
                      }
                      className={cn(
                        "shrink-0 h-8 px-2 inline-flex items-center rounded-md text-xs font-medium transition-colors",
                        gain.term === "long"
                          ? "bg-primary/10 text-primary"
                          : "bg-warning/10 text-warning"
                      )}
                    >
                      {gain.term === "long" ? "Long Term" : "Short Term"}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 sm:contents">
                    <button
                      onClick={() => removeCapitalGain(gain.id)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-error hover:bg-error/10 transition-colors order-1 sm:order-none"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <NumberInput
                      placeholder="0"
                      value={gain.amount || ""}
                      onChange={(e) =>
                        updateCapitalGain(gain.id, "amount", Number(e.target.value) || 0)
                      }
                      className="h-8 text-sm font-mono flex-1 sm:flex-initial"
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Deductions Summary */}
          <Card glass>
            <CardHeader className="px-4 pt-3 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Calculator className="h-4 w-4 text-primary" />
                Deductions
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Standard Deduction</span>
                <span className="font-mono font-medium text-foreground">
                  {formatCurrency(taxConfig?.standardDeductions[filingStatus] ?? 0)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">SE Deduction</span>
                <span className="font-mono font-medium text-foreground">
                  {formatCurrency(breakdown?.seDeduction ?? 0)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">QBI Deduction (20%)</span>
                <span className="font-mono font-medium text-foreground">
                  {formatCurrency(breakdown?.qbiDeduction ?? 0)}
                </span>
              </div>
              <div className="border-t border-border pt-2 space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <div className="flex items-center justify-between gap-2 sm:basis-1/2 min-w-0">
                    <label className="text-sm text-muted-foreground whitespace-nowrap">
                      Children (under 17)
                    </label>
                    <NumberInput
                      placeholder="0"
                      integer
                      max={20}
                      value={dependents || ""}
                      onChange={(e) => {
                        setDependents(Math.max(0, Number(e.target.value) || 0));
                        markDirty();
                      }}
                      className="h-8 text-sm font-mono w-24 text-right"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:basis-1/2 min-w-0">
                    <label className="text-sm text-muted-foreground whitespace-nowrap">
                      Other Dependents
                    </label>
                    <NumberInput
                      placeholder="0"
                      integer
                      max={10}
                      value={otherDependents || ""}
                      onChange={(e) => {
                        setOtherDependents(Math.max(0, Number(e.target.value) || 0));
                        markDirty();
                      }}
                      className="h-8 text-sm font-mono w-24 text-right"
                    />
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <div className="flex items-center justify-between gap-2 sm:basis-1/2 min-w-0">
                    <label className="text-sm text-muted-foreground whitespace-nowrap">
                      Additional Deductions
                    </label>
                    <NumberInput
                      placeholder="0"
                      value={additionalDeductions || ""}
                      onChange={(e) => {
                        setAdditionalDeductions(Number(e.target.value) || 0);
                        markDirty();
                      }}
                      className="h-8 text-sm font-mono w-24 text-right"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:basis-1/2 min-w-0">
                    <label className="text-sm text-muted-foreground whitespace-nowrap">
                      Additional Tax Credits
                    </label>
                    <NumberInput
                      placeholder="0"
                      value={additionalCredits || ""}
                      onChange={(e) => {
                        setAdditionalCredits(Number(e.target.value) || 0);
                        markDirty();
                      }}
                      className="h-8 text-sm font-mono w-24 text-right"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payments & Withholdings */}
          <Card glass>
            <CardHeader className="px-4 pt-3 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <CreditCard className="h-4 w-4 text-primary" />
                Payments & Withholdings
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-4">
              {/* Withholdings */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Withholdings
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={addWithholding}
                    className="h-7 gap-1 text-xs px-2"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>
                {payments.filter((p) => p.category !== "payment").length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2 text-center">
                    No withholdings recorded.
                  </p>
                ) : (
                  <div className="hidden sm:grid grid-cols-[1fr_auto_140px] gap-2 px-1 text-xs text-muted-foreground font-medium">
                    <span>Source</span>
                    <span className="w-7" />
                    <span>Amount</span>
                  </div>
                )}
                {payments
                  .filter((p) => p.category !== "payment")
                  .map((payment) => (
                    <PaymentRow
                      key={payment.id}
                      payment={payment}
                      onUpdate={updatePayment}
                      onRemove={removePayment}
                    />
                  ))}
              </div>

              {/* Estimated Payments */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Estimated Payments
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={addPayment}
                    className="h-7 gap-1 text-xs px-2"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>
                {payments.filter((p) => p.category === "payment").length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2 text-center">
                    No estimated payments recorded.
                  </p>
                ) : (
                  <div className="hidden sm:grid grid-cols-[1fr_auto_140px] gap-2 px-1 text-xs text-muted-foreground font-medium">
                    <span>Date</span>
                    <span className="w-7" />
                    <span>Amount</span>
                  </div>
                )}
                {payments
                  .filter((p) => p.category === "payment")
                  .map((payment) => (
                    <PaymentRow
                      key={payment.id}
                      payment={payment}
                      onUpdate={updatePayment}
                      onRemove={removePayment}
                      showQuarter
                    />
                  ))}
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card glass>
            <CardHeader className="px-4 pt-3 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <StickyNote className="h-4 w-4 text-primary" />
                Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0">
              <textarea
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  markDirty();
                }}
                placeholder="Add notes about this tax year..."
                rows={3}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background focus:border-transparent resize-none"
              />
            </CardContent>
          </Card>
        </div>

        {/* Right: Calculation Results */}
        <div className="space-y-6">
          {breakdown && <CalculationResults breakdown={breakdown} filingStatus={filingStatus} />}
        </div>
      </div>

      {/* Import Modal */}
      <ImportIncomeModal
        open={importOpen}
        onOpenChange={setImportOpen}
        taxYear={selectedYear}
        onImport={handleImport}
        taxClassification={taxClassification}
      />

    </div>
  );
}

// ============================================================================
// Calculation Results Panel
// ============================================================================

const ACCENT_CLASSES = {
  primary: {
    border: "border-l-primary",
    header: "text-primary",
    footer: "bg-primary/5 border-t-primary/20",
  },
  copper: {
    border: "border-l-copper",
    header: "text-copper",
    footer: "bg-copper/5 border-t-copper/20",
  },
  blue: {
    border: "border-l-blue-400",
    header: "text-blue-400",
    footer: "bg-blue-400/5 border-t-blue-400/20",
  },
  amber: {
    border: "border-l-amber-400",
    header: "text-amber-400",
    footer: "bg-amber-400/5 border-t-amber-400/20",
  },
  success: {
    border: "border-l-success",
    header: "text-success",
    footer: "bg-success/5 border-t-success/20",
  },
  error: {
    border: "border-l-error",
    header: "text-error",
    footer: "bg-error/5 border-t-error/20",
  },
} as const;

type AccentKey = keyof typeof ACCENT_CLASSES;

function GroupPanel({
  title,
  icon: Icon,
  accent,
  subtotalLabel,
  subtotalValue,
  children,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: AccentKey;
  subtotalLabel?: string;
  subtotalValue?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const colors = ACCENT_CLASSES[accent];
  return (
    <div
      className={cn(
        "rounded-xl glass-card overflow-hidden",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-1">
        <Icon className={cn("h-4 w-4", colors.header)} />
        <span className="text-base font-semibold text-foreground">
          {title}
        </span>
      </div>

      {/* Content */}
      <div className="px-4 pb-3 space-y-1">
        {children}
      </div>

      {/* Subtotal footer */}
      {subtotalLabel && subtotalValue && (
        <div
          className={cn(
            "flex items-center justify-between px-4 py-2.5 border-t text-sm font-semibold",
            colors.footer
          )}
        >
          <span>{subtotalLabel}</span>
          <span className="font-mono">{subtotalValue}</span>
        </div>
      )}
    </div>
  );
}

function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 pt-1">
      <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider pl-3">
        {title}
      </span>
      {children}
    </div>
  );
}

function CollapsibleBracketTable({
  title,
  brackets,
  total,
  fmtMasked,
  fmt,
  pct,
}: {
  title: string;
  brackets: BracketLine[];
  total: number;
  fmtMasked: (v: number) => string;
  fmt: (v: number) => string;
  pct: (v: number) => string;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full py-1 px-0 text-left cursor-pointer group/bracket"
      >
        <span className="flex items-center gap-1.5 text-foreground text-sm">
          {title}
          <ChevronDown
            className={cn(
              "h-3 w-3 text-muted-foreground transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </span>
        <span className="font-mono font-semibold text-sm">{fmtMasked(total)}</span>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="overflow-x-auto pt-1 pb-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-medium py-1 px-1">Rate</th>
                  <th className="text-right font-medium py-1 px-1">Bracket</th>
                  <th className="text-right font-medium py-1 px-1">Taxable</th>
                  <th className="text-right font-medium py-1 px-1">Tax</th>
                </tr>
              </thead>
              <tbody>
                {brackets.map((b, i) => (
                  <tr key={i} className="border-t border-border/30">
                    <td className="py-1 px-1 font-mono">{pct(b.rate)}</td>
                    <td className="py-1 px-1 text-right font-mono text-muted-foreground">
                      {b.rangeEnd === Infinity
                        ? `${fmt(b.rangeStart)}+`
                        : `${fmt(b.rangeStart)} - ${fmt(b.rangeEnd)}`}
                    </td>
                    <td className="py-1 px-1 text-right font-mono">
                      {fmtMasked(b.taxableInBracket)}
                    </td>
                    <td className="py-1 px-1 text-right font-mono font-medium">
                      {fmtMasked(b.tax)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function CalculationResults({
  breakdown,
  filingStatus,
}: {
  breakdown: FullTaxBreakdown;
  filingStatus: FilingStatus;
}) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const mask = "$•••••";

  const fmt = (val: number) => formatCurrency(val);
  const fmtMasked = (val: number) =>
    isHidden && !isRevealed ? mask : formatCurrency(val);
  const pct = (val: number) => `${(val * 100).toFixed(1)}%`;

  const hasCapitalGains =
    breakdown.capitalGains.grossShortTerm !== 0 ||
    breakdown.capitalGains.grossLongTerm !== 0;

  const showPayroll =
    breakdown.selfEmploymentTax.total > 0 || breakdown.ficaTax.total > 0;

  const showState =
    breakdown.stateTaxDetail.stateName != null || breakdown.stateTax > 0;

  const federalSubtotal = breakdown.federalTaxAfterCredits + breakdown.niit;
  const payrollSubtotal = breakdown.selfEmploymentTax.total + breakdown.ficaTax.total;

  const isOverpaid = breakdown.netRemaining < 0;
  const isPaidInFull = breakdown.netRemaining === 0;

  return (
    <div className="space-y-4 text-sm" {...hoverProps}>

        {/* Group 1: Income Summary */}
        <GroupPanel
          title="Income Summary"
          icon={DollarSign}
          accent="primary"
          subtotalLabel="Taxable Income"
          subtotalValue={fmtMasked(breakdown.taxableIncome)}
          className="animate-fade-up stagger-1"
        >
          <Row label="Gross Income" value={fmtMasked(breakdown.grossIncome)} bold />
          {breakdown.w2Income > 0 && (
            <Row label="W-2 Wages" value={fmtMasked(breakdown.w2Income)} sub />
          )}
          {breakdown.otherIncome > 0 && (
            <Row label="1099 / Other" value={fmtMasked(breakdown.otherIncome)} sub />
          )}
          {breakdown.seIncome > 0 && (
            <Row label="Self-Employment" value={fmtMasked(breakdown.seIncome)} sub />
          )}
          {breakdown.passiveIncome > 0 && (
            <Row label="Passive K-1" value={fmtMasked(breakdown.passiveIncome)} sub />
          )}

          {hasCapitalGains && (
            <SubSection title="Capital Gains">
              <Row
                label="Net Short-Term"
                value={fmtMasked(breakdown.capitalGains.netShortTerm)}
                color={breakdown.capitalGains.netShortTerm < 0 ? "error" : undefined}
                sub
              />
              <Row
                label="Net Long-Term"
                value={fmtMasked(breakdown.capitalGains.netLongTerm)}
                color={breakdown.capitalGains.netLongTerm < 0 ? "error" : undefined}
                sub
              />
              {breakdown.capitalGains.lossDeduction > 0 && (
                <Row
                  label="Loss Deduction"
                  value={`(${fmtMasked(breakdown.capitalGains.lossDeduction)})`}
                  color="error"
                  sub
                />
              )}
            </SubSection>
          )}

          <SubSection title="Deductions">
            <Row label="Standard" value={fmtMasked(breakdown.standardDeduction)} sub />
            <Row label="SE Deduction" value={fmtMasked(breakdown.seDeduction)} sub />
            {breakdown.qbiDeduction > 0 && (
              <Row label="QBI (20%)" value={fmtMasked(breakdown.qbiDeduction)} sub />
            )}
            {breakdown.additionalDeductions > 0 && (
              <Row label="Additional" value={fmtMasked(breakdown.additionalDeductions)} sub />
            )}
            <Row label="Total Deductions" value={fmtMasked(breakdown.totalDeductions)} bold />
          </SubSection>

          <Row label="AGI" value={fmtMasked(breakdown.agi)} />
        </GroupPanel>

        {/* Group 2: Federal Taxes */}
        <GroupPanel
          title="Federal Taxes"
          icon={Landmark}
          accent="copper"
          subtotalLabel="Federal Subtotal"
          subtotalValue={fmtMasked(federalSubtotal)}
          className="animate-fade-up stagger-2"
        >
          <CollapsibleBracketTable
            title="Federal Income Tax"
            brackets={breakdown.federalTax.bracketBreakdown}
            total={breakdown.federalTax.total}
            fmtMasked={fmtMasked}
            fmt={fmt}
            pct={pct}
          />

          {breakdown.ltcgTax.bracketBreakdown.length > 0 && (
            <CollapsibleBracketTable
              title="LTCG Tax"
              brackets={breakdown.ltcgTax.bracketBreakdown}
              total={breakdown.ltcgTax.total}
              fmtMasked={fmtMasked}
              fmt={fmt}
              pct={pct}
            />
          )}

          {breakdown.totalCredits > 0 && (
            <>
              {breakdown.childTaxCredit > 0 && (
                <Row
                  label="Child Tax Credit"
                  value={`-${fmtMasked(breakdown.childTaxCredit)}`}
                  color="success"
                  sub
                />
              )}
              {breakdown.otherDependentCredit > 0 && (
                <Row
                  label="Other Dependent Credit"
                  value={`-${fmtMasked(breakdown.otherDependentCredit)}`}
                  color="success"
                  sub
                />
              )}
              {breakdown.additionalCredits > 0 && (
                <Row
                  label="Additional Credits"
                  value={`-${fmtMasked(breakdown.additionalCredits)}`}
                  color="success"
                  sub
                />
              )}
              <Row
                label="After Credits"
                value={fmtMasked(breakdown.federalTaxAfterCredits)}
                bold
              />
            </>
          )}

          {breakdown.niit > 0 && (
            <Row label="NIIT (3.8%)" value={fmtMasked(breakdown.niit)} />
          )}
        </GroupPanel>

        {/* Group 3: Payroll Taxes */}
        {showPayroll && (
          <GroupPanel
            title="Payroll Taxes"
            icon={CreditCard}
            accent="blue"
            subtotalLabel="Payroll Subtotal"
            subtotalValue={fmtMasked(payrollSubtotal)}
            className="animate-fade-up stagger-3"
          >
            {breakdown.selfEmploymentTax.total > 0 && (
              <SubSection title="Self-Employment Tax">
                <Row label="SS (12.4%)" value={fmtMasked(breakdown.selfEmploymentTax.ssTax)} sub />
                <Row label="Medicare (2.9%)" value={fmtMasked(breakdown.selfEmploymentTax.medicareTax)} sub />
                {breakdown.selfEmploymentTax.additionalMedicare > 0 && (
                  <Row label="Addl Medicare (0.9%)" value={fmtMasked(breakdown.selfEmploymentTax.additionalMedicare)} sub />
                )}
                <Row label="Total SE" value={fmtMasked(breakdown.selfEmploymentTax.total)} bold />
              </SubSection>
            )}

            {breakdown.ficaTax.total > 0 && (
              <SubSection title="W-2 FICA">
                <Row label="SS (6.2%)" value={fmtMasked(breakdown.ficaTax.ssTax)} sub />
                <Row label="Medicare (1.45%)" value={fmtMasked(breakdown.ficaTax.medicareTax)} sub />
                {breakdown.ficaTax.additionalMedicare > 0 && (
                  <Row label="Addl Medicare (0.9%)" value={fmtMasked(breakdown.ficaTax.additionalMedicare)} sub />
                )}
                <Row label="Total FICA" value={fmtMasked(breakdown.ficaTax.total)} bold />
              </SubSection>
            )}
          </GroupPanel>
        )}

        {/* Group 4: State Taxes */}
        {showState && (
          <GroupPanel
            title="State Taxes"
            icon={MapPin}
            accent="amber"
            subtotalLabel="State Subtotal"
            subtotalValue={fmtMasked(breakdown.stateTax)}
            className="animate-fade-up stagger-4"
          >
            {breakdown.stateTaxDetail.stateName ? (
              <>
                {breakdown.stateTaxDetail.stateStandardDeduction > 0 && (
                  <Row label="State Deduction" value={fmtMasked(breakdown.stateTaxDetail.stateStandardDeduction)} sub />
                )}
                {(breakdown.stateTaxDetail.rate === null || breakdown.stateTaxDetail.rate > 0) && (
                  <Row label="State Taxable Income" value={fmtMasked(breakdown.stateTaxDetail.stateTaxableIncome)} sub />
                )}
                <Row
                  label={
                    breakdown.stateTaxDetail.rate != null
                      ? `${breakdown.stateTaxDetail.stateName} (${(breakdown.stateTaxDetail.rate * 100).toFixed(1)}%)`
                      : `${breakdown.stateTaxDetail.stateName} (progressive)`
                  }
                  value={fmtMasked(breakdown.stateTax)}
                />
              </>
            ) : (
              <Row label="No state selected" value="$0.00" color="muted" />
            )}
          </GroupPanel>
        )}

        {/* Group 5: Payments & Remaining */}
        <div
          className={cn(
            "rounded-xl glass-card overflow-hidden",
            "animate-fade-up stagger-5"
          )}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <DollarSign className="h-4 w-4 text-primary" />
            <span className="text-base font-semibold text-foreground">
              Payments & Remaining
            </span>
          </div>

          <div className="px-4 pb-3 space-y-3">
            {/* Federal */}
            <div className="space-y-1">
              <Row label="Federal Liability" value={fmtMasked(breakdown.federalLiability)} />
              <Row label="Federal Paid" value={fmtMasked(breakdown.totalFederalPaid)} sub />
              <div className="flex items-center justify-between pl-3 pt-0.5">
                <span className={cn(
                  "font-medium text-sm",
                  breakdown.federalRemaining < 0 && "text-success",
                  breakdown.federalRemaining === 0 && "text-success",
                  breakdown.federalRemaining > 0 && "text-error"
                )}>
                  {breakdown.federalRemaining === 0 ? "Paid in Full" : "Federal Remaining"}
                </span>
                <CopyableValue
                  value={fmtMasked(breakdown.federalRemaining)}
                  rawValue={breakdown.federalRemaining}
                  className={cn(
                    "font-semibold",
                    breakdown.federalRemaining < 0 && "text-success",
                    breakdown.federalRemaining === 0 && "text-success",
                    breakdown.federalRemaining > 0 && "text-error"
                  )}
                />
              </div>
            </div>

            {/* State */}
            {(breakdown.stateLiability > 0 || breakdown.totalStatePaid > 0) && (
              <div className="space-y-1 border-t border-border/40 pt-2">
                <Row label="State Liability" value={fmtMasked(breakdown.stateLiability)} />
                <Row label="State Paid" value={fmtMasked(breakdown.totalStatePaid)} sub />
                <div className="flex items-center justify-between pl-3 pt-0.5">
                  <span className={cn(
                    "font-medium text-sm",
                    breakdown.stateRemaining < 0 && "text-success",
                    breakdown.stateRemaining === 0 && "text-success",
                    breakdown.stateRemaining > 0 && "text-error"
                  )}>
                    {breakdown.stateRemaining === 0 ? "Paid in Full" : "State Remaining"}
                  </span>
                  <CopyableValue
                    value={fmtMasked(breakdown.stateRemaining)}
                    rawValue={breakdown.stateRemaining}
                    className={cn(
                      "font-semibold",
                      breakdown.stateRemaining < 0 && "text-success",
                      breakdown.stateRemaining === 0 && "text-success",
                      breakdown.stateRemaining > 0 && "text-error"
                    )}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Net Remaining footer */}
          <div
            className={cn(
              "flex items-center justify-between px-4 py-3 border-t",
              "border-t-border/60",
              (isOverpaid || isPaidInFull) ? "bg-success/[0.03]" : "bg-error/[0.03]"
            )}
          >
            <div>
              <span className="font-semibold text-sm">
                {isPaidInFull ? "Paid in Full" : "Total Remaining"}
              </span>
              {isOverpaid && (
                <p className="text-[11px] text-success mt-0.5">
                  Overpaid by {fmt(Math.abs(breakdown.netRemaining))}
                </p>
              )}
              {isPaidInFull && (
                <p className="text-[11px] text-success mt-0.5">
                  All taxes covered
                </p>
              )}
              {!isOverpaid && !isPaidInFull && (
                <p className="text-[11px] text-error mt-0.5">
                  {fmt(breakdown.netRemaining)} still owed
                </p>
              )}
            </div>
            <CopyableValue
              value={fmtMasked(breakdown.netRemaining)}
              rawValue={breakdown.netRemaining}
              className={cn(
                "font-bold text-lg",
                (isOverpaid || isPaidInFull) ? "text-success" : "text-error"
              )}
            />
          </div>
        </div>

    </div>
  );
}

// ============================================================================
// Shared micro-components
// ============================================================================

const QUARTER_CYCLE = ["Q1", "Q2", "Q3", "Q4", "final", "other"] as const;
const QUARTER_LABELS: Record<string, string> = {
  Q1: "Q1",
  Q2: "Q2",
  Q3: "Q3",
  Q4: "Q4",
  final: "Final",
  other: "Other",
};

function PaymentRow({
  payment,
  onUpdate,
  onRemove,
  showQuarter,
}: {
  payment: TaxPaymentEntry;
  onUpdate: (id: string, field: keyof TaxPaymentEntry, value: string | number) => void;
  onRemove: (id: string) => void;
  showQuarter?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:grid sm:grid-cols-[1fr_auto_140px] sm:gap-2 sm:items-center rounded-md py-1 px-2 border-x-[3px] border-x-copper/50 border-y border-y-copper/20 bg-copper/[0.04]">
      <div className="flex items-center gap-1.5 min-w-0">
        <Input
          placeholder="Label"
          value={payment.label}
          onChange={(e) => onUpdate(payment.id, "label", e.target.value)}
          className="h-8 text-sm flex-1 min-w-0"
        />
        <button
          type="button"
          onClick={() =>
            onUpdate(payment.id, "type", payment.type === "federal" ? "state" : "federal")
          }
          className={cn(
            "shrink-0 h-8 px-2 inline-flex items-center rounded-md text-xs font-medium transition-colors",
            payment.type === "federal"
              ? "bg-primary/10 text-primary"
              : "bg-secondary text-foreground"
          )}
        >
          {payment.type === "federal" ? "Fed" : "State"}
        </button>
        {showQuarter && (
          <button
            type="button"
            onClick={() => {
              const current = payment.quarter || "Q1";
              const idx = QUARTER_CYCLE.indexOf(current as typeof QUARTER_CYCLE[number]);
              const next = QUARTER_CYCLE[(idx + 1) % QUARTER_CYCLE.length];
              onUpdate(payment.id, "quarter", next);
            }}
            className="shrink-0 h-8 px-2 inline-flex items-center rounded-md text-xs font-medium transition-colors bg-copper/10 text-copper"
          >
            {QUARTER_LABELS[payment.quarter || "Q1"]}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 sm:contents">
        <button
          onClick={() => onRemove(payment.id)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-error hover:bg-error/10 transition-colors order-1 sm:order-none"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <NumberInput
          placeholder="0"
          value={payment.amount || ""}
          onChange={(e) => onUpdate(payment.id, "amount", Number(e.target.value) || 0)}
          className="h-8 text-sm font-mono flex-1 sm:flex-initial"
        />
      </div>
    </div>
  );
}

function CopyableValue({
  value,
  rawValue,
  className,
}: {
  value: string;
  rawValue: number;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(String(Math.abs(rawValue)));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "font-mono cursor-pointer rounded px-1 -mx-1 transition-colors hover:bg-secondary/60 active:scale-95",
        className
      )}
      title="Click to copy"
    >
      {copied ? "Copied!" : value}
    </button>
  );
}

function Row({
  label,
  value,
  bold,
  sub,
  color,
}: {
  label: string;
  value: string;
  bold?: boolean;
  sub?: boolean;
  color?: "error" | "success" | "muted";
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between",
        sub && "pl-3",
        bold && "font-medium pt-0.5"
      )}
    >
      <span
        className={cn(
          sub ? "text-muted-foreground" : "text-foreground",
          color === "error" && "text-error",
          color === "success" && "text-success",
          color === "muted" && "text-muted-foreground"
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "font-mono",
          bold && "font-semibold",
          color === "error" && "text-error",
          color === "success" && "text-success",
          color === "muted" && "text-muted-foreground"
        )}
      >
        {value}
      </span>
    </div>
  );
}
