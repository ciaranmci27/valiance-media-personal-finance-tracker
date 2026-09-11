"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Select } from "@/components/ui/inputs/Select";
import { Toggle } from "@/components/ui/inputs/Toggle";
import {
  taxLinkCommandSchema,
  validateTaxTargets,
  type TaxLinkBody,
  type TaxLinkView,
} from "@/lib/accounting/tax-links";
import type { TaxSource } from "@/lib/accounting/tax-workpapers";
import { payrollFactLabels, type PayrollYear } from "@/lib/accounting/payroll";
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { WorkflowActions, WorkflowDialog } from "./accounting-dialog";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { AccountingEntryPicker } from "./accounting-entry-picker";
import { money, monthLabel, todayInBooks } from "./format";

const separateConcepts = {
  interest: "Interest income",
  qualified_dividend: "Qualified dividends",
  short_gain: "Short-term capital gains",
  long_gain: "Long-term capital gains",
} as const;
const moneyDefault = (value: string | null | undefined) =>
  value == null ? "" : centsToDecimal(BigInt(value));
function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </p>
  );
}
/**
 * Uncontrolled target picker. The form reads every target through FormData,
 * so the chosen value travels in a hidden input under the same name.
 */
function TargetSelect({
  name,
  label,
  rows,
  current,
}: {
  name: string;
  label: string;
  rows: { id: string; label: string }[];
  current?: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  return (
    <div data-form-change>
      <Select
        label={label}
        value={value}
        onChange={setValue}
        options={[
          { value: "", label: "Keep manual" },
          ...rows.map((row) => ({ value: row.id, label: row.label })),
        ]}
      />
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
export function AccountingTaxLinkEditor({
  view,
  source,
  onClose,
  onSaved,
}: {
  view: TaxLinkView;
  source: TaxSource;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const initial = view.link?.body,
    estimate = view.estimate!;
  const [id] = useState(() => view.link?.id ?? crypto.randomUUID());
  const [through, setThrough] = useState(initial?.through ?? source.through),
    [mode, setMode] = useState<TaxLinkBody["cutoff_mode"]>(
      initial?.cutoff_mode ?? "fixed",
    );
  const [business, setBusiness] = useState(initial?.business_target_id ?? ""),
    [method, setMethod] = useState(initial?.forecast.method ?? "manual");
  const [months, setMonths] = useState(
    initial?.forecast.method === "average"
      ? initial.forecast.months
      : ([] as string[]),
  );
  const [exclusions, setExclusions] = useState(
    initial?.forecast.method !== "manual"
      ? (initial?.forecast.exclusions ?? [])
      : [],
  );
  const [payrollEnabled, setPayrollEnabled] = useState(!!initial?.payroll),
    [employeeKey, setEmployeeKey] = useState(
      initial?.payroll?.employee_key ?? "",
    );
  const [manualReview, setManualReview] = useState(
      !!initial?.manual_separate_review,
    ),
    [document, setDocument] = useState(
      initial?.manual_separate_review?.document_id ?? "",
    );
  const [facts, setFacts] = useState<TaxSource | null>(null),
    [payroll, setPayroll] = useState<PayrollYear | null>(null),
    [factsError, setFactsError] = useState("");
  // Advanced opens when the link already uses it, or when the books carry
  // separately stated amounts that still need a target.
  const [advancedOpen] = useState(
    () =>
      (initial?.separate_targets.length ?? 0) > 0 ||
      !!initial?.manual_separate_review ||
      !!initial?.payroll ||
      (initial?.forecast.method !== "manual" &&
        (initial?.forecast.exclusions.length ?? 0) > 0) ||
      Object.values(source.separately_stated).some((v) => v !== "0"),
  );
  const command = useAccountingCommand(onSaved);
  const today = todayInBooks();
  const maxDate =
    estimate.tax_year === Number(today.slice(0, 4))
      ? today
      : `${estimate.tax_year}-12-31`;
  const effectiveThrough = mode === "today" ? maxDate : through;
  useEffect(() => {
    const abort = new AbortController();
    setFacts(null);
    setPayroll(null);
    setFactsError("");
    Promise.all([
      accountingGet<TaxSource>(
        {
          view: "tax-workpapers",
          year: String(estimate.tax_year),
          through: effectiveThrough,
        },
        abort.signal,
      ),
      accountingGet<PayrollYear>(
        {
          view: "payroll-year",
          year: String(estimate.tax_year),
          through: effectiveThrough,
        },
        abort.signal,
      ),
    ])
      .then(([tax, pay]) => {
        setFacts(tax);
        setPayroll(pay);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setFactsError(e.message);
      });
    return () => abort.abort();
  }, [estimate.tax_year, effectiveThrough]);
  const employee = payroll?.coverage?.employees.find(
    (e) => e.key === employeeKey,
  );
  const availableIncome = (type: string) =>
    estimate.income_sources.filter(
      (r) =>
        r.income_type === type &&
        !r.subject_to_se &&
        (!r.linked_source_id || r.is_unlinked),
    );
  const forecasting = !!business && method !== "manual";
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    command.setError("");
    try {
      const fields = new FormData(event.currentTarget),
        text = (key: string) => String(fields.get(key) ?? ""),
        money = (key: string) => parseUsd(text(key)).toString();
      // Fields under Advanced validate here rather than natively, so a closed
      // disclosure never hides the field the browser is complaining about.
      if (
        forecasting &&
        exclusions.some((x) => !x.entry_id || !x.reason.trim())
      )
        throw new Error("Complete each forecast exclusion or remove it.");
      if (manualReview && !document)
        throw new Error(
          "Attach the document supporting the separately stated review.",
        );
      if (manualReview && !text("separate_reason").trim())
        throw new Error("Add review notes for the separately stated items.");
      if (payrollEnabled && !employeeKey)
        throw new Error("Choose the employee for the payroll facts.");
      const forecast: TaxLinkBody["forecast"] =
        !business || method === "manual"
          ? {
              method: "manual",
              remaining_cents: business ? money("business_remaining") : "0",
            }
          : method === "average"
            ? {
                method,
                months,
                exclusions,
                current_month_remaining_cents: money("partial_remaining"),
              }
            : {
                method,
                exclusions,
                current_month_remaining_cents: money("partial_remaining"),
              };
      const separate_targets: TaxLinkBody["separate_targets"] = Object.keys(
        separateConcepts,
      ).flatMap((key) => {
        const concept = key as keyof typeof separateConcepts,
          target_id = text(`target_${key}`);
        return target_id
          ? [{ concept, target_id, remaining_cents: money(`remaining_${key}`) }]
          : [];
      });
      const remaining = Object.fromEntries(
        Object.keys(payrollFactLabels).map((key) => [
          key,
          text(key).trim() ? money(key) : null,
        ]),
      ) as NonNullable<TaxLinkBody["payroll"]>["remaining"];
      const body: TaxLinkBody = {
        cutoff_mode: mode,
        through: effectiveThrough,
        business_target_id: business || null,
        forecast,
        separate_targets,
        payroll: payrollEnabled
          ? {
              employee_key: employeeKey,
              income_target_id: text("wages_target") || null,
              federal_payment_id: text("federal_target") || null,
              state_payment_id: text("state_target") || null,
              state_code: text("payroll_state") || null,
              remaining,
            }
          : null,
        manual_separate_review: manualReview
          ? {
              charity_cents: facts?.separately_stated.charity ?? "0",
              tax_exempt_cents: facts?.separately_stated.tax_exempt ?? "0",
              document_id: document,
              reason: text("separate_reason"),
            }
          : null,
      };
      validateTaxTargets(estimate, body);
      const parsed = taxLinkCommandSchema.safeParse({
        type: "tax.link.save",
        id,
        estimate_id: estimate.id,
        expected_version: view.link?.version ?? 0,
        enabled: true,
        body,
        // The note is optional here; the command still needs one.
        reason: text("reason").trim() || "Linked from the tax workpapers",
        verified: true,
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      await command.execute(parsed.data);
    } catch (e) {
      command.setError(
        e instanceof Error
          ? e.message
          : "Review the target rows and forecast assumptions.",
      );
    }
  }
  return (
    <WorkflowDialog
      title="Link tax estimate"
      form
      busy={command.busy}
      onClose={onClose}
      size="md"
    >
      <form onSubmit={save} className="space-y-5">
        <fieldset disabled={command.busy} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div data-form-change>
              <Select
                label="Actuals cutoff"
                value={mode}
                onChange={(value) => setMode(value as typeof mode)}
                options={[
                  { value: "fixed", label: "Fixed date" },
                  { value: "today", label: "Through today" },
                ]}
              />
            </div>
            <DateInput
              label="Through"
              description={mode === "today" ? "Advances daily" : undefined}
              value={effectiveThrough}
              minDate={`${estimate.tax_year}-01-01`}
              maxDate={maxDate}
              readOnly={mode === "today"}
              onChange={(nextValue) => setThrough(nextValue)}
              required
            />
          </div>
          {factsError && (
            <p role="alert" className="text-sm text-error">
              {factsError}
            </p>
          )}
          <div data-form-change>
            <Select
              label="Personal K-1 row"
              value={business}
              onChange={setBusiness}
              helperText="Uses reviewed S corporation ordinary income."
              options={[
                { value: "", label: "Keep manual" },
                ...availableIncome("k1").map((row) => ({
                  value: row.id,
                  label: row.name || "Unnamed K-1",
                })),
              ]}
            />
          </div>
          {business && (
            <>
              <div data-form-change>
                <Select
                  label="Remaining-year forecast"
                  value={method}
                  onChange={(value) => setMethod(value as typeof method)}
                  options={[
                    { value: "manual", label: "Enter an amount" },
                    { value: "average", label: "Average closed months" },
                    { value: "prior_pattern", label: "Prior year pattern" },
                  ]}
                />
              </div>
              {method === "manual" ? (
                <TextInput
                  name="business_remaining"
                  label="Income after cutoff"
                  inputMode="decimal"
                  placeholder="0.00"
                  required
                  defaultValue={moneyDefault(
                    initial?.forecast.method === "manual"
                      ? initial.forecast.remaining_cents
                      : undefined,
                  )}
                />
              ) : (
                <>
                  <TextInput
                    name="partial_remaining"
                    label="Remaining this month"
                    description="0 at a month-end cutoff"
                    inputMode="decimal"
                    placeholder="0.00"
                    required
                    defaultValue={moneyDefault(
                      initial?.forecast.method !== "manual"
                        ? initial?.forecast.current_month_remaining_cents
                        : undefined,
                    )}
                  />
                  {method === "average" && (
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-medium">
                        Closed months to average
                      </legend>
                      {facts?.monthly.some((m) => m.complete) ? (
                        <div className="grid gap-2 sm:grid-cols-3">
                          {facts.monthly
                            .filter((m) => m.complete)
                            .map((m) => (
                              <Checkbox
                                key={m.month}
                                data-form-change
                                checked={months.includes(m.month)}
                                onChange={(checked) =>
                                  setMonths((old) =>
                                    checked
                                      ? [...old, m.month]
                                      : old.filter((v) => v !== m.month),
                                  )
                                }
                                label={monthLabel(m.month)}
                                description={
                                  <MaskedValue
                                    value={money(m.ordinary_cents)}
                                    className="tabular-nums"
                                  />
                                }
                              />
                            ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No closed months in this scope yet.
                        </p>
                      )}
                    </fieldset>
                  )}
                </>
              )}
            </>
          )}
          <details
            className="group rounded-xl border border-border"
            open={advancedOpen}
          >
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
              Advanced
            </summary>
            <div className="space-y-6 border-t border-border p-4">
              {forecasting && (
                <div className="space-y-3">
                  <Caption>Forecast exclusions</Caption>
                  {exclusions.map((exclusion, index) => (
                    <div
                      key={index}
                      className="space-y-3 border-t border-border pt-3 first:border-0 first:pt-0"
                    >
                      <AccountingEntryPicker
                        value={exclusion.entry_id}
                        onChange={(entry_id) =>
                          setExclusions((old) =>
                            old.map((row, i) =>
                              i === index ? { ...row, entry_id } : row,
                            ),
                          )
                        }
                      />
                      <TextInput
                        label="Reason"
                        value={exclusion.reason}
                        onChange={(nextValue) =>
                          setExclusions((old) =>
                            old.map((row, i) =>
                              i === index ? { ...row, reason: nextValue } : row,
                            ),
                          )
                        }
                        maxLength={500}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setExclusions((old) =>
                            old.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <X size={14} aria-hidden="true" /> Remove
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={exclusions.length >= 100}
                    onClick={() =>
                      setExclusions((old) => [
                        ...old,
                        { entry_id: "", reason: "" },
                      ])
                    }
                  >
                    <Plus size={14} aria-hidden="true" /> Exclude a one-off
                  </Button>
                </div>
              )}
              <div className="space-y-4">
                <Caption>Separately stated income</Caption>
                {Object.entries(separateConcepts).map(([key, label]) => {
                  const concept = key as keyof typeof separateConcepts,
                    current = initial?.separate_targets.find(
                      (t) => t.concept === concept,
                    );
                  const rows =
                    concept === "interest" || concept === "qualified_dividend"
                      ? availableIncome(
                          concept === "interest"
                            ? "1099"
                            : "qualified_dividend",
                        ).map((r) => ({
                          id: r.id,
                          label: r.name || "Unnamed income",
                        }))
                      : estimate.capital_gains
                          .filter(
                            (r) =>
                              r.term ===
                              (concept === "short_gain" ? "short" : "long"),
                          )
                          .map((r) => ({
                            id: r.id,
                            label: r.description || "Unnamed gain",
                          }));
                  return (
                    <div key={key} className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <TargetSelect
                          name={`target_${key}`}
                          label={label}
                          rows={rows}
                          current={current?.target_id}
                        />
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          Recorded{" "}
                          <MaskedValue
                            value={money(
                              facts?.separately_stated[concept] ?? "0",
                            )}
                            className="tabular-nums"
                          />
                        </p>
                      </div>
                      <TextInput
                        id={`tax-link-remaining-${key}`}
                        name={`remaining_${key}`}
                        label="Remaining after cutoff"
                        inputMode="decimal"
                        placeholder="0.00"
                        defaultValue={moneyDefault(current?.remaining_cents)}
                      />
                    </div>
                  );
                })}
                <Checkbox
                  data-form-change
                  checked={manualReview}
                  onChange={setManualReview}
                  className="items-start text-left"
                  label="Charitable contributions or tax-exempt income are handled on the personal return"
                />
                {manualReview && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Charity{" "}
                      <MaskedValue
                        value={money(facts?.separately_stated.charity ?? "0")}
                        className="tabular-nums"
                      />{" "}
                      · Tax-exempt{" "}
                      <MaskedValue
                        value={money(
                          facts?.separately_stated.tax_exempt ?? "0",
                        )}
                        className="tabular-nums"
                      />
                    </p>
                    <AccountingDocumentPicker
                      label="Supporting document"
                      required={false}
                      value={document}
                      onChange={setDocument}
                    />
                    <TextInput
                      name="separate_reason"
                      label="Review notes"
                      defaultValue={initial?.manual_separate_review?.reason}
                      maxLength={1000}
                    />
                  </>
                )}
              </div>
              <div className="space-y-4">
                <Toggle
                  data-form-change
                  checked={payrollEnabled}
                  onChange={setPayrollEnabled}
                  className="font-semibold"
                  label="Link payroll facts"
                />
                {payrollEnabled && (
                  <>
                    {!payroll?.coverage?.current && (
                      <p className="text-sm text-warning">
                        Verified payroll coverage is unavailable for this
                        cutoff.
                      </p>
                    )}
                    <div data-form-change>
                      <Select
                        label="Employee"
                        placeholder="Choose employee"
                        value={employeeKey}
                        onChange={setEmployeeKey}
                        options={
                          payroll?.coverage?.employees.map((e) => ({
                            value: e.key,
                            label: e.name,
                          })) ?? []
                        }
                      />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <TargetSelect
                        name="wages_target"
                        label="Personal W-2 row"
                        rows={availableIncome("w2").map((r) => ({
                          id: r.id,
                          label: r.name || "Unnamed wages",
                        }))}
                        current={initial?.payroll?.income_target_id}
                      />
                      <TextInput
                        name="payroll_state"
                        label="State"
                        maxLength={2}
                        pattern="[A-Z]{2}"
                        placeholder="AZ"
                        defaultValue={
                          initial?.payroll?.state_code ?? estimate.state ?? ""
                        }
                      />
                      <TargetSelect
                        name="federal_target"
                        label="Federal withholding row"
                        rows={estimate.payments
                          .filter(
                            (r) =>
                              r.type === "federal" && r.category !== "payment",
                          )
                          .map((r) => ({
                            id: r.id,
                            label: r.label || "Unnamed withholding",
                          }))}
                        current={initial?.payroll?.federal_payment_id}
                      />
                      <TargetSelect
                        name="state_target"
                        label="State withholding row"
                        rows={estimate.payments
                          .filter(
                            (r) =>
                              r.type === "state" && r.category !== "payment",
                          )
                          .map((r) => ({
                            id: r.id,
                            label: r.label || "Unnamed withholding",
                          }))}
                        current={initial?.payroll?.state_payment_id}
                      />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {Object.entries(payrollFactLabels).map(([key, label]) => {
                        const fact = key as keyof typeof payrollFactLabels;
                        return (
                          <div key={key}>
                            <TextInput
                              name={key}
                              label={label}
                              description="After cutoff"
                              inputMode="decimal"
                              placeholder="Blank if unknown"
                              defaultValue={moneyDefault(
                                initial?.payroll?.remaining[fact],
                              )}
                            />
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              {employee?.[fact] == null ? (
                                "Year to date unavailable"
                              ) : (
                                <>
                                  Year to date{" "}
                                  <MaskedValue
                                    value={money(employee[fact]!)}
                                    className="tabular-nums"
                                  />
                                </>
                              )}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <TextInput
                name="reason"
                label="Notes"
                placeholder="Optional"
                maxLength={1000}
              />
            </div>
          </details>
        </fieldset>
        <WorkflowActions
          busy={command.busy}
          disabled={!facts}
          error={command.error}
          label="Link"
          onClose={onClose}
        />
      </form>
    </WorkflowDialog>
  );
}
