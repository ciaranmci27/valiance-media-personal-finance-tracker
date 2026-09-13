"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Pencil } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Select } from "@/components/ui/inputs/Select";
import { cn, formatCurrency } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { calculateFullTax } from "@/lib/tax/calculations";
import type { FullTaxBreakdown } from "@/lib/tax/calculations";
import {
  getTaxYearConfig,
  getAvailableTaxYears,
  FILING_STATUS_LABELS,
  type FilingStatus,
} from "@/lib/tax/constants";
import {
  buildMeter,
  buildPaymentSchedule,
  federalDeadlines,
  annualizationPeriod,
  annualizeRows,
  annualizedRequirement,
  estimatedThrough,
  shortfallCost,
  withheldThrough,
} from "@/lib/tax/payment-schedule";
import type { BooksFigure, BooksFigures } from "@/lib/accounting/tax-books-figures";
import { accountingReadJson } from "@/lib/accounting/read-json";
import { toEstimatorDollars } from "@/lib/accounting/tax-projection";
import {
  applyBooksRefresh,
  rowsFromFigures,
  unlinkBooks,
  withRest,
} from "@/lib/tax/books-rows";
import type {
  TaxEstimate,
  TaxIncomeSource,
  TaxCapitalGainEntry,
  TaxPaymentEntry,
  IncomeType,
  BusinessType,
  TaxClassification,
} from "@/types/database";
import { ImportIncomeModal } from "./import-income-modal";
import { TaxSetupCard, TAX_CLASSIFICATION_LABELS } from "./tax-setup-card";
import { booksFiguresUrl, useBooksRefresh } from "./use-books-refresh";
import { TaxBooksCallout } from "./tax-books-callout";
import { SetupGuide } from "@/components/features/accounting/setup-guide";
import {
  businessTypeForYear,
  classificationForYear,
  loadBusinessProfile,
  type BusinessProfile,
} from "@/lib/business-profile";
import { BooksFiguresModal } from "./books-figures-modal";
import { TaxHero } from "./tax-hero";
import { TaxInputsCard } from "./tax-inputs-card";
import { TaxReceipt } from "./tax-receipt";
import { TaxEditSheet } from "./tax-edit-sheet";
import { TaxGuide, type GuideStep } from "./tax-guide";
import type {
  EditTarget,
  EstimatorActions,
  EstimatorModel,
  Household,
  AnnualizedState,
} from "./tax-estimator-model";

const CENT = 0.005;

/** Per-year guide state that data cannot prove, kept in this browser. */
interface GuidePrefs {
  hidden: boolean;
  paidReviewed: boolean;
  householdReviewed: boolean;
}
const GUIDE_DEFAULTS: GuidePrefs = {
  hidden: false,
  paidReviewed: false,
  householdReviewed: false,
};

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

function emptyPayment(
  category: "withholding" | "payment" = "withholding",
): TaxPaymentEntry {
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
  accountingAvailable?: boolean;
  initialYear?: number;
}

export function TaxEstimatorContent({
  estimates,
  accountingAvailable = false,
  initialYear,
}: TaxEstimatorContentProps) {
  const router = useRouter();

  // `estimates` is a server-render snapshot that never refreshes: there is no
  // router.refresh() after a save and no realtime subscription. Reading it
  // directly when switching years would resurrect pre-edit values and then
  // persist them over good data, so all reads go through this local cache and
  // every successful save writes back into it.
  const [estimateCache, setEstimateCache] = React.useState<
    Record<number, TaxEstimate>
  >(() => Object.fromEntries(estimates.map((e) => [e.tax_year, e])));
  const estimateCacheRef = React.useRef(estimateCache);
  React.useEffect(() => {
    estimateCacheRef.current = estimateCache;
  }, [estimateCache]);

  // Adopt years the server knows about that we have not seen yet (for example
  // after the setup wizard runs). Never overwrite a year already in the cache,
  // since ours is newer than the page-load snapshot.
  React.useEffect(() => {
    setEstimateCache((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const e of estimates) {
        if (!next[e.tax_year]) {
          next[e.tax_year] = e;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [estimates]);

  // Derive year tabs from estimates that actually exist AND have a config
  // file registered in tax-core/years. Orphan estimates for unsupported years
  // stay in the DB (no data loss) but don't surface in the picker since we
  // can't calculate anything without that year's brackets and thresholds.
  const yearTabs = React.useMemo(() => {
    const supported = new Set(getAvailableTaxYears());
    return Object.keys(estimateCache)
      .map(Number)
      .filter((y) => supported.has(y))
      .sort((a, b) => b - a);
  }, [estimateCache]);

  // Current selected year
  const [selectedYear, setSelectedYear] = React.useState(() => {
    if (
      initialYear &&
      estimates.some((e) => e.tax_year === initialYear) &&
      getAvailableTaxYears().includes(initialYear)
    )
      return initialYear;
    if (yearTabs.length > 0) return yearTabs[0];
    const currentYear = new Date().getFullYear();
    const supported = getAvailableTaxYears();
    if (supported.includes(currentYear)) return currentYear;
    return supported[0] ?? currentYear;
  });

  // Form state
  const [filingStatus, setFilingStatus] =
    React.useState<FilingStatus>("single");
  const [incomeSources, setIncomeSources] = React.useState<TaxIncomeSource[]>(
    [],
  );
  const [capitalGains, setCapitalGains] = React.useState<TaxCapitalGainEntry[]>(
    [],
  );
  const [payments, setPayments] = React.useState<TaxPaymentEntry[]>([]);
  const [additionalDeductions, setAdditionalDeductions] = React.useState(0);
  const [notes, setNotes] = React.useState("");
  const [existingId, setExistingId] = React.useState<string | null>(null);
  const [state, setState] = React.useState<string | null>(null);
  const [businessType, setBusinessType] = React.useState<BusinessType | null>(
    null,
  );
  const [taxClassification, setTaxClassification] =
    React.useState<TaxClassification | null>(null);
  // The business profile decides each year's structure; a year the estimator
  // creates, or one saved before the profile existed, takes it from here.
  const [businessProfile, setBusinessProfile] =
    React.useState<BusinessProfile | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    loadBusinessProfile()
      .then((result) => {
        if (!cancelled && result.status === "ready")
          setBusinessProfile(result.profile);
      })
      .catch(() => {
        /* Without a profile the row's own structure stands. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  React.useEffect(() => {
    if (!businessProfile) return;
    if (businessType === null)
      setBusinessType(businessTypeForYear(businessProfile, selectedYear));
    if (taxClassification === null)
      setTaxClassification(classificationForYear(businessProfile, selectedYear));
  }, [businessProfile, selectedYear, businessType, taxClassification]);
  const [dependents, setDependents] = React.useState(0);
  const [otherDependents, setOtherDependents] = React.useState(0);
  const [additionalCredits, setAdditionalCredits] = React.useState(0);
  // IRC 199A limitation inputs
  const [isSstb, setIsSstb] = React.useState(false);
  const [businessW2Wages, setBusinessW2Wages] = React.useState(0);
  const [businessPropertyBasis, setBusinessPropertyBasis] = React.useState(0);
  // IRC 63(f) additional standard deduction
  const [taxpayerAge65, setTaxpayerAge65] = React.useState(false);
  const [taxpayerBlind, setTaxpayerBlind] = React.useState(false);
  const [spouseAge65, setSpouseAge65] = React.useState(false);
  const [spouseBlind, setSpouseBlind] = React.useState(false);

  // UI state
  const [saveStatus, setSaveStatus] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const saveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isLoadingRef = React.useRef(true); // prevents auto-save on initial load

  // Bumped on every edit. A save records the version it wrote so that edits made
  // while the request was in flight are not mistaken for having been persisted.
  const editVersionRef = React.useRef(0);

  // Load data for selected year. Depends only on selectedYear: re-running when
  // the cache updates would reset the form out from under an in-progress edit.
  React.useEffect(() => {
    isLoadingRef.current = true;
    const existing = estimateCacheRef.current[selectedYear];
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
      setTaxClassification(
        (existing.tax_classification as TaxClassification) ?? null,
      );
      setDependents(existing.dependents ?? 0);
      setOtherDependents(existing.other_dependents ?? 0);
      setAdditionalCredits(existing.additional_credits ?? 0);
      setIsSstb(existing.is_sstb ?? false);
      setBusinessW2Wages(Number(existing.business_w2_wages) || 0);
      setBusinessPropertyBasis(Number(existing.business_property_basis) || 0);
      setTaxpayerAge65(existing.taxpayer_age_65 ?? false);
      setTaxpayerBlind(existing.taxpayer_blind ?? false);
      setSpouseAge65(existing.spouse_age_65 ?? false);
      setSpouseBlind(existing.spouse_blind ?? false);
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
      setIsSstb(false);
      setBusinessW2Wages(0);
      setBusinessPropertyBasis(0);
      setTaxpayerAge65(false);
      setTaxpayerBlind(false);
      setSpouseAge65(false);
      setSpouseBlind(false);
    }
    setDirty(false);
    setSaveStatus("idle");
    setSaveError(null);
    // Allow auto-save after a tick so the state settles
    requestAnimationFrame(() => {
      isLoadingRef.current = false;
    });
  }, [selectedYear]);

  // Keep the selected year inside the available tabs. Without this, a wizard run
  // that creates only a prior year leaves the form showing an empty current year
  // whose edits would try to insert a second row.
  React.useEffect(() => {
    if (yearTabs.length > 0 && !yearTabs.includes(selectedYear)) {
      setSelectedYear(yearTabs[0]);
    }
  }, [yearTabs, selectedYear]);

  // Tax config for selected year
  const taxConfig = React.useMemo(
    () => getTaxYearConfig(selectedYear),
    [selectedYear],
  );

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
      additionalCredits,
      taxClassification,
      {
        isSstb,
        businessW2Wages,
        businessPropertyBasis,
        taxpayerAge65,
        taxpayerBlind,
        spouseAge65,
        spouseBlind,
      },
    );
  }, [
    incomeSources,
    capitalGains,
    payments,
    additionalDeductions,
    filingStatus,
    taxConfig,
    state,
    dependents,
    otherDependents,
    additionalCredits,
    taxClassification,
    isSstb,
    businessW2Wages,
    businessPropertyBasis,
    taxpayerAge65,
    taxpayerBlind,
    spouseAge65,
    spouseBlind,
  ]);

  // The QBI wage/property limitation only bites once taxable income passes the
  // threshold, so those inputs stay hidden until they can change the answer.
  const showQbiLimitInputs = React.useMemo(() => {
    if (!breakdown || !taxConfig) return false;
    if (breakdown.qbiDeduction <= 0 && !isSstb && businessW2Wages === 0) {
      // Still show it if they are over the threshold with business income,
      // since that is exactly when a zero deduction may be wrong.
      const over =
        breakdown.taxableIncome + breakdown.qbiDeduction >
        taxConfig.qbi.phaseOut[filingStatus];
      return over;
    }
    return (
      breakdown.taxableIncome + breakdown.qbiDeduction >
      taxConfig.qbi.phaseOut[filingStatus]
    );
  }, [breakdown, taxConfig, filingStatus, isSstb, businessW2Wages]);

  // Mark dirty and schedule auto-save
  const markDirty = React.useCallback(() => {
    if (isLoadingRef.current) return;
    editVersionRef.current += 1;
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

  const removeWithholdingsForSource = (
    sourceId: string,
    keepWithAmounts = false,
  ) => {
    setPayments((prev) =>
      prev.flatMap((p) => {
        if (p.linked_income_id !== sourceId) return [p];
        // Withholding that came from the books is its own evidence: unpair it
        // rather than delete it.
        if (p.books) {
          const { linked_income_id: _paired, ...rest } = p;
          void _paired;
          return [rest];
        }
        return keepWithAmounts && p.amount > 0 ? [p] : [];
      }),
    );
  };

  // ============================================================================
  // Income Sources
  // ============================================================================

  const addIncome = () => {
    const row = emptyIncomeSource();
    setIncomeSources((prev) => [...prev, row]);
    markDirty();
    return row.id;
  };

  const addIncomeTemplates = (templates: TaxIncomeSource[]) => {
    if (templates.length === 0) return null;
    setIncomeSources((prev) => [...prev, ...templates]);
    const withholdings = templates.flatMap(createWithholdingsForSource);
    if (withholdings.length > 0) {
      setPayments((prev) => [...prev, ...withholdings]);
    }
    markDirty();
    return templates[0].id;
  };

  const updateIncome = (
    id: string,
    field: keyof TaxIncomeSource,
    value: string | number | boolean,
  ) => {
    setIncomeSources((prev) =>
      prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
    );
    // Sync withholding labels when source name changes
    if (field === "name" && typeof value === "string") {
      setPayments((prev) =>
        prev.map((p) =>
          p.linked_income_id === id && !p.books ? { ...p, label: value } : p,
        ),
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
      prev.map((s) => (s.id === id ? { ...s, is_unlinked: true } : s)),
    );
    markDirty();
  };

  const relinkIncome = (id: string) => {
    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, is_unlinked: false, amount: s.linked_amount ?? s.amount }
          : s,
      ),
    );
    markDirty();
  };

  // ============================================================================
  // Capital Gains
  // ============================================================================

  const addCapitalGain = () => {
    const row = emptyCapitalGain();
    setCapitalGains((prev) => [...prev, row]);
    markDirty();
    return row.id;
  };

  const updateCapitalGain = (
    id: string,
    field: keyof TaxCapitalGainEntry,
    value: string | number,
  ) => {
    setCapitalGains((prev) =>
      prev.map((g) => (g.id === id ? { ...g, [field]: value } : g)),
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
    const row = emptyPayment("withholding");
    setPayments((prev) => [...prev, row]);
    markDirty();
    return row.id;
  };

  const addPayment = (preset?: Partial<TaxPaymentEntry>) => {
    const row: TaxPaymentEntry = { ...emptyPayment("payment"), ...preset };
    setPayments((prev) => [...prev, row]);
    markDirty();
    return row.id;
  };

  const updatePayment = (
    id: string,
    field: keyof TaxPaymentEntry,
    value: string | number,
  ) => {
    setPayments((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
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
      (src) =>
        src.income_type === "w2" &&
        !incomeSources.some(
          (s) => s.linked_source_id === src.linked_source_id && !s.is_unlinked,
        ),
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

  // SE tax doesn't apply to S Corp / C Corp K-1 distributions, so the toggle
  // is hidden (and forced off) in those cases. Partnership K-1s keep the
  // toggle to distinguish general partner (SE) from limited partner (no SE).
  const canHaveSeToggle = React.useCallback(
    (incomeType: IncomeType) => {
      if (incomeType === "1099") return true;
      if (incomeType === "k1") {
        return taxClassification !== "s_corp" && taxClassification !== "c_corp";
      }
      return false;
    },
    [taxClassification],
  );

  // When classification changes to one that can't have SE on K-1, clear any
  // stale SE flags from prior state to keep calculations and UI consistent.
  React.useEffect(() => {
    if (taxClassification !== "s_corp" && taxClassification !== "c_corp")
      return;
    setIncomeSources((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (s.income_type === "k1" && s.subject_to_se) {
          changed = true;
          return { ...s, subject_to_se: false };
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [taxClassification]);

  const toggleMaterialParticipation = (sourceId: string) => {
    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === sourceId
          ? { ...s, materially_participates: !s.materially_participates }
          : s,
      ),
    );
    markDirty();
  };

  const toggleTaxpayer = (sourceId: string) => {
    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === sourceId
          ? {
              ...s,
              taxpayer: (s.taxpayer ?? "self") === "self" ? "spouse" : "self",
            }
          : s,
      ),
    );
    markDirty();
  };

  const toggleSe = (sourceId: string) => {
    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === sourceId ? { ...s, subject_to_se: !s.subject_to_se } : s,
      ),
    );
    markDirty();
  };

  const handleIncomeTypeChange = (sourceId: string, newType: IncomeType) => {
    const source = incomeSources.find((s) => s.id === sourceId);

    // Re-picking the type a row already has must be a no-op. Falling through
    // would reset subject_to_se (turning an investment-income row into
    // self-employment income) and duplicate any linked withholding rows.
    if (source && source.income_type === newType) return;
    // Rows from the books are typed by the figure they carry.
    if (source?.books) return;

    const wasW2 = source?.income_type === "w2";
    const isNowW2 = newType === "w2";

    setIncomeSources((prev) =>
      prev.map((s) =>
        s.id === sourceId
          ? { ...s, income_type: newType, subject_to_se: newType === "1099" }
          : s,
      ),
    );

    if (!wasW2 && isNowW2 && source) {
      const withholdings = createWithholdingsForSource({
        ...source,
        income_type: "w2",
      });
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

  // Snapshot of everything a save needs, refreshed whenever the form changes, so
  // that a flush triggered from elsewhere (year switch, unmount) writes the
  // current values rather than whatever was captured when a timer was scheduled.
  const saveContextRef = React.useRef<{
    year: number;
    existingId: string | null;
    payload: Record<string, unknown>;
  } | null>(null);

  saveContextRef.current = {
    year: selectedYear,
    existingId,
    payload: {
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
      is_sstb: isSstb,
      business_w2_wages: businessW2Wages,
      business_property_basis: businessPropertyBasis,
      taxpayer_age_65: taxpayerAge65,
      taxpayer_blind: taxpayerBlind,
      spouse_age_65: spouseAge65,
      spouse_blind: spouseBlind,
      notes: notes || null,
    },
  };

  /**
   * Persist the current form state.
   *
   * supabase-js resolves with { data, error } instead of throwing, so the error
   * has to be read explicitly. Reporting success on a failed write is worse than
   * failing loudly: it clears the dirty flag and the edit is gone.
   */
  const persist = React.useCallback(async (): Promise<boolean> => {
    const ctx = saveContextRef.current;
    if (!ctx) return false;

    if (isDemoMode()) {
      setDirty(false);
      setSaveStatus("saved");
      return true;
    }

    const versionAtStart = editVersionRef.current;
    setSaveStatus("saving");

    try {
      const supabase = createClient();
      let savedId = ctx.existingId;

      if (ctx.existingId) {
        const { error } = await supabase
          .from("tax_estimates")
          .update(ctx.payload)
          .eq("id", ctx.existingId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("tax_estimates")
          .insert(ctx.payload)
          .select("id")
          .single();
        if (error) throw error;
        savedId = data?.id ?? null;
        if (savedId) setExistingId(savedId);
      }

      // Write back so switching years reads what we just saved.
      setEstimateCache((prev) => ({
        ...prev,
        [ctx.year]: {
          ...(prev[ctx.year] ?? {}),
          ...ctx.payload,
          id: savedId,
        } as TaxEstimate,
      }));
      setSaveError(null);

      // Only clear dirty if nothing changed while the request was in flight.
      // Otherwise leave it set so the debounce writes the newer edit too.
      if (editVersionRef.current === versionAtStart) {
        setDirty(false);
        setSaveStatus("saved");
      } else {
        setSaveStatus("idle");
      }
      return true;
    } catch (err) {
      console.error("Failed to save tax estimate", err);
      setSaveError(
        err instanceof Error ? err.message : "Could not save changes",
      );
      setSaveStatus("error");
      // Deliberately leave `dirty` true so the next edit or flush retries.
      return false;
    }
  }, []);

  React.useEffect(() => {
    if (!dirty || isLoadingRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void persist();
    }, 1500);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dirty,
    filingStatus,
    incomeSources,
    capitalGains,
    payments,
    additionalDeductions,
    notes,
    selectedYear,
    existingId,
    state,
    businessType,
    taxClassification,
    dependents,
    otherDependents,
    additionalCredits,
    isSstb,
    businessW2Wages,
    businessPropertyBasis,
    taxpayerAge65,
    taxpayerBlind,
    spouseAge65,
    spouseBlind,
  ]);

  /** Flush any pending write, then switch year. */
  const changeYear = React.useCallback(
    async (year: number) => {
      if (year === selectedYear) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (dirty) {
        const ok = await persist();
        // Keep the user on the year that failed rather than silently dropping it.
        if (!ok) return;
      }
      setSelectedYear(year);
    },
    [selectedYear, dirty, persist],
  );

  // Unsaved edits survive at most 1.5s, so warn before the tab closes or a hard
  // navigation happens while a write is still pending.
  React.useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ============================================================================
  // Household (the per-year columns the sheet edits)
  // ============================================================================

  const setHousehold = (patch: Partial<Household>) => {
    if (patch.dependents !== undefined)
      setDependents(Math.max(0, patch.dependents));
    if (patch.otherDependents !== undefined)
      setOtherDependents(Math.max(0, patch.otherDependents));
    if (patch.additionalDeductions !== undefined)
      setAdditionalDeductions(patch.additionalDeductions);
    if (patch.additionalCredits !== undefined)
      setAdditionalCredits(patch.additionalCredits);
    if (patch.taxpayerAge65 !== undefined) setTaxpayerAge65(patch.taxpayerAge65);
    if (patch.taxpayerBlind !== undefined) setTaxpayerBlind(patch.taxpayerBlind);
    if (patch.spouseAge65 !== undefined) setSpouseAge65(patch.spouseAge65);
    if (patch.spouseBlind !== undefined) setSpouseBlind(patch.spouseBlind);
    if (patch.isSstb !== undefined) setIsSstb(patch.isSstb);
    if (patch.businessW2Wages !== undefined)
      setBusinessW2Wages(Math.max(0, patch.businessW2Wages));
    if (patch.businessPropertyBasis !== undefined)
      setBusinessPropertyBasis(Math.max(0, patch.businessPropertyBasis));
    markDirty();
  };

  // Filing status and state are the two profile fields the owner changes
  // year to year. Business structure stays with tax settings, which also
  // defers to the business profile when one exists.
  const setProfile = (patch: {
    filingStatus?: FilingStatus;
    state?: string | null;
  }) => {
    if (patch.filingStatus !== undefined) setFilingStatus(patch.filingStatus);
    if (patch.state !== undefined) setState(patch.state);
    markDirty();
  };

  // ============================================================================
  // Presentation state
  // ============================================================================

  // Fixed for the session so the server and client agree on "due in N days".
  const [today] = React.useState(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix" }).format(
      new Date(),
    ),
  );
  const [editing, setEditing] = React.useState<EditTarget | null>(null);

  // Rows from the books: one read per year shown, plus Refresh. Applying a
  // refresh goes through the same setters and dirty tracking as any edit.
  const [booksOpen, setBooksOpen] = React.useState(false);
  const hasBooksRows =
    incomeSources.some((r) => !!r.books) ||
    capitalGains.some((r) => !!r.books) ||
    payments.some((r) => !!r.books);
  const applyFigures = (figures: BooksFigure[]) => {
    const result = applyBooksRefresh(
      { income: incomeSources, gains: capitalGains, payments },
      figures,
      { state, now: new Date().toISOString() },
    );
    if (result.changed) {
      setIncomeSources(result.income);
      setCapitalGains(result.gains);
      setPayments(result.payments);
      markDirty();
    }
    return { moved: result.moved, problems: result.problems };
  };
  const booksRefresh = useBooksRefresh({
    year: selectedYear,
    enabled: accountingAvailable,
    hasBooksRows,
    apply: applyFigures,
  });

  const guideKey = `vm-tax-guide:${selectedYear}`;
  const [guidePrefs, setGuidePrefs] = React.useState<GuidePrefs>(GUIDE_DEFAULTS);
  React.useEffect(() => {
    let stored: GuidePrefs = GUIDE_DEFAULTS;
    try {
      const raw = window.localStorage.getItem(guideKey);
      if (raw) stored = { ...GUIDE_DEFAULTS, ...JSON.parse(raw) };
    } catch {
      stored = GUIDE_DEFAULTS;
    }
    setGuidePrefs(stored);
  }, [guideKey]);
  const updateGuidePrefs = (patch: Partial<GuidePrefs>) => {
    setGuidePrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(guideKey, JSON.stringify(next));
      } catch {
        // Private mode or blocked storage: the guide just reappears next visit.
      }
      return next;
    });
  };

  const schedule = React.useMemo(
    () =>
      breakdown
        ? buildPaymentSchedule({
            year: selectedYear,
            today,
            payments: payments,
            breakdown,
            deadlines: federalDeadlines[selectedYear],
          })
        : null,
    [breakdown, selectedYear, today, payments],
  );
  const meter = React.useMemo(
    () =>
      breakdown ? buildMeter(breakdown, payments) : null,
    [breakdown, payments],
  );

  // The IRS period behind the next deadline. Once it has closed, today's
  // books rows would count income earned after it, so the period's actuals
  // are read once through its last day. While it is open, today's actuals
  // are the period's actuals so far.
  const nextQuarter =
    schedule?.next?.kind === "quarter" ? schedule.next.quarter : null;
  const period = React.useMemo(
    () => (nextQuarter ? annualizationPeriod(selectedYear, nextQuarter) : null),
    [nextQuarter, selectedYear],
  );
  const periodClosed = !!period && today > period.end;
  const [periodActuals, setPeriodActuals] = React.useState<
    | { status: "ready"; through: string; values: Record<string, number> }
    | { status: "error" }
    | null
  >(null);
  const periodEnd = period?.end ?? null;
  // Waits for the year's own books read to land, so the period read happens
  // once, after it, rather than racing it on first paint.
  const booksLanded = booksRefresh.books.through !== null;
  React.useEffect(() => {
    if (!periodEnd || !periodClosed || !accountingAvailable || !hasBooksRows || !booksLanded) {
      setPeriodActuals(null);
      return;
    }
    const abort = new AbortController();
    accountingReadJson<BooksFigures>(booksFiguresUrl(selectedYear, periodEnd), abort.signal)
      .then((figures) => {
        if (abort.signal.aborted) return;
        const values: Record<string, number> = {};
        for (const figure of figures.figures) {
          try {
            values[figure.key] = toEstimatorDollars(figure.amount_cents);
          } catch {
            /* Out of the estimator's range: the row's own actual stands in. */
          }
        }
        setPeriodActuals({ status: "ready", through: figures.through, values });
      })
      .catch(() => {
        if (!abort.signal.aborted) setPeriodActuals({ status: "error" });
      });
    return () => abort.abort();
  }, [periodEnd, periodClosed, accountingAvailable, hasBooksRows, booksLanded, selectedYear, booksRefresh.books.through]);

  const annualized = React.useMemo<AnnualizedState | null>(() => {
    if (!period || !breakdown || !taxConfig || !schedule?.next || schedule.next.kind !== "quarter")
      return null;
    if (periodClosed && hasBooksRows && periodActuals?.status !== "ready")
      return periodActuals?.status === "error"
        ? { kind: "unavailable", reason: "Books figures for the period could not be read." }
        : null;
    const actuals = periodActuals?.status === "ready" ? periodActuals.values : {};
    const scaled = calculateFullTax(
      annualizeRows(incomeSources, period.factor, actuals),
      annualizeRows(capitalGains, period.factor, actuals),
      [],
      additionalDeductions,
      filingStatus,
      taxConfig,
      state,
      dependents,
      otherDependents,
      additionalCredits,
      taxClassification,
      {
        isSstb,
        businessW2Wages,
        businessPropertyBasis,
        taxpayerAge65,
        taxpayerBlind,
        spouseAge65,
        spouseBlind,
      },
    );
    const withheld = withheldThrough(payments, period, actuals);
    const estimated = estimatedThrough(payments, period.quarter);
    // Employee FICA is charged and credited by the engine in equal measure,
    // so it is not part of what an instalment has to cover.
    const basis = {
      period,
      annualizedTax: {
        federal: Math.max(
          scaled.federalLiability - scaled.ficaTax.total - scaled.additionalChildTaxCredit,
          0,
        ),
        state: scaled.stateLiability,
      },
      paidToDate: {
        federal: withheld.federal + estimated.federal,
        state: withheld.state + estimated.state,
      },
    };
    const required = annualizedRequirement(basis);
    const full = annualizedRequirement({ ...basis, share: period.paceShare });
    const index = schedule.quarters.findIndex((q) => q.key === period.quarter);
    const following = schedule.quarters[index + 1]?.deadline ?? `${selectedYear + 1}-04-15`;
    const gapFederal = Math.max(required.federal - schedule.next.suggestedFederal, 0);
    const gapState = Math.max(required.state - schedule.next.suggestedState, 0);
    const shortfall =
      gapFederal > 0.005 || gapState > 0.005
        ? {
            federal: gapFederal,
            state: gapState,
            cost:
              shortfallCost(gapFederal, schedule.next.deadline, following) +
              shortfallCost(gapState, schedule.next.deadline, following),
          }
        : null;
    return {
      kind: "ready",
      quarter: period.quarter,
      through: periodClosed ? period.end : today,
      partial: !periodClosed,
      federal: required.federal,
      state: required.state,
      full,
      share: period.share,
      paceShare: period.paceShare,
      following,
      shortfall,
    };
  }, [
    period,
    periodClosed,
    periodActuals,
    hasBooksRows,
    breakdown,
    taxConfig,
    schedule,
    selectedYear,
    today,
    incomeSources,
    capitalGains,
    payments,
    additionalDeductions,
    filingStatus,
    state,
    dependents,
    otherDependents,
    additionalCredits,
    taxClassification,
    isSstb,
    businessW2Wages,
    businessPropertyBasis,
    taxpayerAge65,
    taxpayerBlind,
    spouseAge65,
    spouseBlind,
  ]);

  // The row a sheet is editing must still exist in base state. A removal, a
  // year switch or an import that drops it closes the sheet.
  const editingResolved = React.useMemo<EditTarget | null>(() => {
    if (!editing) return null;
    if (editing.mode === "income")
      return incomeSources.some((r) => r.id === editing.id) ? editing : null;
    if (editing.mode === "gain")
      return capitalGains.some((r) => r.id === editing.id) ? editing : null;
    if (editing.mode === "withholding" || editing.mode === "payment")
      return payments.some((r) => r.id === editing.id) ? editing : null;
    return editing;
  }, [editing, incomeSources, capitalGains, payments]);
  React.useEffect(() => {
    if (editing && !editingResolved) setEditing(null);
  }, [editing, editingResolved]);

  // ============================================================================
  // Render
  // ============================================================================

  // Setup mode: no data for any year
  const isSetupMode = Object.keys(estimateCache).length === 0;

  if (isSetupMode) {
    return (
      <div className="animate-fade-up">
        <TaxSetupCard
          onComplete={handleSetupComplete}
          selectedYear={selectedYear}
        />
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

  if (!breakdown || !taxConfig || !schedule || !meter) {
    return (
      <div className="space-y-5 animate-fade-up">
        <PageHeader title="Tax Estimator" />
        <p className="text-sm text-muted-foreground">
          Tax tables for {selectedYear} are not available yet.
        </p>
      </div>
    );
  }

  const addBooksRows = (figures: BooksFigure[]) => {
    const result = rowsFromFigures(figures, {
      taxClassification,
      state,
      now: new Date().toISOString(),
      existing: { income: incomeSources, gains: capitalGains, payments },
    });
    if (result.addedIds.length === 0) return;
    setIncomeSources(result.income);
    setCapitalGains(result.gains);
    setPayments(result.payments);
    markDirty();
    const first = result.firstId;
    if (!first) return;
    if (result.income.some((r) => r.id === first)) setEditing({ mode: "income", id: first });
    else if (result.gains.some((r) => r.id === first)) setEditing({ mode: "gain", id: first });
    else setEditing({ mode: "withholding", id: first });
  };
  const booksKeys = new Set<string>(
    [...incomeSources, ...capitalGains, ...payments].flatMap((r) =>
      r.books ? [r.books.key] : [],
    ),
  );
  const setIncomeRest = (id: string, rest: number) => {
    setIncomeSources((prev) => prev.map((r) => (r.id === id ? withRest(r, rest, state) : r)));
    markDirty();
  };
  const setGainRest = (id: string, rest: number) => {
    setCapitalGains((prev) => prev.map((r) => (r.id === id ? withRest(r, rest, state) : r)));
    markDirty();
  };
  const setPaymentRest = (id: string, rest: number) => {
    setPayments((prev) => prev.map((r) => (r.id === id ? withRest(r, rest, state) : r)));
    markDirty();
  };
  const unlinkIncomeBooks = (id: string) => {
    setIncomeSources((prev) => prev.map((r) => (r.id === id ? unlinkBooks(r) : r)));
    markDirty();
  };
  const unlinkGainBooks = (id: string) => {
    setCapitalGains((prev) => prev.map((r) => (r.id === id ? unlinkBooks(r) : r)));
    markDirty();
  };
  const unlinkPaymentBooks = (id: string) => {
    setPayments((prev) => prev.map((r) => (r.id === id ? unlinkBooks(r) : r)));
    markDirty();
  };

  const model: EstimatorModel = {
    year: selectedYear,
    today,
    filingStatus,
    state,
    businessType,
    taxClassification,
    taxConfig,
    incomeSources,
    capitalGains,
    payments,
    books: booksRefresh.books,
    household: {
      dependents,
      otherDependents,
      additionalDeductions,
      additionalCredits,
      taxpayerAge65,
      taxpayerBlind,
      spouseAge65,
      spouseBlind,
      isSstb,
      businessW2Wages,
      businessPropertyBasis,
    },
    showQbiLimitInputs,
    notes,
    breakdown,
    schedule,
    meter,
    annualized,
  };

  const actions: EstimatorActions = {
    income: {
      add: addIncome,
      addTemplates: addIncomeTemplates,
      update: updateIncome,
      remove: removeIncome,
      unlink: unlinkIncome,
      relink: relinkIncome,
      setType: handleIncomeTypeChange,
      toggleSe,
      toggleMaterialParticipation,
      toggleTaxpayer,
      canHaveSeToggle,
      setRest: setIncomeRest,
      unlinkBooks: unlinkIncomeBooks,
    },
    gains: {
      add: addCapitalGain,
      update: updateCapitalGain,
      remove: removeCapitalGain,
      setRest: setGainRest,
      unlinkBooks: unlinkGainBooks,
    },
    payments: {
      addWithholding,
      addPayment,
      update: updatePayment,
      remove: removePayment,
      setRest: setPaymentRest,
      unlinkBooks: unlinkPaymentBooks,
    },
    setHousehold,
    setProfile,
    setNotes: (value) => {
      setNotes(value);
      markDirty();
    },
    openImport: () => setImportOpen(true),
    openBooks: () => setBooksOpen(true),
    refreshBooks: booksRefresh.refresh,
    guide: {
      markStep: (step, done) =>
        updateGuidePrefs(
          step === "paid" ? { paidReviewed: done } : { householdReviewed: done },
        ),
      hide: () => updateGuidePrefs({ hidden: true }),
    },
  };

  // Guided setup. Income can be read from the data; "nothing paid yet" and
  // "household looks right" are answers only the owner can give.
  const grossIncome = incomeSources.reduce(
    (sum, row) => sum + row.amount,
    0,
  );
  const paidCash = payments.reduce((sum, row) => sum + (row.amount || 0), 0);
  const incomeReady = incomeSources.some(
    (row) => row.amount > CENT,
  );
  const paidReady = paidCash > CENT || guidePrefs.paidReviewed;
  const householdTouched =
    dependents > 0 ||
    otherDependents > 0 ||
    additionalDeductions > 0 ||
    additionalCredits > 0 ||
    taxpayerAge65 ||
    taxpayerBlind ||
    spouseAge65 ||
    spouseBlind;
  const householdReady = householdTouched || guidePrefs.householdReviewed;
  const guideDensity: "hero" | "strip" | "none" = guidePrefs.hidden
    ? "none"
    : !incomeReady
      ? "hero"
      : !paidReady || !householdReady
        ? "strip"
        : "none";
  const guideSteps: GuideStep[] = [
    {
      key: "profile",
      title: "Your profile",
      question: "Filing status, state and business structure.",
      summary: profileParts.join(" \u00B7 "),
      done: true,
      action: { label: "Edit", onSelect: () => setEditing({ mode: "profile" }) },
    },
    {
      key: "income",
      title: "Income",
      question: "What did you earn this year?",
      summary: `${incomeSources.length} ${incomeSources.length === 1 ? "source" : "sources"}, ${formatCurrency(grossIncome)}`,
      done: incomeReady,
      action: { label: "Add income", onSelect: () => setEditing({ mode: "add-income" }) },
    },
    {
      key: "paid",
      title: "Tax already paid",
      question: "Any paycheck withholding or quarterly estimates so far?",
      summary: paidCash > CENT ? `${formatCurrency(paidCash)} recorded` : "Nothing paid yet",
      done: paidReady,
      action: { label: "Add", onSelect: () => setEditing({ mode: "add-paid" }) },
      skip: { label: "Nothing yet", onSelect: () => updateGuidePrefs({ paidReviewed: true }) },
    },
    {
      key: "household",
      title: "Household",
      question: "Any dependents, extra deductions or credits?",
      summary: householdTouched
        ? "Dependents or extra deductions set"
        : "No dependents, standard deduction",
      done: householdReady,
      action: { label: "Review", onSelect: () => setEditing({ mode: "household" }) },
      skip: {
        label: "Looks right",
        onSelect: () => updateGuidePrefs({ householdReviewed: true }),
      },
    },
  ];

  const recordPayment = () => {
    const next = schedule.next;
    const quarter =
      next?.kind === "quarter" && next.quarter ? next.quarter : "final";
    setEditing({
      mode: "payment",
      id: addPayment({
        quarter,
        label:
          quarter === "final" ? "Payment with return" : `${quarter} federal estimate`,
      }),
    });
  };

  return (
    <div className="space-y-5 lg:space-y-6 animate-fade-up">
      <PageHeader
        title="Tax Estimator"
        subtitle={
          <span className="hidden sm:inline">
            Federal and state estimates for {selectedYear}
          </span>
        }
      />
      <SetupGuide
        year={Math.min(selectedYear, new Date().getFullYear())}
        enabled={accountingAvailable}
        onApplied={booksRefresh.refresh}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Profile summary + settings link */}
        <button
          type="button"
          onClick={() => setEditing({ mode: "profile" })}
          className="group inline-flex items-center gap-2 rounded-md text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {profileParts.join(" \u00B7 ")}
          <Pencil
            size={13}
            aria-hidden="true"
            className="text-muted-foreground transition-colors group-hover:text-foreground"
          />
          <span className="sr-only">Edit filing status and state</span>
        </button>

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
          {saveStatus === "error" && (
            <button
              type="button"
              onClick={() => void persist()}
              title={saveError ?? "Save failed"}
              className="flex items-center gap-1.5 text-xs text-error hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error rounded"
            >
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              Not saved. Retry
            </button>
          )}

          {/* Year Tabs - dropdown on mobile, buttons on desktop */}
          <div className="sm:hidden w-28">
            <Select
              ariaLabel="Year"
              value={String(selectedYear)}
              onChange={(value) => void changeYear(Number(value))}
              options={yearTabs.map((year) => ({
                value: String(year),
                label: String(year),
              }))}
              size="sm"
            />
          </div>
          <div className="hidden sm:flex gap-0.5 rounded-lg bg-[rgba(var(--ink),0.05)] p-0.5 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]">
            {yearTabs.map((year) => (
              <button
                key={year}
                onClick={() => void changeYear(year)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-200",
                  selectedYear === year
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {year}
              </button>
            ))}
          </div>
        </div>
      </div>

      {guideDensity === "hero" ? (
        <TaxGuide
          year={selectedYear}
          density="hero"
          steps={guideSteps}
          onHide={() => updateGuidePrefs({ hidden: true })}
        />
      ) : (
        <TaxHero
          year={selectedYear}
          breakdown={breakdown}
          schedule={schedule}
          meter={meter}
          annualized={annualized}
          onRecordPayment={recordPayment}
        />
      )}
      {guideDensity === "strip" && (
        <TaxGuide
          year={selectedYear}
          density="strip"
          steps={guideSteps}
          onHide={() => updateGuidePrefs({ hidden: true })}
        />
      )}

      <TaxBooksCallout
        count={booksRefresh.books.unreviewed}
        refreshing={booksRefresh.books.status === "loading"}
        onRefresh={booksRefresh.refresh}
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <TaxInputsCard model={model} actions={actions} onEdit={setEditing} />
        <TaxReceipt year={selectedYear} breakdown={breakdown} />
      </div>

      <TaxEditSheet
        target={editingResolved}
        model={model}
        actions={actions}
        onNavigate={setEditing}
        onClose={() => setEditing(null)}
      />

      <ImportIncomeModal
        open={importOpen}
        onOpenChange={setImportOpen}
        taxYear={selectedYear}
        onImport={handleImport}
        taxClassification={taxClassification}
      />
      <BooksFiguresModal
        open={booksOpen}
        year={selectedYear}
        state={state}
        taxClassification={taxClassification}
        existingKeys={booksKeys}
        onAdd={addBooksRows}
        onClose={() => setBooksOpen(false)}
      />
    </div>
  );
}
