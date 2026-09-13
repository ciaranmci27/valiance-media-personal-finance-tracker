"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { useMaskedHover } from "@/components/ui/masked-value";
import { cn, formatCurrency } from "@/lib/utils";
import type { BracketLine, FullTaxBreakdown } from "@/lib/tax/calculations";

const MASK = "$•••••";
// Compare against a cent rather than exact zero: netRemaining is a chain of
// bracket-walked sums, so an exact 0 is not something to rely on.
const CENT = 0.005;

type Tone = "error" | "success" | "muted";

/**
 * The right-hand column: one receipt from gross income down to what is still
 * owed. Every intermediate line can open for its detail, so the resting state
 * is eleven lines that add up.
 */
export function TaxReceipt({
  year,
  breakdown,
}: {
  year: number;
  breakdown: FullTaxBreakdown;
}) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const masked = isHidden && !isRevealed;
  const fmt = (v: number) => formatCurrency(v);
  const fmtMasked = (v: number) => (masked ? MASK : formatCurrency(v));
  const neg = (v: number) => (masked ? MASK : `-${formatCurrency(v)}`);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  const b = breakdown;
  const gains = b.capitalGains;
  const se = b.selfEmploymentTax;
  const fica = b.ficaTax;
  const stateDetail = b.stateTaxDetail;

  const hasCapitalGains = gains.grossShortTerm !== 0 || gains.grossLongTerm !== 0;
  const showPayroll = se.total > 0 || fica.total > 0;
  const showState = stateDetail.stateName != null || b.stateTax > 0;
  const showStateSplit = b.stateLiability > 0 || b.totalStatePaid > 0;
  const federalSubtotal = b.federalTaxAfterCredits + b.niit;
  const payrollSubtotal = se.total + fica.total;

  const isPaidInFull = Math.abs(b.netRemaining) < CENT;
  const isOverpaid = !isPaidInFull && b.netRemaining < 0;
  // A negative balance can come from over-withholding or from a refundable
  // credit. Naming the driver avoids "refund" appearing when nothing was
  // actually overpaid.
  const refundDrivenByCredit = isOverpaid && b.additionalChildTaxCredit > 0;
  const finalTone: Tone = isOverpaid || isPaidInFull ? "success" : "error";
  const finalLabel = isPaidInFull
    ? "Paid in full"
    : isOverpaid
      ? "Projected refund"
      : "Still owed";

  const stateLabel = stateDetail.stateName
    ? `${stateDetail.stateName} income tax`
    : "State income tax";
  const stateNote =
    stateDetail.rate != null
      ? `${(stateDetail.rate * 100).toFixed(1)}% flat`
      : "progressive";

  return (
    <Card glass className="animate-fade-up stagger-2">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 px-5 pb-1 pt-4">
        <CardTitle className="text-base">How we got here</CardTitle>
        <span className="text-xs text-muted-foreground">
          Select a line for detail
        </span>
      </CardHeader>
      <CardContent className="px-5 pb-4 pt-1 text-sm" {...hoverProps}>
        <Disclosure label="Gross income" value={fmtMasked(b.grossIncome)}>
          {b.w2Income > 0 && (
            <Sub label="W-2 wages" value={fmtMasked(b.w2Income)} />
          )}
          {b.otherIncome > 0 && (
            <Sub label="1099 and other" value={fmtMasked(b.otherIncome)} />
          )}
          {b.seIncome > 0 && (
            <Sub label="Self-employment" value={fmtMasked(b.seIncome)} />
          )}
          {b.passiveIncome > 0 && (
            <Sub label="K-1 income" value={fmtMasked(b.passiveIncome)} />
          )}
          {hasCapitalGains && (
            <>
              <Sub
                label="Net short-term gains"
                value={fmtMasked(gains.netShortTerm)}
                tone={gains.netShortTerm < 0 ? "error" : undefined}
              />
              <Sub
                label="Net long-term gains"
                value={fmtMasked(gains.netLongTerm)}
                tone={gains.netLongTerm < 0 ? "error" : undefined}
              />
            </>
          )}
        </Disclosure>

        {gains.lossDeduction > 0 && (
          <Line
            label="Capital loss deduction"
            value={neg(gains.lossDeduction)}
            tone="error"
          />
        )}
        {b.seDeduction > 0 && (
          <Line
            label="Self-employment tax deduction"
            value={neg(b.seDeduction)}
          />
        )}
        <Line label="Adjusted gross income" value={fmtMasked(b.agi)} />

        <Disclosure label="Deductions" value={neg(b.totalDeductions)}>
          <Sub
            label="Standard deduction"
            value={fmtMasked(b.standardDeduction)}
          />
          {b.qbiDeduction > 0 && (
            <Sub
              label="Qualified business income (20%)"
              value={fmtMasked(b.qbiDeduction)}
            />
          )}
          {b.additionalDeductions > 0 && (
            <Sub
              label="Additional deductions"
              value={fmtMasked(b.additionalDeductions)}
            />
          )}
        </Disclosure>
        <Total label="Taxable income" value={fmtMasked(b.taxableIncome)} />

        <Disclosure
          label="Federal income tax"
          value={fmtMasked(federalSubtotal)}
        >
          <CollapsibleBracketTable
            title={`Ordinary income tax (${year} brackets)`}
            brackets={b.federalTax.bracketBreakdown}
            total={b.federalTax.total}
            fmtMasked={fmtMasked}
            fmt={fmt}
            pct={pct}
          />
          {b.ltcgTax.bracketBreakdown.length > 0 && (
            <CollapsibleBracketTable
              title="Long-term capital gains tax"
              brackets={b.ltcgTax.bracketBreakdown}
              total={b.ltcgTax.total}
              fmtMasked={fmtMasked}
              fmt={fmt}
              pct={pct}
            />
          )}
          {b.childTaxCredit > 0 && (
            <Sub
              label="Child tax credit"
              value={neg(b.childTaxCredit)}
              tone="success"
            />
          )}
          {b.otherDependentCredit > 0 && (
            <Sub
              label="Other dependent credit"
              value={neg(b.otherDependentCredit)}
              tone="success"
            />
          )}
          {b.additionalCredits > 0 && (
            <Sub
              label="Additional credits"
              value={neg(b.additionalCredits)}
              tone="success"
            />
          )}
          {b.totalCredits > 0 && (
            <Sub
              label="After credits"
              value={fmtMasked(b.federalTaxAfterCredits)}
              bold
            />
          )}
          {b.niit > 0 && (
            <Sub
              label="Net investment income tax (3.8%)"
              value={fmtMasked(b.niit)}
            />
          )}
        </Disclosure>

        {showPayroll && (
          <Disclosure label="Payroll tax" value={fmtMasked(payrollSubtotal)}>
            {se.total > 0 && (
              <Group title="Self-employment tax">
                <Sub label="Social Security (12.4%)" value={fmtMasked(se.ssTax)} />
                <Sub label="Medicare (2.9%)" value={fmtMasked(se.medicareTax)} />
                {se.additionalMedicare > 0 && (
                  <Sub
                    label="Additional Medicare (0.9%)"
                    value={fmtMasked(se.additionalMedicare)}
                  />
                )}
                <Sub label="Total self-employment tax" value={fmtMasked(se.total)} bold />
              </Group>
            )}
            {fica.total > 0 && (
              <Group title="W-2 FICA">
                <Sub label="Social Security (6.2%)" value={fmtMasked(fica.ssTax)} />
                <Sub label="Medicare (1.45%)" value={fmtMasked(fica.medicareTax)} />
                {fica.additionalMedicare > 0 && (
                  <Sub
                    label="Additional Medicare (0.9%)"
                    value={fmtMasked(fica.additionalMedicare)}
                  />
                )}
                <Sub label="Total FICA" value={fmtMasked(fica.total)} bold />
              </Group>
            )}
          </Disclosure>
        )}

        {showState &&
          (stateDetail.stateName ? (
            <Disclosure
              label={stateLabel}
              note={stateNote}
              value={fmtMasked(b.stateTax)}
            >
              {stateDetail.stateStandardDeduction > 0 && (
                <Sub
                  label="State deduction"
                  value={fmtMasked(stateDetail.stateStandardDeduction)}
                />
              )}
              {(stateDetail.rate === null || stateDetail.rate > 0) && (
                <Sub
                  label="State taxable income"
                  value={fmtMasked(stateDetail.stateTaxableIncome)}
                />
              )}
            </Disclosure>
          ) : (
            <Line label="No state selected" value={fmtMasked(0)} tone="muted" />
          ))}
        <Total label="Total tax" value={fmtMasked(b.totalLiability)} />

        <Disclosure label="Paid and credited" value={neg(b.totalPaid)}>
          <Sub
            label="Federal payments and withholding"
            value={fmtMasked(b.totalFederalPaid)}
          />
          {b.ficaAutoCredited > 0 && (
            <Sub
              indent
              label={
                <Tooltip content="This annual projection assumes the employer withholds the calculated employee Social Security and Medicare. It is a calculation credit, not proof of amounts already paid.">
                  <span className="flex cursor-help items-center gap-1.5">
                    Assumed annual FICA credit
                    <span className="rounded bg-primary/10 px-1 py-px text-[9px] uppercase tracking-wider text-teal-light">
                      Auto
                    </span>
                  </span>
                </Tooltip>
              }
              value={fmtMasked(b.ficaAutoCredited)}
            />
          )}
          {b.excessSocialSecurityWithheld > 0 && (
            <Sub
              indent
              label={
                <Tooltip content="Each employer withholds Social Security up to the wage base on its own payroll. With more than one job that over-withholds, and the excess comes back as a refundable credit on Schedule 3.">
                  <span className="cursor-help">Excess Social Security</span>
                </Tooltip>
              }
              value={fmtMasked(b.excessSocialSecurityWithheld)}
            />
          )}
          {b.additionalChildTaxCredit > 0 && (
            <Sub
              indent
              label={
                <Tooltip content="The child credit you could not use against income tax comes back as a refund, up to $1,700 per child and limited to 15% of earnings over $2,500.">
                  <span className="cursor-help">Refundable child credit</span>
                </Tooltip>
              }
              value={fmtMasked(b.additionalChildTaxCredit)}
            />
          )}
          {showStateSplit && (
            <Sub
              label="State payments and withholding"
              value={fmtMasked(b.totalStatePaid)}
            />
          )}
          <RemainingLine
            label="Federal"
            amount={b.federalRemaining}
            display={fmtMasked(b.federalRemaining)}
          />
          {showStateSplit && (
            <RemainingLine
              label="State"
              amount={b.stateRemaining}
              display={fmtMasked(b.stateRemaining)}
            />
          )}
        </Disclosure>

        <div className="flex items-center justify-between gap-3 pt-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn(
                "h-4 w-[3px] rounded-full",
                finalTone === "error" ? "bg-error" : "bg-success",
              )}
            />
            <span className="font-semibold">{finalLabel}</span>
          </div>
          <CopyableValue
            value={fmtMasked(Math.abs(b.netRemaining))}
            rawValue={b.netRemaining}
            className={cn(
              "text-lg font-bold",
              finalTone === "error" ? "text-error" : "text-success",
            )}
          />
        </div>
        {isOverpaid && (
          <p className="mt-1 text-xs text-muted-foreground">
            {fmtMasked(Math.abs(b.netRemaining))} back
            {refundDrivenByCredit
              ? `, including ${fmtMasked(b.additionalChildTaxCredit)} of refundable child credit`
              : ""}
            .
          </p>
        )}
        {isPaidInFull && (
          <p className="mt-1 text-xs text-muted-foreground">
            Payments and credits cover the projected liability.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Receipt lines

const toneClass: Record<Tone, string> = {
  error: "text-error",
  success: "text-success",
  muted: "text-muted-foreground",
};

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
      <span className={cn(tone && toneClass[tone])}>{label}</span>
      <span className={cn("tabular-nums", tone && toneClass[tone])}>{value}</span>
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="-mx-2 flex items-center justify-between gap-3 rounded-md bg-[rgba(var(--ink),0.035)] px-2 py-2 font-semibold">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function Disclosure({
  label,
  note,
  value,
  children,
}: {
  label: string;
  note?: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group border-b border-border/60">
      <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-3 rounded-md py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{label}</span>
          {note && (
            <span className="shrink-0 text-xs text-muted-foreground">{note}</span>
          )}
          <ChevronDown
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
          />
        </span>
        <span className="shrink-0 tabular-nums">{value}</span>
      </summary>
      <div className="space-y-1 pb-2.5 pl-4 pt-0.5 text-[13px] text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

function Sub({
  label,
  value,
  tone,
  bold,
  indent,
}: {
  label: React.ReactNode;
  value: string;
  tone?: Tone;
  bold?: boolean;
  indent?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        indent && "pl-3 text-xs",
        bold && "font-medium text-foreground",
      )}
    >
      <span className={cn(tone && toneClass[tone])}>{label}</span>
      <span className={cn("tabular-nums", tone && toneClass[tone])}>{value}</span>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 pt-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {title}
      </span>
      {children}
    </div>
  );
}

function RemainingLine({
  label,
  amount,
  display,
}: {
  label: string;
  amount: number;
  display: string;
}) {
  const settled = Math.abs(amount) < CENT;
  const tone: Tone = amount > CENT ? "error" : "success";
  const text = settled
    ? `${label} paid in full`
    : amount < 0
      ? `${label} refund`
      : `${label} remaining`;
  return (
    <div className="flex items-center justify-between gap-3 pt-1 font-medium text-foreground">
      <span className={toneClass[tone]}>{text}</span>
      <CopyableValue
        value={display}
        rawValue={amount}
        className={cn("font-semibold", toneClass[tone])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail widgets

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
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5">
          {title}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-3 w-3 text-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </span>
        <span className="tabular-nums">{fmtMasked(total)}</span>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="overflow-x-auto pb-2 pt-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-1 py-1 text-left font-medium">Rate</th>
                  <th className="px-1 py-1 text-right font-medium">Bracket</th>
                  <th className="px-1 py-1 text-right font-medium">Taxable</th>
                  <th className="px-1 py-1 text-right font-medium">Tax</th>
                </tr>
              </thead>
              <tbody>
                {brackets.map((line, i) => (
                  <tr key={i} className="border-t border-border/30">
                    <td className="px-1 py-1 tabular-nums">{pct(line.rate)}</td>
                    <td className="px-1 py-1 text-right tabular-nums text-muted-foreground">
                      {line.rangeEnd === Infinity
                        ? `${fmt(line.rangeStart)}+`
                        : `${fmt(line.rangeStart)} - ${fmt(line.rangeEnd)}`}
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums">
                      {fmtMasked(line.taxableInBracket)}
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums font-medium">
                      {fmtMasked(line.tax)}
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
    // Preserve the sign: a refund copied as a positive number reads as an
    // amount owed. Round to cents so the clipboard does not carry float noise.
    void navigator.clipboard.writeText(
      (Math.round(rawValue * 100) / 100).toFixed(2),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "-mx-1 cursor-pointer rounded px-1 tabular-nums transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95",
        className,
      )}
      title="Click to copy"
    >
      {copied ? "Copied!" : value}
    </button>
  );
}
