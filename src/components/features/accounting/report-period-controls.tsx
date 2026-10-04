"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { DateInput } from "@/components/ui/inputs/DateInput";
import type { ReportFilter } from "@/lib/accounting/reports";
import {
  PERIOD_PRESETS,
  compareLabel,
  compareModeOf,
  presetOf,
  presetRange,
  previousPeriod,
  rangeLabel,
  samePeriodLastYear,
  type CompareMode,
  type PeriodPreset,
} from "@/lib/accounting/profit-loss";
import {
  AS_OF_PRESETS,
  BALANCE_COMPARES,
  asOfDate,
  asOfPresetOf,
  balanceCompareLabel,
  balanceCompareOf,
  balanceFilter,
  compareDate,
  dateText,
  type AsOfPreset,
  type BalanceCompare,
} from "@/lib/accounting/balance-sheet";
import { FilterChip, PresetSegments } from "./report-kit";

/**
 * The period report controls: the period presets with Custom dates, the
 * comparison, what the books include, and a line saying what is shown.
 * Typed dates apply once the owner pauses; a comparison follows the period
 * it compares with. The address bar stays the source of truth: `onApply`
 * writes it, and the controls follow it back.
 */
export function PeriodControls({
  filter,
  today,
  scope,
  updating,
  onApply,
  fiscalMonth = 1,
  compare = true,
}: {
  /** The fiscal year's start month: "Year to date" and "Last year" follow it. */
  fiscalMonth?: number;
  /** Whether the report offers a comparison (the general ledger does not). */
  compare?: boolean;
  filter: ReportFilter;
  today: string;
  /** What the figures cover, for the facts line: "Income by contact". */
  scope: string;
  updating: boolean;
  onApply: (patch: Partial<ReportFilter>, replace?: boolean) => void;
}) {
  const preset = presetOf(filter.from, filter.to, today, fiscalMonth);
  const compareMode = compareModeOf(filter);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const [range, setRange] = useState({ from: filter.from, to: filter.to });
  const [rangeError, setRangeError] = useState("");

  useEffect(() => {
    setRange({ from: filter.from, to: filter.to });
    if (presetOf(filter.from, filter.to, today, fiscalMonth) === "custom") setCustomOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.from, filter.to]);
  useEffect(() => {
    if (!customOpen) return;
    if (range.from === filter.from && range.to === filter.to) return;
    const timer = setTimeout(() => {
      if (!range.from || !range.to) return;
      if (range.from > range.to) {
        setRangeError("The start date is after the end date.");
        return;
      }
      setRangeError("");
      apply({ from: range.from, to: range.to }, true);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, customOpen]);

  function apply(patch: Partial<ReportFilter>, replace = false) {
    const next: Partial<ReportFilter> = { ...patch };
    if (patch.from || patch.to) {
      const from = patch.from ?? filter.from,
        to = patch.to ?? filter.to;
      if (compareMode === "previous") Object.assign(next, previousPeriod(from, to));
      if (compareMode === "year") Object.assign(next, samePeriodLastYear(from, to));
    }
    onApply(next, replace);
  }
  function choosePreset(value: PeriodPreset | "custom") {
    if (value === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setRangeError("");
    apply(presetRange(value, today, fiscalMonth));
  }
  function chooseCompare(mode: CompareMode) {
    if (mode === "none") onApply({ compare_from: undefined, compare_to: undefined });
    else if (mode === "previous") onApply(previousPeriod(filter.from, filter.to));
    else if (mode === "year") onApply(samePeriodLastYear(filter.from, filter.to));
  }
  const compared = compareLabel(filter);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <PresetSegments
          label="Period"
          options={[
            ...PERIOD_PRESETS,
            { value: "custom" as const, label: "Custom", short: "Custom" },
          ]}
          value={customOpen ? "custom" : preset}
          onChoose={choosePreset}
        />
        {customOpen && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
              <DateInput
                ariaLabel="From"
                size="sm"
                minDate="1900-01-01"
                maxDate="2100-12-31"
                value={range.from}
                onChange={(value) => setRange((r) => ({ ...r, from: value }))}
              />
            </div>
            <span aria-hidden="true" className="text-xs text-muted-foreground">
              to
            </span>
            <div className="min-w-0 flex-1 sm:w-40 sm:flex-none">
              <DateInput
                ariaLabel="Through"
                size="sm"
                minDate="1900-01-01"
                maxDate="2100-12-31"
                value={range.to}
                onChange={(value) => setRange((r) => ({ ...r, to: value }))}
              />
            </div>
          </div>
        )}
        {compare && (
        <FilterChip
          label="Compare"
          value={compareMode}
          onChange={(v) => chooseCompare(v as CompareMode)}
          options={[
            { value: "none", label: "No comparison" },
            { value: "previous", label: "Previous period" },
            { value: "year", label: "Same period last year" },
            ...(compareMode === "custom" ? [{ value: "custom", label: "Custom dates" }] : []),
          ]}
        />
        )}
        <FilterChip
          label="Includes"
          value={filter.mode}
          onChange={(v) => onApply({ mode: v as ReportFilter["mode"] })}
          options={[
            { value: "working", label: "All activity" },
            { value: "posted", label: "Reviewed only" },
          ]}
        />
      </div>
      {rangeError && (
        <p role="alert" className="text-xs text-error">
          {rangeError}
        </p>
      )}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{rangeLabel(filter.from, filter.to)}</span>
        <span aria-hidden="true">·</span>
        <span>{scope}</span>
        <span aria-hidden="true">·</span>
        <span>USD</span>
        {compared && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Compared with {compared.long.charAt(0).toLowerCase() + compared.long.slice(1)}
            </span>
          </>
        )}
        <span role="status" className="inline-flex items-center gap-1.5">
          {updating && (
            <>
              <RefreshCw size={12} aria-hidden="true" className="motion-safe:animate-spin" />
              Updating
            </>
          )}
        </span>
      </p>
    </div>
  );
}

/**
 * The as-of report controls (balance sheet, trial balance): the as-of
 * presets with a custom date, the comparison date, what the books include,
 * and a line saying what is shown. A comparison keeps its meaning (end of
 * the previous month, and so on) as the date moves.
 */
export function AsOfControls({
  filter,
  today,
  scope,
  updating,
  onApply,
  fiscalMonth = 1,
}: {
  /** The fiscal year's start month: "End of last year" follows it. */
  fiscalMonth?: number;
  /** The report's filter, as balanceFilter builds it. */
  filter: ReportFilter;
  today: string;
  scope: string;
  updating: boolean;
  onApply: (next: ReportFilter, replace?: boolean) => void;
}) {
  const asOf = filter.to;
  const preset = asOfPresetOf(asOf, today, fiscalMonth);
  const compareMode = balanceCompareOf(filter, fiscalMonth);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const [custom, setCustom] = useState(asOf);
  useEffect(() => {
    setCustom(asOf);
    if (asOfPresetOf(asOf, today, fiscalMonth) === "custom") setCustomOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf]);
  useEffect(() => {
    if (!customOpen || !custom || custom === asOf) return;
    const timer = setTimeout(() => setAsOf(custom, true), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom, customOpen]);
  function setAsOf(date: string, replace = false) {
    const compare =
      compareMode === "none" || compareMode === "custom"
        ? filter.compare_to
        : compareDate(compareMode, date, fiscalMonth);
    onApply(balanceFilter(date, filter.mode, compare), replace);
  }
  function choosePreset(value: AsOfPreset | "custom") {
    if (value === "custom") {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setAsOf(asOfDate(value, today, fiscalMonth));
  }
  const compared = balanceCompareLabel(filter, fiscalMonth);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <PresetSegments
          label="As of"
          options={[...AS_OF_PRESETS, { value: "custom" as const, label: "Custom date", short: "Custom" }]}
          value={customOpen ? "custom" : preset}
          onChoose={choosePreset}
        />
        {customOpen && (
          <div className="w-full sm:w-44">
            <DateInput
              ariaLabel="As of date"
              size="sm"
              minDate="1900-01-01"
              maxDate="2100-12-31"
              value={custom}
              onChange={setCustom}
            />
          </div>
        )}
        <FilterChip
          label="Compare"
          value={compareMode}
          onChange={(v) => {
            const mode = v as BalanceCompare;
            onApply(
              balanceFilter(
                asOf,
                filter.mode,
                mode === "none" || mode === "custom" ? undefined : compareDate(mode, asOf, fiscalMonth),
              ),
            );
          }}
          options={[
            ...BALANCE_COMPARES,
            ...(compareMode === "custom" ? [{ value: "custom", label: "Custom date" }] : []),
          ]}
        />
        <FilterChip
          label="Includes"
          value={filter.mode}
          onChange={(v) => onApply(balanceFilter(asOf, v as ReportFilter["mode"], filter.compare_to))}
          options={[
            { value: "working", label: "All activity" },
            { value: "posted", label: "Reviewed only" },
          ]}
        />
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>As of {dateText(asOf)}</span>
        <span aria-hidden="true">·</span>
        <span>{scope}</span>
        <span aria-hidden="true">·</span>
        <span>USD</span>
        {compared && (
          <>
            <span aria-hidden="true">·</span>
            <span>Compared with {compared.long}</span>
          </>
        )}
        <span role="status" className="inline-flex items-center gap-1.5">
          {updating && (
            <>
              <RefreshCw size={12} aria-hidden="true" className="motion-safe:animate-spin" />
              Updating
            </>
          )}
        </span>
      </p>
    </div>
  );
}
