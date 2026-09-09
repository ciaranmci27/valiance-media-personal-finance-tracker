"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useState } from "react";
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
import {
  InvoiceActions,
  InvoiceDialog,
  InvoiceEvidence,
} from "./accounting-dialog";
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
  const [verified, setVerified] = useState(false);
  const [facts, setFacts] = useState<TaxSource | null>(null),
    [payroll, setPayroll] = useState<PayrollYear | null>(null),
    [factsError, setFactsError] = useState("");
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
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    command.setError("");
    try {
      const fields = new FormData(event.currentTarget),
        text = (key: string) => String(fields.get(key) ?? ""),
        money = (key: string) => parseUsd(text(key)).toString();
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
        reason: text("reason"),
        verified,
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
    <InvoiceDialog
      title="Link books to your tax estimate"
      description="Select existing target rows and enter only the remaining amounts after the actuals cutoff. Unselected personal inputs stay manual."
      form
      busy={command.busy}
      onClose={onClose}
    >
      <form onSubmit={save} className="space-y-7">
        <fieldset disabled={command.busy} className="space-y-7">
          <section className="grid gap-4 sm:grid-cols-2">
            <div data-form-change>
              <Select
                label="Actuals cutoff"
                value={mode}
                onChange={(value) => setMode(value as typeof mode)}
                options={[
                  { value: "fixed", label: "Use a reviewed fixed date" },
                  { value: "today", label: "Advance actuals through today" },
                ]}
              />
            </div>
            <DateInput
              label={mode === "today" ? "Forecast reviewed through" : "Through"}
              value={effectiveThrough}
              minDate={`${estimate.tax_year}-01-01`}
              maxDate={maxDate}
              readOnly={mode === "today"}
              onChange={(nextValue) => setThrough(nextValue)}
              required
            />
            {mode === "today" && (
              <p className="text-xs text-muted-foreground sm:col-span-2">
                As new days advance the actuals, review the remaining forecast
                again. An outdated forecast is flagged before payment planning.
              </p>
            )}
          </section>
          {factsError && (
            <p role="alert" className="text-sm text-error">
              {factsError}
            </p>
          )}
          <section className="space-y-4 border-t border-border pt-5">
            <div>
              <h3 className="font-semibold">Ordinary business income</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Uses reviewed S corporation ordinary income. Losses also require
                current supported basis and allowable-loss review.
              </p>
            </div>
            <div data-form-change>
              <Select
                label="Personal K-1 row"
                value={business}
                onChange={setBusiness}
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
                      {
                        value: "manual",
                        label: "Enter a remaining-year amount",
                      },
                      {
                        value: "average",
                        label: "Average selected closed months",
                      },
                      {
                        value: "prior_pattern",
                        label: "Use the prior year monthly pattern",
                      },
                    ]}
                  />
                </div>
                {method === "manual" ? (
                  <TextInput
                    name="business_remaining"
                    label="Income expected after the cutoff"
                    inputMode="decimal"
                    placeholder="Enter 0 if no more income is expected"
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
                      label="Remaining income in the current partial month"
                      inputMode="decimal"
                      placeholder="0 at a month-end cutoff"
                      required
                      defaultValue={moneyDefault(
                        initial?.forecast.method !== "manual"
                          ? initial?.forecast.current_month_remaining_cents
                          : undefined,
                      )}
                    />
                    {method === "average" && (
                      <div>
                        <p className="mb-2 text-sm">Closed months to average</p>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {facts?.monthly
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
                                className="w-full justify-start glass-card rounded-xl p-3 text-left"
                                label={
                                  <span>
                                    {monthLabel(m.month)}
                                    <MaskedValue
                                      value={money(m.ordinary_cents)}
                                      className="block font-mono text-xs tabular-nums"
                                    />
                                  </span>
                                }
                              />
                            ))}
                        </div>
                        {!facts?.monthly.some((m) => m.complete) && (
                          <p className="text-xs text-muted-foreground">
                            No complete closed months are available in this
                            scope. Enter a manual forecast or finish the close
                            reviews first.
                          </p>
                        )}
                      </div>
                    )}
                    {method === "prior_pattern" && (
                      <p className="text-xs text-muted-foreground">
                        Uses the same remaining full months from the previous
                        year, without automatic growth. Each selected prior
                        month must be closed and its tax treatment reviewed.
                      </p>
                    )}
                    <details className="glass-card rounded-xl p-4">
                      <summary className="cursor-pointer text-sm">
                        Exclude one-off transactions from the forecast base
                      </summary>
                      <p className="mt-2 text-xs text-muted-foreground">
                        The recorded actuals remain intact. Only transactions
                        from selected base months are eligible.
                      </p>
                      <div className="mt-3 space-y-4">
                        {exclusions.map((exclusion, index) => (
                          <div
                            key={index}
                            className="space-y-2 glass-card rounded-xl p-3"
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
                              label="Reason for exclusion"
                              value={exclusion.reason}
                              onChange={(nextValue) =>
                                setExclusions((old) =>
                                  old.map((row, i) =>
                                    i === index
                                      ? { ...row, reason: nextValue }
                                      : row,
                                  ),
                                )
                              }
                              required
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
                              exclusion
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
                          <Plus size={14} aria-hidden="true" /> Add one-off
                          exclusion
                        </Button>
                      </div>
                    </details>
                  </>
                )}
              </>
            )}
          </section>
          <details
            className="space-y-4 border-t border-border pt-5"
            open={
              !!initial?.separate_targets.length ||
              !!initial?.manual_separate_review ||
              Object.values(source.separately_stated).some((v) => v !== "0")
            }
          >
            <summary className="cursor-pointer font-semibold">
              Separately stated income
            </summary>
            <div>
              <p className="mt-1 text-xs text-muted-foreground">
                Interest, qualified dividends and capital gains do not belong in
                ordinary K-1 income. Select a target for any recorded amount.
              </p>
            </div>
            {Object.entries(separateConcepts).map(([key, label]) => {
              const concept = key as keyof typeof separateConcepts,
                current = initial?.separate_targets.find(
                  (t) => t.concept === concept,
                );
              const rows =
                concept === "interest" || concept === "qualified_dividend"
                  ? availableIncome(
                      concept === "interest" ? "1099" : "qualified_dividend",
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
                <div
                  key={key}
                  className="grid gap-3 glass-card rounded-xl p-4 sm:grid-cols-2"
                >
                  <div>
                    <TargetSelect
                      name={`target_${key}`}
                      label={label}
                      rows={rows}
                      current={current?.target_id}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Recorded:{" "}
                      <MaskedValue
                        value={money(facts?.separately_stated[concept] ?? "0")}
                        className="font-mono tabular-nums"
                      />
                    </p>
                  </div>
                  <TextInput
                    id={`tax-link-remaining-${key}`}
                    name={`remaining_${key}`}
                    label="Remaining after cutoff"
                    inputMode="decimal"
                    placeholder="Required only when linked"
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
              label="Record external treatment of charitable contributions or tax-exempt income"
            />
            {manualReview && (
              <div className="space-y-3 glass-card rounded-xl p-4">
                <p className="text-xs text-muted-foreground">
                  Charitable contribution:{" "}
                  <MaskedValue
                    value={money(facts?.separately_stated.charity ?? "0")}
                    className="font-mono tabular-nums"
                  />
                  . Tax-exempt income:{" "}
                  <MaskedValue
                    value={money(facts?.separately_stated.tax_exempt ?? "0")}
                    className="font-mono tabular-nums"
                  />
                  . This confirmation adds no personal deduction automatically.
                </p>
                <InvoiceEvidence
                  value={document}
                  onChange={setDocument}
                  required
                />
                <TextInput
                  name="separate_reason"
                  label="How the personal return and basis were reviewed"
                  defaultValue={initial?.manual_separate_review?.reason}
                  required
                  maxLength={1000}
                />
              </div>
            )}
          </details>
          <section className="space-y-4 border-t border-border pt-5">
            <Toggle
              data-form-change
              checked={payrollEnabled}
              onChange={setPayrollEnabled}
              className="font-semibold"
              label="Link verified payroll facts"
            />
            <p className="text-xs text-muted-foreground">
              Patriot remains the payroll and filing provider. Use verified
              employee wage and withholding amounts, never company payroll bank
              withdrawals.
            </p>
            {payrollEnabled && (
              <>
                {!payroll?.coverage?.current && (
                  <p className="rounded-lg bg-warning/10 p-3 text-sm">
                    Verified payroll coverage is unavailable for this cutoff.
                    Complete the provider coverage review in Payroll first.
                  </p>
                )}
                <div data-form-change>
                  <Select
                    label="Employee in the verified provider report"
                    required
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
                <div className="grid gap-3 sm:grid-cols-2">
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
                    label="State for provider wage figures"
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
                        (r) => r.type === "federal" && r.category !== "payment",
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
                        (r) => r.type === "state" && r.category !== "payment",
                      )
                      .map((r) => ({
                        id: r.id,
                        label: r.label || "Unnamed withholding",
                      }))}
                    current={initial?.payroll?.state_payment_id}
                  />
                </div>
                <div className="glass-card rounded-xl">
                  <div className="grid grid-cols-2 gap-3 border-b border-border bg-secondary/20 px-4 py-3 text-xs font-medium">
                    <span>Verified year to date</span>
                    <span>Expected after cutoff</span>
                  </div>
                  {Object.entries(payrollFactLabels).map(([key, label]) => (
                    <div
                      key={key}
                      className="grid grid-cols-2 items-center gap-3 border-b border-border p-4 last:border-0"
                    >
                      <div>
                        <p className="text-xs text-muted-foreground">{label}</p>
                        {employee?.[key as keyof typeof payrollFactLabels] ==
                        null ? (
                          <p className="mt-1 text-sm">Unavailable</p>
                        ) : (
                          <MaskedValue
                            value={money(
                              employee[key as keyof typeof payrollFactLabels]!,
                            )}
                            className="mt-1 block font-mono text-sm tabular-nums"
                          />
                        )}
                      </div>
                      <TextInput
                        name={key}
                        aria-label={`Remaining ${label.toLowerCase()}`}
                        inputMode="decimal"
                        placeholder="Blank if unknown"
                        defaultValue={moneyDefault(
                          initial?.payroll?.remaining[
                            key as keyof typeof payrollFactLabels
                          ],
                        )}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter 0 only when no further amount is expected. Unknown
                  values stay blank and keep the affected estimator row manual.
                </p>
              </>
            )}
          </section>
          <TextInput
            name="reason"
            label="Review notes"
            placeholder="Basis for these targets and remaining-year assumptions"
            required
            maxLength={1000}
          />
          <Checkbox
            data-form-change
            checked={verified}
            onChange={setVerified}
            className="items-start text-left"
            label="I reviewed the selected personal targets, actuals cutoff and remaining-year assumptions."
          />
        </fieldset>
        <InvoiceActions
          busy={command.busy}
          disabled={!facts}
          error={command.error}
          label="Save link & refresh estimate"
          onClose={onClose}
        />
      </form>
    </InvoiceDialog>
  );
}
