"use client";

import * as React from "react";
import { BookOpen, Check, ChevronRight, Clock, Link2, Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberInput } from "@/components/ui/inputs/NumberInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { SectionHeader } from "@/components/ui/section-header";
import { dateShortLabel } from "@/components/features/accounting/format";
import { cn, formatCurrency } from "@/lib/utils";
import type { QuarterSchedule } from "@/lib/tax/payment-schedule";
import { FigureLabel, figureTips } from "./tax-hero";
import {
  createPersonalTemplateSources,
  createTemplateIncomeSources,
  isTemplateAlreadyAdded,
} from "@/lib/tax/templates";
import type { IncomeType, TaxIncomeSource } from "@/types/database";
import { AddIncomePopover } from "./add-income-popover";
import type { EditTarget, EstimatorActions, EstimatorModel } from "./tax-estimator-model";

const CENT = 0.005;

const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  qualified_dividend: "Dividends",
  retirement: "Retirement",
};

/** DOM id of a row's inline amount field, so a quick-add can focus it. */
export const amountFieldId = (rowId: string) => `tax-amount-${rowId}`;

/**
 * Everything the owner told us, as rows they can type into. Manual amounts
 * edit in place; the chevron opens the sheet for type, jurisdiction, SE and
 * the rest. Rows from the books show their total and refresh from the card
 * header.
 */
export function TaxInputsCard({
  model,
  actions,
  onEdit,
}: {
  model: EstimatorModel;
  actions: EstimatorActions;
  onEdit: (target: EditTarget) => void;
}) {
  const { schedule, books } = model;
  const stateCode = model.state ?? "State";
  const figureTipText = figureTips(model.annualized, null);
  const dueQuarter = schedule.quarters.find((q) => q.status === "due") ?? null;

  // A quick-add drops the new row's amount field into focus so the owner can
  // type straight away. The row only exists after the next render.
  const [focusId, setFocusId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(amountFieldId(focusId));
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
      setFocusId(null);
    }
  }, [focusId, model.incomeSources, model.payments]);

  const grossIncome = model.incomeSources.reduce((sum, row) => sum + row.amount, 0);
  const withholdingRows = model.payments.filter((row) => row.category !== "payment");
  const hasBooksRows =
    model.incomeSources.some((r) => !!r.books) ||
    model.capitalGains.some((r) => !!r.books) ||
    model.payments.some((r) => !!r.books);

  // Quick-add chips: the templates for this profile that are not in yet.
  const quickAdd = React.useMemo(() => {
    const business =
      model.businessType && model.businessType !== "none"
        ? createTemplateIncomeSources(model.businessType, model.taxClassification)
        : [];
    return [...business, ...createPersonalTemplateSources(model.filingStatus)].filter(
      (t) => !isTemplateAlreadyAdded(t, model.incomeSources),
    );
  }, [model.businessType, model.taxClassification, model.filingStatus, model.incomeSources]);

  const addTemplate = (template: TaxIncomeSource) => {
    const id = actions.income.addTemplates([template]);
    if (id) setFocusId(id);
  };
  const addWithholding = () => setFocusId(actions.payments.addWithholding());
  const addPayment = (quarter: QuarterSchedule["key"] | "final" | "other") =>
    setFocusId(
      actions.payments.addPayment({
        quarter,
        label: quarter === "final" ? "Payment with return" : `${quarter} federal estimate`,
      }),
    );

  const booksLine = hasBooksRows && books.available ? renderBooksStatus(books) : null;

  return (
    <Card glass className="animate-fade-up stagger-1">
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 pb-1 pt-4">
        <CardTitle className="text-base">Your numbers</CardTitle>
        {hasBooksRows && books.available ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen size={13} aria-hidden="true" className="text-teal-light" />
            {books.through ? `Books through ${dateShortLabel(books.through)}` : "Books"}
            <button
              type="button"
              onClick={actions.refreshBooks}
              disabled={books.status === "loading"}
              aria-busy={books.status === "loading"}
              className="inline-flex items-center gap-1 rounded font-medium text-teal-light hover:underline disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RefreshCw
                size={12}
                aria-hidden="true"
                className={cn(books.status === "loading" && "animate-spin")}
              />
              Refresh
            </button>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Type an amount, or open a row for details
          </span>
        )}
      </CardHeader>
      {booksLine && (
        <p
          role="status"
          className={cn(
            "px-5 pb-1 text-xs",
            books.status === "error" ? "text-warning" : "text-muted-foreground",
          )}
        >
          {booksLine}
        </p>
      )}
      <CardContent className="px-5 pb-0 pt-1">
        <Section
          label="Income"
          description="What you earned this year, before tax."
          action={
            <AddIncomePopover
              taxClassification={model.taxClassification}
              businessType={model.businessType}
              filingStatus={model.filingStatus}
              onAddTemplates={actions.income.addTemplates}
              onAddCustom={() => onEdit({ mode: "income", id: actions.income.add() })}
              onOpenImport={actions.openImport}
              onOpenBooks={books.available ? actions.openBooks : undefined}
              existingSources={model.incomeSources}
            />
          }
        >
          {model.incomeSources.map((row) => {
            const fromBooks = !!row.books;
            const synced = !!row.linked_source_id && !row.is_unlinked;
            const overridden = !!row.linked_source_id && !!row.is_unlinked;
            const chips: React.ReactNode[] = [
              <Badge key="type" size="sm">{INCOME_TYPE_LABELS[row.income_type]}</Badge>,
            ];
            if (row.subject_to_se && actions.income.canHaveSeToggle(row.income_type)) {
              chips.push(<Badge key="se" size="sm" variant="info">SE</Badge>);
            }
            if (row.income_type === "k1" && !row.subject_to_se && row.materially_participates) {
              chips.push(<Badge key="active" size="sm" variant="info">Active</Badge>);
            }
            if (model.filingStatus === "mfj" && row.taxpayer === "spouse") {
              chips.push(<Badge key="spouse" size="sm">Spouse</Badge>);
            }
            if (overridden) {
              chips.push(<Badge key="unlinked" size="sm" variant="copper">Unlinked</Badge>);
            }
            return (
              <EntryRow
                key={row.id}
                id={row.id}
                name={row.name}
                placeholder="Untitled income"
                chips={chips}
                source={
                  fromBooks
                    ? { label: "Books", linked: true }
                    : synced
                      ? { label: "Synced", linked: true }
                      : { label: "Manual" }
                }
                amount={row.amount}
                onAmount={
                  fromBooks || synced
                    ? undefined
                    : (value) => actions.income.update(row.id, "amount", value)
                }
                onOpen={() => onEdit({ mode: "income", id: row.id })}
              />
            );
          })}
          {quickAdd.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1 pt-1.5">
              <span className="mr-1 text-xs text-muted-foreground">
                {model.incomeSources.length === 0 ? "Start with" : "Quick add"}
              </span>
              {quickAdd.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => addTemplate(template)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-[rgba(var(--ink),0.25)] px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-teal hover:bg-teal/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus size={12} aria-hidden="true" />
                  {template.name}
                </button>
              ))}
              {books.available && !hasBooksRows && (
                <button
                  type="button"
                  onClick={actions.openBooks}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-[rgba(var(--ink),0.25)] px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-teal hover:bg-teal/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <BookOpen size={12} aria-hidden="true" />
                  From your books
                </button>
              )}
            </div>
          )}
          {model.incomeSources.length > 0 && (
            <Subtotal label="Gross income" amount={grossIncome} />
          )}
        </Section>

        <Section
          label="Capital gains and losses"
          description="Sales of stock, crypto or property. Losses count too."
          action={
            <AddButton onClick={() => onEdit({ mode: "gain", id: actions.gains.add() })} />
          }
        >
          {model.capitalGains.length === 0 && (
            <Empty>None this year. Add one if you sold something.</Empty>
          )}
          {model.capitalGains.map((row) => (
            <EntryRow
              key={row.id}
              id={row.id}
              name={row.description}
              placeholder="No description"
              chips={[
                <Badge key="term" size="sm">
                  {row.term === "short" ? "Short-term" : "Long-term"}
                </Badge>,
              ]}
              source={row.books ? { label: "Books", linked: true } : { label: "Manual" }}
              amount={row.amount}
              allowNegative
              onAmount={
                row.books ? undefined : (value) => actions.gains.update(row.id, "amount", value)
              }
              onOpen={() => onEdit({ mode: "gain", id: row.id })}
            />
          ))}
        </Section>

        <Section
          label="Withholding"
          description="Tax an employer already took out of paychecks this year."
          action={<AddButton onClick={addWithholding} />}
        >
          {withholdingRows.length === 0 && (
            <EmptyAction onClick={addWithholding}>Add paycheck withholding</EmptyAction>
          )}
          {withholdingRows.map((row) => (
            <EntryRow
              key={row.id}
              id={row.id}
              name={row.label}
              placeholder="Untitled withholding"
              chips={[
                <Badge key="type" size="sm">{row.type === "federal" ? "Federal" : stateCode}</Badge>,
              ]}
              source={row.books ? { label: "Books", linked: true } : { label: "Manual" }}
              amount={row.amount}
              onAmount={
                row.books
                  ? undefined
                  : (value) => actions.payments.update(row.id, "amount", Math.max(0, value))
              }
              onOpen={() => onEdit({ mode: "withholding", id: row.id })}
            />
          ))}
        </Section>

        <Section
          id="estimated-payments"
          label="Estimated payments"
          description={`Quarterly payments you sent the IRS${model.state ? ` or ${stateCode}` : ""}. Dates are the federal deadlines.`}
          action={
            <AddButton label="Add payment" onClick={() => addPayment(dueQuarter?.key ?? "Q1")} />
          }
        >
          <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
            {schedule.quarters.map((quarter) => (
              <QuarterTile
                key={quarter.key}
                quarter={quarter}
                stateCode={stateCode}
                showState={!!model.state}
                annualized={
                  model.annualized?.kind === "ready" && model.annualized.quarter === quarter.key
                    ? {
                        minimum: { federal: model.annualized.federal, state: model.annualized.state },
                        total: model.annualized.full,
                      }
                    : null
                }
                tips={figureTipText}
                onAmount={(id, value) => actions.payments.update(id, "amount", Math.max(0, value))}
                onOpenRow={(id) => onEdit({ mode: "payment", id })}
                onAdd={() => addPayment(quarter.key)}
              />
            ))}
          </div>
          {schedule.other.rows.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {schedule.other.rows.map((row) => (
                <EntryRow
                  key={row.id}
                  id={row.id}
                  name={row.label}
                  placeholder="Untitled payment"
                  chips={[
                    <Badge key="type" size="sm">{row.type === "federal" ? "Federal" : stateCode}</Badge>,
                    <Badge key="when" size="sm">{row.quarter === "final" ? "Final" : "Other"}</Badge>,
                  ]}
                  source={{ label: "Manual" }}
                  amount={row.amount}
                  onAmount={(value) => actions.payments.update(row.id, "amount", Math.max(0, value))}
                  onOpen={() => onEdit({ mode: "payment", id: row.id })}
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          label="Household"
          description="Dependents, extra deductions or credits, and age."
          action={
            <Button size="sm" variant="ghost" onClick={() => onEdit({ mode: "household" })}>
              Edit
            </Button>
          }
        >
          <p className="px-2 pb-1 text-sm text-muted-foreground">
            {householdSummary(model)}
          </p>
        </Section>
      </CardContent>
      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm">
        <span className={cn("min-w-0 truncate", !model.notes && "text-muted-foreground")}>
          {model.notes ? model.notes : `No notes for ${model.year}`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => onEdit({ mode: "notes" })}>
          {model.notes ? "Edit note" : "Add a note"}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function renderBooksStatus(books: EstimatorModel["books"]): string | null {
  if (books.status === "error") return `Couldn't refresh from the books. ${books.error}`.trim();
  const parts: string[] = [];
  for (const move of books.moved) {
    parts.push(`${move.name} moved ${formatCurrency(move.from)} to ${formatCurrency(move.to)}`);
  }
  parts.push(...books.problems);
  return parts.length > 0 ? parts.join(". ") + "." : null;
}

function householdSummary(model: EstimatorModel): string {
  const h = model.household;
  const parts: string[] = [];
  if (h.dependents > 0) {
    parts.push(`${h.dependents} ${h.dependents === 1 ? "child" : "children"} under 17`);
  }
  if (h.otherDependents > 0) {
    parts.push(`${h.otherDependents} other ${h.otherDependents === 1 ? "dependent" : "dependents"}`);
  }
  if (parts.length === 0) parts.push("No dependents");
  parts.push(
    h.additionalDeductions > 0
      ? `${formatCurrency(h.additionalDeductions)} extra deductions`
      : "standard deduction",
  );
  if (h.additionalCredits > 0) parts.push(`${formatCurrency(h.additionalCredits)} extra credits`);
  const flags: string[] = [];
  if (h.taxpayerAge65) flags.push("65 or older");
  if (h.taxpayerBlind) flags.push("blind");
  if (model.filingStatus === "mfj") {
    if (h.spouseAge65) flags.push("spouse 65 or older");
    if (h.spouseBlind) flags.push("spouse blind");
  }
  parts.push(flags.length > 0 ? flags.join(", ") : "under 65");
  if (model.showQbiLimitInputs) {
    parts.push(h.isSstb ? "service business" : "QBI limits apply");
  }
  return parts.join(" · ");
}

function Section({
  id,
  label,
  description,
  action,
  children,
}: {
  id?: string;
  label: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="border-t border-border/60 py-3 first:border-t-0 first:pt-1"
    >
      <SectionHeader label={label} description={description} action={action} className="mb-1 px-2" />
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-2 text-sm text-muted-foreground">{children}</p>;
}

function EmptyAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-2 my-1 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[rgba(var(--ink),0.25)] px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-teal hover:bg-teal/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Plus size={14} aria-hidden="true" />
      {children}
    </button>
  );
}

function AddButton({ onClick, label = "Add" }: { onClick: () => void; label?: string }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      <Plus size={14} aria-hidden="true" />
      {label}
    </Button>
  );
}

function Subtotal({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 px-2 pt-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">
        <MaskedValue value={formatCurrency(amount)} />
      </span>
    </div>
  );
}

function AmountField({
  id,
  label,
  amount,
  allowNegative,
  onChange,
  className,
}: {
  id: string;
  label: string;
  amount: number;
  allowNegative?: boolean;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <NumberInput
      id={amountFieldId(id)}
      aria-label={`${label} amount`}
      size="sm"
      prefix="$"
      showButtons={false}
      step={0.01}
      min={allowNegative ? undefined : 0}
      placeholder="0.00"
      value={amount || ""}
      onChange={(value) => onChange(Number(String(value)) || 0)}
      className={cn("w-32", className)}
      inputClassName="text-right tabular-nums"
    />
  );
}

function EntryRow({
  id,
  name,
  placeholder,
  chips,
  source,
  amount,
  allowNegative,
  onAmount,
  onOpen,
}: {
  id: string;
  name: string;
  placeholder: string;
  chips: React.ReactNode[];
  source: { label: string; linked?: boolean };
  amount: number;
  allowNegative?: boolean;
  /** Present for manual rows: the amount edits in place. */
  onAmount?: (value: number) => void;
  onOpen?: () => void;
}) {
  const label = name || placeholder;
  const nameBlock = (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <span
        className={cn(
          "truncate text-sm font-medium",
          !name && "font-normal text-muted-foreground",
        )}
      >
        {label}
      </span>
      {chips}
    </span>
  );
  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[rgba(var(--ink),0.035)]">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {nameBlock}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center">{nameBlock}</div>
      )}
      <span
        className={cn(
          "hidden shrink-0 items-center gap-1 text-xs sm:inline-flex",
          source.linked ? "text-teal-light" : "text-muted-foreground",
        )}
      >
        {source.linked && <Link2 size={12} aria-hidden="true" />}
        {source.label}
      </span>
      {onAmount ? (
        <AmountField
          id={id}
          label={label}
          amount={amount}
          allowNegative={allowNegative}
          onChange={onAmount}
        />
      ) : (
        <span
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            amount < 0 && "text-error",
          )}
        >
          <MaskedValue value={formatCurrency(amount)} />
        </span>
      )}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${label}`}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-[rgba(var(--ink),0.06)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ) : (
        <span className="w-6 shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}

function QuarterTile({
  quarter,
  stateCode,
  showState,
  annualized,
  tips,
  onAmount,
  onOpenRow,
  onAdd,
}: {
  quarter: QuarterSchedule;
  stateCode: string;
  showState: boolean;
  /** The annualized instalments, on the due tile only. */
  annualized: {
    minimum: { federal: number; state: number };
    total: { federal: number; state: number };
  } | null;
  tips: { actual: string; minimum: string | null; total: string | null };
  onAmount: (id: string, value: number) => void;
  onOpenRow: (id: string) => void;
  onAdd: () => void;
}) {
  const due = quarter.status === "due";
  const status = statusFor(quarter);
  const suggested =
    quarter.status === "due"
      ? { federal: quarter.suggestedFederal ?? 0, state: quarter.suggestedState ?? 0 }
      : null;

  return (
    <div
      className={cn(
        "flex min-w-[210px] shrink-0 snap-start flex-col gap-2 rounded-xl border border-border bg-[rgba(var(--ink),0.03)] p-3 lg:min-w-0",
        due && "border-warning/50 bg-warning/[0.06]",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{quarter.key}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {dateShortLabel(quarter.deadline)}
        </span>
      </div>
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", status.className)}>
        {status.icon}
        <span suppressHydrationWarning>{status.label}</span>
      </span>
      <div className="space-y-1">
        {quarter.rows.map((row) => {
          const jurisdiction = row.type === "federal" ? "Fed" : stateCode;
          return (
            <div key={row.id} className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpenRow(row.id)}
                aria-label={`Open ${row.label || jurisdiction} payment`}
                className="inline-flex items-center gap-1.5 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {jurisdiction}
              </button>
              <AmountField
                id={row.id}
                label={row.label || `${quarter.key} ${jurisdiction}`}
                amount={row.amount}
                onChange={(value) => onAmount(row.id, value)}
                className="w-28"
              />
            </div>
          );
        })}
        {due &&
          [
            { label: "Actual", value: suggested, tip: tips.actual },
            { label: "Minimum", value: annualized?.minimum ?? null, tip: tips.minimum ?? undefined },
            {
              label: "Total",
              // Hidden when it equals Actual, as it does in Q4 where nothing is scaled.
              value:
                annualized && suggested &&
                (Math.abs(annualized.total.federal - suggested.federal) > CENT ||
                  Math.abs(annualized.total.state - suggested.state) > CENT)
                  ? annualized.total
                  : null,
              tip: tips.total ?? undefined,
            },
          ]
            .filter((line) => line.value && (line.value.federal > CENT || line.value.state > CENT))
            .map((line) => (
              <div key={line.label} className="px-1 pt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                <FigureLabel label={line.label} tip={line.tip} />{" "}
                <span className="tabular-nums text-foreground">
                  <MaskedValue value={formatCurrency(line.value!.federal)} />
                </span>{" "}
                federal
                {showState && line.value!.state > CENT && (
                  <>
                    {", "}
                    <span className="tabular-nums text-foreground">
                      <MaskedValue value={formatCurrency(line.value!.state)} />
                    </span>{" "}
                    {stateCode}
                  </>
                )}
              </div>
            ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="mt-auto inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-xs font-medium text-teal-light hover:bg-[rgba(var(--ink),0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus size={12} aria-hidden="true" />
        {quarter.rows.length > 0 ? "Add another" : "Add payment"}
      </button>
    </div>
  );
}

function statusFor(quarter: QuarterSchedule): {
  label: string;
  className: string;
  icon: React.ReactNode;
} {
  switch (quarter.status) {
    case "paid":
      return {
        label: "Paid",
        className: "text-success",
        icon: <Check size={12} aria-hidden="true" />,
      };
    case "due":
      return {
        label: "Due next",
        className: "text-warning",
        icon: <Clock size={12} aria-hidden="true" />,
      };
    case "past":
      return { label: "No payment", className: "text-muted-foreground", icon: null };
    default:
      return { label: "Upcoming", className: "text-muted-foreground", icon: null };
  }
}
