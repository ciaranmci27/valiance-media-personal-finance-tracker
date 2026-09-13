"use client";

import * as React from "react";
import { ArrowRight, BookOpen, Download, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { NumberInput } from "@/components/ui/inputs/NumberInput";
import { RadioGroup } from "@/components/ui/inputs/RadioGroup";
import { Select } from "@/components/ui/inputs/Select";
import { Textarea } from "@/components/ui/inputs/Textarea";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Toggle } from "@/components/ui/inputs/Toggle";
import { dateLabel } from "@/components/features/accounting/format";
import { cn, formatCurrency } from "@/lib/utils";
import { FILING_STATUS_LABELS, type FilingStatus } from "@/lib/tax/constants";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import {
  createPersonalTemplateSources,
  createTemplateIncomeSources,
  isTemplateAlreadyAdded,
} from "@/lib/tax/templates";
import type {
  BooksLink,
  IncomeType,
  TaxCapitalGainEntry,
  TaxIncomeSource,
  TaxPaymentEntry,
} from "@/types/database";
import { IncomeTypePicker } from "./income-type-picker";
import { BUSINESS_TYPE_OPTIONS, TAX_CLASSIFICATION_LABELS } from "./tax-setup-card";
import type { EditTarget, EstimatorActions, EstimatorModel } from "./tax-estimator-model";

const QUARTER_OPTIONS = [
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
  { value: "final", label: "Final" },
  { value: "other", label: "Other" },
];

const FILING_STATUS_OPTIONS = (
  Object.entries(FILING_STATUS_LABELS) as [FilingStatus, string][]
).map(([value, label]) => ({ value, label }));

const STATE_SELECT_OPTIONS = [
  { value: "", label: "No state income tax" },
  ...STATE_OPTIONS,
];

export const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  qualified_dividend: "Dividends",
  retirement: "Retirement",
};

const toNumber = (value: number | "") => Number(String(value)) || 0;
const clampZero = (value: number | "") => Math.max(0, toNumber(value));
const yearComplete = (link: BooksLink) => link.through.endsWith("-12-31");

/**
 * One sheet for every row type, the household, the notes, the profile and
 * the two "add" choosers the guide opens. Fields are controlled by the
 * page's state and every change goes through `actions`, so the sheet holds
 * nothing that could go stale while it is open.
 */
export function TaxEditSheet({
  target,
  model,
  actions,
  onNavigate,
  onClose,
}: {
  target: EditTarget | null;
  model: EstimatorModel;
  actions: EstimatorActions;
  /** Move the open sheet to another target, for example a row just added. */
  onNavigate: (target: EditTarget) => void;
  onClose: () => void;
}) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const open = target !== null;

  let title = "";
  let body: React.ReactNode = null;
  let remove: { onSelect: () => void } | null = null;
  let footerNote = "Saves automatically";

  if (target?.mode === "income") {
    const row = model.incomeSources.find((r) => r.id === target.id);
    if (row) {
      title = "Edit income";
      remove = { onSelect: () => actions.income.remove(row.id) };
      body = <IncomeFields row={row} model={model} actions={actions} contentRef={contentRef} />;
    }
  } else if (target?.mode === "gain") {
    const row = model.capitalGains.find((r) => r.id === target.id);
    if (row) {
      title = "Edit capital gain";
      remove = { onSelect: () => actions.gains.remove(row.id) };
      body = <GainFields row={row} model={model} actions={actions} />;
    }
  } else if (target?.mode === "withholding" || target?.mode === "payment") {
    const row = model.payments.find((r) => r.id === target.id);
    if (row) {
      const isPayment = target.mode === "payment";
      title = isPayment ? "Edit payment" : "Edit withholding";
      remove = { onSelect: () => actions.payments.remove(row.id) };
      body = <PaymentFields row={row} isPayment={isPayment} model={model} actions={actions} />;
    }
  } else if (target?.mode === "household") {
    title = "Household";
    body = <HouseholdFields model={model} actions={actions} />;
  } else if (target?.mode === "notes") {
    title = "Notes";
    body = (
      <Textarea
        label={`Notes for ${model.year}`}
        placeholder="Anything worth remembering about this tax year"
        rows={8}
        value={model.notes}
        onChange={actions.setNotes}
      />
    );
  } else if (target?.mode === "profile") {
    title = "Your profile";
    body = <ProfileFields model={model} actions={actions} />;
  } else if (target?.mode === "add-income") {
    title = "Add income";
    footerNote = "Pick what applies. You can rename anything after.";
    body = (
      <AddIncomeChooser
        model={model}
        actions={actions}
        onNavigate={onNavigate}
        onClose={onClose}
      />
    );
  } else if (target?.mode === "add-paid") {
    title = "Tax already paid";
    footerNote = "";
    body = (
      <AddPaidChooser model={model} actions={actions} onNavigate={onNavigate} onClose={onClose} />
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md animate-slide-in-right"
      >
        <SheetHeader className="shrink-0 space-y-0 border-b border-border px-5 pb-4 pr-12 pt-5 text-left">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">Changes save automatically.</SheetDescription>
        </SheetHeader>
        <div
          ref={contentRef}
          className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]"
        >
          {body}
        </div>
        <SheetFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t border-border px-5 py-4 sm:justify-between sm:space-x-0">
          {remove ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-error hover:bg-error/10 hover:text-error"
              onClick={() => {
                remove?.onSelect();
                onClose();
              }}
            >
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            {footerNote && (
              <span className="text-xs text-muted-foreground">{footerNote}</span>
            )}
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Rows from the books share one block: the actual so far, the rest of year,
// the total, and the way out.

function BooksBlock({
  link,
  year,
  total,
  allowNegative,
  onRest,
  onUnlink,
  note,
}: {
  link: BooksLink;
  year: number;
  total: number;
  allowNegative?: boolean;
  onRest: (rest: number) => void;
  onUnlink: () => void;
  note?: string;
}) {
  const complete = yearComplete(link);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-[rgba(var(--ink),0.03)] p-4">
      <div className="flex items-start justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          So far from the books
          <span className="block text-xs">through {dateLabel(link.through)}</span>
        </span>
        <span className="font-medium tabular-nums">{formatCurrency(link.actual)}</span>
      </div>
      {link.document_id && (
        <a
          href={`/api/accounting/documents?id=${link.document_id}`}
          className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Download size={12} aria-hidden="true" />
          Provider report
        </a>
      )}
      {complete ? (
        <p className="text-xs text-muted-foreground">
          The books cover the whole year, so there is no rest of year to add.
        </p>
      ) : (
        <NumberInput
          label="Rest of year"
          description={
            allowNegative
              ? "What you expect from here to December. A loss can be negative."
              : "What you expect from here to December."
          }
          prefix="$"
          showButtons={false}
          step={0.01}
          min={allowNegative ? undefined : 0}
          placeholder="0.00"
          value={link.rest || ""}
          onChange={(value) => onRest(allowNegative ? toNumber(value) : clampZero(value))}
        />
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
        <span className="font-medium">Total for {year}</span>
        <span className="font-semibold tabular-nums">{formatCurrency(total)}</span>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div>
        <button
          type="button"
          onClick={onUnlink}
          className="rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Unlink from the books and keep the amount
        </button>
      </div>
    </div>
  );
}

function IncomeFields({
  row,
  model,
  actions,
  contentRef,
}: {
  row: TaxIncomeSource;
  model: EstimatorModel;
  actions: EstimatorActions;
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const fromBooks = !!row.books && !row.linked_source_id;
  const synced = !!row.linked_source_id && !row.is_unlinked;
  const overridden = !!row.linked_source_id && !!row.is_unlinked;

  const isProfit = row.books?.key === "business_profit";
  const showSe =
    actions.income.canHaveSeToggle(row.income_type) &&
    (!fromBooks || isProfit);
  const showParticipation = row.income_type === "k1" && !row.subject_to_se;
  const showTaxpayer = model.filingStatus === "mfj";
  const hasAdvanced = showSe || showParticipation || showTaxpayer;

  return (
    <>
      <TextInput
        label="Name"
        placeholder="Officer salary, consulting, dividends"
        value={row.name}
        onChange={(value) => actions.income.update(row.id, "name", value)}
      />
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-muted-foreground">Type</span>
        {fromBooks ? (
          <Badge variant="info">
            <BookOpen size={12} aria-hidden="true" />
            {INCOME_TYPE_LABELS[row.income_type]} from your books
          </Badge>
        ) : (
          <IncomeTypePicker
            incomeType={row.income_type}
            taxClassification={model.taxClassification}
            onChange={(type) => actions.income.setType(row.id, type)}
            portalContainer={contentRef}
          />
        )}
      </div>
      {fromBooks && row.books ? (
        <BooksBlock
          link={row.books}
          year={model.year}
          total={row.amount}
          allowNegative={isProfit}
          onRest={(rest) => actions.income.setRest(row.id, rest)}
          onUnlink={() => actions.income.unlinkBooks(row.id)}
        />
      ) : (
        <div className="space-y-1.5">
          <NumberInput
            label={`Amount for ${model.year}`}
            prefix="$"
            showButtons={false}
            step={0.01}
            placeholder="0.00"
            autoFocus={!synced && !row.amount}
            value={row.amount || ""}
            disabled={synced}
            onChange={(value) => actions.income.update(row.id, "amount", toNumber(value))}
          />
          {synced ? (
            <Hint
              text={`Synced from income tracking for ${model.year}.`}
              action={{ label: "Edit manually", onSelect: () => actions.income.unlink(row.id) }}
            />
          ) : overridden ? (
            <Hint
              text="Edited by hand. The synced amount is kept in case you want it back."
              action={{ label: "Restore synced amount", onSelect: () => actions.income.relink(row.id) }}
            />
          ) : null}
        </div>
      )}

      {hasAdvanced && (
        <Advanced>
          {showSe && (
            <Toggle
              label="Subject to self-employment tax"
              description={
                row.income_type === "k1"
                  ? "On when you actively earn this income in the business."
                  : "Off for income that is not from your own trade."
              }
              checked={row.subject_to_se}
              onChange={() => actions.income.toggleSe(row.id)}
            />
          )}
          {showParticipation && (
            <Toggle
              label="I materially participate"
              description="Excludes this income from the 3.8% net investment income tax."
              checked={!!row.materially_participates}
              onChange={() => actions.income.toggleMaterialParticipation(row.id)}
            />
          )}
          {showTaxpayer && (
            <RadioGroup
              label="Whose income"
              description="The Social Security wage base applies per person."
              orientation="horizontal"
              value={row.taxpayer ?? "self"}
              onChange={(value) => {
                if (value !== (row.taxpayer ?? "self")) actions.income.toggleTaxpayer(row.id);
              }}
              options={[
                { value: "self", label: "You" },
                { value: "spouse", label: "Spouse" },
              ]}
            />
          )}
        </Advanced>
      )}
    </>
  );
}

function GainFields({
  row,
  model,
  actions,
}: {
  row: TaxCapitalGainEntry;
  model: EstimatorModel;
  actions: EstimatorActions;
}) {
  return (
    <>
      <TextInput
        label="Description"
        placeholder="Brokerage sale, crypto, property"
        value={row.description}
        onChange={(value) => actions.gains.update(row.id, "description", value)}
      />
      {row.books ? (
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-muted-foreground">Holding period</span>
          <Badge variant="info">
            <BookOpen size={12} aria-hidden="true" />
            {row.term === "short" ? "Short-term" : "Long-term"} from your books
          </Badge>
        </div>
      ) : (
        <RadioGroup
          label="Holding period"
          orientation="horizontal"
          value={row.term}
          onChange={(value) => actions.gains.update(row.id, "term", value)}
          options={[
            { value: "short", label: "Short-term", description: "Held one year or less" },
            { value: "long", label: "Long-term", description: "Held more than a year" },
          ]}
        />
      )}
      {row.books ? (
        <BooksBlock
          link={row.books}
          year={model.year}
          total={row.amount}
          allowNegative
          onRest={(rest) => actions.gains.setRest(row.id, rest)}
          onUnlink={() => actions.gains.unlinkBooks(row.id)}
        />
      ) : (
        <NumberInput
          label="Net amount"
          description="Enter a loss as a negative amount."
          prefix="$"
          showButtons={false}
          step={0.01}
          placeholder="0.00"
          value={row.amount || ""}
          onChange={(value) => actions.gains.update(row.id, "amount", toNumber(value))}
        />
      )}
    </>
  );
}

function PaymentFields({
  row,
  isPayment,
  model,
  actions,
}: {
  row: TaxPaymentEntry;
  isPayment: boolean;
  model: EstimatorModel;
  actions: EstimatorActions;
}) {
  const stateLabel = model.state ?? "State";
  const quarterKey = row.quarter ?? "Q1";
  const dueQuarter = model.schedule.quarters.find((q) => q.status === "due");
  const suggestion =
    isPayment && dueQuarter && dueQuarter.key === quarterKey && (row.amount || 0) === 0
      ? row.type === "federal"
        ? dueQuarter.suggestedFederal
        : dueQuarter.suggestedState
      : null;
  const fromBooks = !!row.books;
  const pairedWages = row.linked_income_id
    ? model.incomeSources.find((s) => s.id === row.linked_income_id)
    : undefined;

  return (
    <>
      <TextInput
        label="Label"
        placeholder={isPayment ? "Q3 IRS payment" : "Employer withholding"}
        value={row.label}
        onChange={(value) => actions.payments.update(row.id, "label", value)}
      />
      {fromBooks ? (
        <div className="space-y-1.5">
          <span className="block text-sm font-medium text-muted-foreground">Paid to</span>
          <Badge variant="info">
            <BookOpen size={12} aria-hidden="true" />
            {row.type === "federal" ? "Federal" : stateLabel} from your books
          </Badge>
        </div>
      ) : (
        <RadioGroup
          label="Paid to"
          orientation="horizontal"
          value={row.type}
          disabled={!model.state}
          onChange={(value) => actions.payments.update(row.id, "type", value)}
          options={[
            { value: "federal", label: "Federal" },
            { value: "state", label: stateLabel },
          ]}
        />
      )}
      {isPayment && (
        <Select
          label="Quarter"
          value={quarterKey}
          onChange={(value) => actions.payments.update(row.id, "quarter", value)}
          options={QUARTER_OPTIONS}
        />
      )}
      {fromBooks && row.books ? (
        <BooksBlock
          link={row.books}
          year={model.year}
          total={row.amount}
          onRest={(rest) => actions.payments.setRest(row.id, rest)}
          onUnlink={() => actions.payments.unlinkBooks(row.id)}
          note={
            pairedWages
              ? `Paired with ${pairedWages.name || "a wages row"}.`
              : "Not tied to a wages row."
          }
        />
      ) : (
        <div className="space-y-1.5">
          <NumberInput
            label={isPayment ? "Amount paid" : "Amount withheld"}
            prefix="$"
            showButtons={false}
            step={0.01}
            placeholder="0.00"
            autoFocus={!row.amount}
            value={row.amount || ""}
            onChange={(value) => actions.payments.update(row.id, "amount", clampZero(value))}
          />
          {suggestion != null && suggestion > 0 && (
            <div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => actions.payments.update(row.id, "amount", suggestion)}
              >
                Use suggested {formatCurrency(suggestion)}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function HouseholdFields({
  model,
  actions,
}: {
  model: EstimatorModel;
  actions: EstimatorActions;
}) {
  const h = model.household;
  const set = actions.setHousehold;
  const mfj = model.filingStatus === "mfj";

  return (
    <>
      <NumberInput
        label="Children under 17"
        precision={0}
        step={1}
        min={0}
        max={20}
        placeholder="0"
        value={h.dependents || ""}
        onChange={(value) => set({ dependents: clampZero(value) })}
      />
      <NumberInput
        label="Other dependents"
        precision={0}
        step={1}
        min={0}
        max={10}
        placeholder="0"
        value={h.otherDependents || ""}
        onChange={(value) => set({ otherDependents: clampZero(value) })}
      />
      <NumberInput
        label="Additional deductions"
        description="On top of the standard deduction."
        prefix="$"
        showButtons={false}
        step={0.01}
        placeholder="0.00"
        value={h.additionalDeductions || ""}
        onChange={(value) => set({ additionalDeductions: toNumber(value) })}
      />
      <NumberInput
        label="Additional tax credits"
        prefix="$"
        showButtons={false}
        step={0.01}
        placeholder="0.00"
        value={h.additionalCredits || ""}
        onChange={(value) => set({ additionalCredits: toNumber(value) })}
      />
      {/* Age and blindness: IRC 63(f) additional standard deduction */}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-muted-foreground">
          Extra standard deduction
        </legend>
        <Checkbox
          label="I'm 65 or older"
          checked={h.taxpayerAge65}
          onChange={(value) => set({ taxpayerAge65: value })}
        />
        <Checkbox
          label="I'm blind"
          checked={h.taxpayerBlind}
          onChange={(value) => set({ taxpayerBlind: value })}
        />
        {mfj && (
          <>
            <Checkbox
              label="Spouse is 65 or older"
              checked={h.spouseAge65}
              onChange={(value) => set({ spouseAge65: value })}
            />
            <Checkbox
              label="Spouse is blind"
              checked={h.spouseBlind}
              onChange={(value) => set({ spouseBlind: value })}
            />
          </>
        )}
      </fieldset>

      {/* IRC 199A limitation. Only relevant once taxable income passes the
          threshold, so it stays hidden until then. */}
      {model.showQbiLimitInputs && (
        <Advanced open>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your income is above the{" "}
            {formatCurrency(model.taxConfig.qbi.phaseOut[model.filingStatus])} QBI threshold,
            so the business deduction now depends on these.
          </p>
          <Checkbox
            label="Service business"
            description="Consulting, health, law, accounting, finance"
            checked={h.isSstb}
            onChange={(value) => set({ isSstb: value })}
          />
          {!h.isSstb && (
            <>
              <NumberInput
                label="Business W-2 wages"
                prefix="$"
                showButtons={false}
                step={0.01}
                placeholder="0.00"
                value={h.businessW2Wages || ""}
                onChange={(value) => set({ businessW2Wages: clampZero(value) })}
              />
              <NumberInput
                label="Business property basis"
                prefix="$"
                showButtons={false}
                step={0.01}
                placeholder="0.00"
                value={h.businessPropertyBasis || ""}
                onChange={(value) => set({ businessPropertyBasis: clampZero(value) })}
              />
            </>
          )}
        </Advanced>
      )}
    </>
  );
}

function ProfileFields({
  model,
  actions,
}: {
  model: EstimatorModel;
  actions: EstimatorActions;
}) {
  const businessLabel =
    BUSINESS_TYPE_OPTIONS.find((o) => o.value === (model.businessType ?? "none"))?.label ??
    "No business";
  const classificationLabel =
    model.taxClassification && model.businessType && model.businessType !== "none"
      ? TAX_CLASSIFICATION_LABELS[model.taxClassification]
      : null;
  return (
    <>
      <Select
        label="Filing status"
        value={model.filingStatus}
        onChange={(value) => actions.setProfile({ filingStatus: value as FilingStatus })}
        options={FILING_STATUS_OPTIONS}
      />
      <Select
        label="State"
        searchable
        value={model.state ?? ""}
        onChange={(value) => actions.setProfile({ state: value || null })}
        options={STATE_SELECT_OPTIONS}
        placeholder="Choose a state"
      />
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-muted-foreground">
          Business structure
        </span>
        <p className="text-sm">
          {businessLabel}
          {classificationLabel && classificationLabel !== businessLabel && (
            <span className="text-muted-foreground">
              {" "}
              <span aria-hidden="true">&rsaquo;</span> {classificationLabel}
            </span>
          )}
        </p>
        <Hint
          text="Set once for the business. Changing it re-templates income."
          action={{ label: "Change in tax settings", href: `/settings/tax?year=${model.year}` }}
        />
      </div>
    </>
  );
}

function AddIncomeChooser({
  model,
  actions,
  onNavigate,
  onClose,
}: {
  model: EstimatorModel;
  actions: EstimatorActions;
  onNavigate: (target: EditTarget) => void;
  onClose: () => void;
}) {
  // Template ids are minted at creation, so keep one set per profile.
  const business = React.useMemo(
    () =>
      model.businessType && model.businessType !== "none"
        ? createTemplateIncomeSources(model.businessType, model.taxClassification)
        : [],
    [model.businessType, model.taxClassification],
  );
  const personal = React.useMemo(
    () => createPersonalTemplateSources(model.filingStatus),
    [model.filingStatus],
  );
  const pick = (template: TaxIncomeSource) => {
    const id = actions.income.addTemplates([template]);
    if (id) onNavigate({ mode: "income", id });
  };
  const groups: { title: string; hint: string; rows: TaxIncomeSource[] }[] = [
    {
      title: "From the business",
      hint: "What your business pays you.",
      rows: business,
    },
    {
      title: "Personal",
      hint: "Jobs, side work and investments outside the business.",
      rows: personal,
    },
  ].filter((g) => g.rows.length > 0);

  return (
    <>
      {model.books.available && (
        <ChoiceButton
          icon={<BookOpen size={16} aria-hidden="true" className="text-teal-light" />}
          title="From your books"
          hint="Profit, investments and payroll so far this year, kept current."
          onSelect={() => {
            onClose();
            actions.openBooks();
          }}
        />
      )}
      {groups.map((group) => (
        <div key={group.title} className="space-y-2">
          <div>
            <p className="text-sm font-medium">{group.title}</p>
            <p className="text-xs text-muted-foreground">{group.hint}</p>
          </div>
          <div className="space-y-1">
            {group.rows.map((template) => {
              const added = isTemplateAlreadyAdded(template, model.incomeSources);
              return (
                <button
                  key={template.id}
                  type="button"
                  disabled={added}
                  onClick={() => pick(template)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-left text-sm transition-colors",
                    added
                      ? "cursor-default opacity-60"
                      : "hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{template.name}</span>
                  <Badge size="sm">{INCOME_TYPE_LABELS[template.income_type]}</Badge>
                  {added ? (
                    <span className="text-xs text-muted-foreground">Added</span>
                  ) : (
                    <Plus size={14} aria-hidden="true" className="text-muted-foreground" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="space-y-1 border-t border-border pt-4">
        <ChoiceButton
          icon={<Download size={16} aria-hidden="true" className="text-teal-light" />}
          title="Import from income tracking"
          hint="Pull this year's totals from your income sources."
          onSelect={() => {
            onClose();
            actions.openImport();
          }}
        />
        <ChoiceButton
          icon={<Plus size={16} aria-hidden="true" className="text-teal-light" />}
          title="Something else"
          hint="Start a blank row and name it yourself."
          onSelect={() => onNavigate({ mode: "income", id: actions.income.add() })}
        />
      </div>
    </>
  );
}

function AddPaidChooser({
  model,
  actions,
  onNavigate,
  onClose,
}: {
  model: EstimatorModel;
  actions: EstimatorActions;
  onNavigate: (target: EditTarget) => void;
  onClose: () => void;
}) {
  const due = model.schedule.quarters.find((q) => q.status === "due");
  const quarter = due?.key ?? "Q1";
  const stateLabel = model.state ?? "your state";
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Anything paid so far counts against what you owe. Add each one, or say
        nothing has been paid yet.
      </p>
      <div className="space-y-2">
        {model.books.available && (
          <ChoiceButton
            bordered
            icon={<BookOpen size={16} aria-hidden="true" className="text-teal-light" />}
            title="Withholding from your books"
            hint="Federal and state tax withheld on posted payroll, kept current."
            onSelect={() => {
              onClose();
              actions.openBooks();
            }}
          />
        )}
        <ChoiceButton
          bordered
          title="Withholding from a paycheck"
          hint="Federal or state tax an employer already took out of your pay this year."
          onSelect={() =>
            onNavigate({ mode: "withholding", id: actions.payments.addWithholding() })
          }
        />
        <ChoiceButton
          bordered
          title="A quarterly estimate I sent"
          hint={`A payment you made to the IRS or ${stateLabel} for ${model.year}.`}
          onSelect={() =>
            onNavigate({
              mode: "payment",
              id: actions.payments.addPayment({
                quarter,
                label: `${quarter} federal estimate`,
              }),
            })
          }
        />
      </div>
      <div className="border-t border-border pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            actions.guide.markStep("paid", true);
            onClose();
          }}
        >
          Nothing paid yet
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function ChoiceButton({
  icon,
  title,
  hint,
  bordered,
  onSelect,
}: {
  icon?: React.ReactNode;
  title: string;
  hint: string;
  bordered?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        bordered ? "border border-border py-3" : "py-2.5",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <ArrowRight size={14} aria-hidden="true" className="text-muted-foreground" />
    </button>
  );
}

function Hint({
  text,
  action,
}: {
  text: string;
  action?: { label: string; onSelect?: () => void; href?: string };
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{text}</span>
      {action?.href ? (
        <a
          href={action.href}
          className="rounded font-medium text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </a>
      ) : action?.onSelect ? (
        <button
          type="button"
          onClick={action.onSelect}
          className="rounded font-medium text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function Advanced({ children, open }: { children: React.ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-xl border border-border" open={open}>
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
        Advanced
      </summary>
      <div className="space-y-4 border-t border-border p-4">{children}</div>
    </details>
  );
}
