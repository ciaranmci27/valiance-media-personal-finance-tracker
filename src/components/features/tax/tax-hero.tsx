"use client";

import * as React from "react";
import { Clock, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { useMaskedHover } from "@/components/ui/masked-value";
import { dateLabel, dateShortLabel } from "@/components/features/accounting/format";
import { cn, formatCurrency } from "@/lib/utils";
import type { FullTaxBreakdown } from "@/lib/tax/calculations";
import type { MeterSegments, PaymentSchedule } from "@/lib/tax/payment-schedule";
import type { AnnualizedState } from "./tax-estimator-model";

const MASK = "$•••••";
const CENT = 0.005;

/**
 * The one number the page leads with, the meter that shows how much of the
 * year's tax is covered, and the next payment to make.
 */
export function TaxHero({
  year,
  breakdown,
  schedule,
  meter,
  annualized,
  onRecordPayment,
}: {
  year: number;
  breakdown: FullTaxBreakdown;
  schedule: PaymentSchedule;
  meter: MeterSegments;
  annualized: AnnualizedState | null;
  onRecordPayment: () => void;
}) {
  const { isHidden, isRevealed, hoverProps } = useMaskedHover();
  const masked = isHidden && !isRevealed;
  const fmtMasked = (v: number) => (masked ? MASK : formatCurrency(v));

  const net = breakdown.netRemaining;
  const paidInFull = Math.abs(net) < CENT;
  const refund = !paidInFull && net < 0;
  const eyebrow = paidInFull
    ? `Paid in full for ${year}`
    : refund
      ? `Projected refund for ${year}`
      : `Still owed for ${year}`;
  const [dollars, cents] = formatCurrency(Math.abs(net)).split(".");

  const stateName = breakdown.stateTaxDetail.stateName ?? "State";
  const showState = breakdown.stateLiability > 0 || breakdown.totalStatePaid > 0;

  const paid = meter.withheld + meter.estimated + meter.projected;
  const coverage =
    meter.total > 0 ? Math.min(100, Math.round((paid / meter.total) * 100)) : 100;
  const share = (v: number) => (meter.total > 0 ? (v / meter.total) * 100 : 0);
  const segments = [
    { key: "withheld", label: "Withheld", value: meter.withheld, className: "bg-teal-dark" },
    { key: "estimated", label: "Estimated payments", value: meter.estimated, className: "bg-teal" },
    { key: "projected", label: "Projected credits", value: meter.projected, className: "meter-hatch" },
    { key: "remaining", label: "Remaining", value: meter.remaining, className: "bg-[rgba(var(--ink),0.06)]" },
  ].filter((s) => s.value > CENT);
  const meterLabel = masked
    ? "Payment progress, amounts hidden"
    : segments.map((s) => `${s.label} ${formatCurrency(s.value)}`).join(", ");

  const next = schedule.next;
  const ready = annualized?.kind === "ready" ? annualized : null;
  const nothingDue =
    !!next &&
    next.suggestedFederal < CENT &&
    next.suggestedState < CENT &&
    (!ready || (ready.federal < CENT && ready.state < CENT));
  // The labels explain themselves; only a return deadline or a failed books
  // read needs a sentence under the table.
  const note = !next
    ? ""
    : next.kind === "return"
      ? "What is left, due with your return."
      : annualized?.kind === "unavailable"
        ? annualized.reason
        : "";
  const tips = figureTips(annualized, fmtMasked);
  // In Q4 the scaling factor is 1, so Total is Actual by definition; one row says it.
  const totalDiffers =
    !!ready &&
    !!next &&
    (Math.abs(ready.full.federal - next.suggestedFederal) > CENT ||
      Math.abs(ready.full.state - next.suggestedState) > CENT);

  return (
    <Card glass className="animate-fade-up">
      <CardContent className="p-5 lg:p-6" {...hoverProps}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {eyebrow}
            </p>
            <p className="mt-2 text-4xl font-semibold leading-none tracking-tight lg:text-[56px]">
              {masked ? (
                MASK
              ) : (
                <>
                  {dollars}
                  {cents && (
                    <span className="text-[0.5em] font-medium text-muted-foreground">
                      .{cents}
                    </span>
                  )}
                </>
              )}
            </p>
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <SplitAmount name="Federal" amount={breakdown.federalRemaining} display={fmtMasked(Math.abs(breakdown.federalRemaining))} />
              {showState && (
                <SplitAmount name={stateName} amount={breakdown.stateRemaining} display={fmtMasked(Math.abs(breakdown.stateRemaining))} />
              )}
            </p>

            <div className="mt-6 space-y-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {breakdown.totalLiability > CENT ? (
                  <span>
                    <span className="font-semibold text-foreground">{coverage}%</span> of{" "}
                    {fmtMasked(breakdown.totalLiability)} total tax covered
                  </span>
                ) : (
                  <span>No tax projected for {year}</span>
                )}
                <span className="tabular-nums">{fmtMasked(breakdown.totalPaid)} paid or credited</span>
              </div>
              <div
                role="img"
                aria-label={meterLabel}
                className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full"
              >
                {segments.map((s) => (
                  <div
                    key={s.key}
                    className={cn("h-full", s.className)}
                    style={{ width: `${share(s.value)}%` }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {segments.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.className)}
                    />
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="font-medium tabular-nums">{fmtMasked(s.value)}</span>
                    {s.key === "projected" && (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        assumed
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <section
            aria-label="Next payment"
            className="flex w-full flex-col gap-3 rounded-xl border border-border bg-[rgba(var(--ink),0.03)] p-4 lg:w-[340px]"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">
                {next ? (
                  <>
                    {next.kind === "quarter" ? `${next.quarter} estimate` : `${year} return`}
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      <span aria-hidden="true">·</span>{" "}
                      {next.kind === "quarter" ? dateShortLabel(next.deadline) : dateLabel(next.deadline)}
                    </span>
                  </>
                ) : (
                  "Next payment"
                )}
              </p>
              {next && <DueBadge daysUntil={next.daysUntil} />}
            </div>
            {next ? (
              <>
                {nothingDue ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing due. Payments and credits already cover {year}.
                  </p>
                ) : (
                  <>
                    <NextTable
                      stateName={showState ? stateName : null}
                      rows={[
                        {
                          label: next.kind === "return" ? "What is left" : "Actual",
                          tip: next.kind === "return" ? undefined : tips.actual,
                          federal: fmtMasked(next.suggestedFederal),
                          state: fmtMasked(next.suggestedState),
                        },
                        ...(ready && next.kind === "quarter"
                          ? [
                              {
                                label: "Minimum",
                                tip: tips.minimum ?? undefined,
                                federal: fmtMasked(ready.federal),
                                state: fmtMasked(ready.state),
                              },
                              ...(totalDiffers
                                ? [
                                    {
                                      label: "Total",
                                      tip: tips.total ?? undefined,
                                      federal: fmtMasked(ready.full.federal),
                                      state: fmtMasked(ready.full.state),
                                    },
                                  ]
                                : []),
                            ]
                          : []),
                      ]}
                    />
                    {note && <p className="text-[11px] leading-relaxed text-muted-foreground">{note}</p>}
                  </>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No payments scheduled. Every {year} deadline has passed.
              </p>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={onRecordPayment}>
                <Plus size={14} aria-hidden="true" />
                Record payment
              </Button>
            </div>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

function SplitAmount({
  name,
  amount,
  display,
}: {
  name: string;
  amount: number;
  display: string;
}) {
  if (Math.abs(amount) < CENT) {
    return (
      <span>
        {name} <span className="font-medium text-success">paid in full</span>
      </span>
    );
  }
  return (
    <span>
      {name}
      {amount < 0 ? " refund " : " "}
      <span className="font-medium tabular-nums text-foreground">{display}</span>
    </span>
  );
}

/**
 * What each figure means, for its label's tooltip. Same shape for all three:
 * what it is, then what it means for the owner. `fmt` adds the one number
 * worth knowing; without it the amounts are left out.
 */
export function figureTips(
  annualized: AnnualizedState | null,
  fmt: ((amount: number) => string) | null,
): { actual: string; minimum: string | null; total: string | null } {
  let actual =
    "The tax you owe right now on what you have actually earned. Pay this and you are square on real income.";
  if (annualized?.kind !== "ready") return { actual, minimum: null, total: null };
  if (fmt && annualized.shortfall)
    actual += ` It is under the IRS minimum, which costs about ${fmt(annualized.shortfall.cost)} in interest.`;
  const minimum =
    "The least you can pay now without owing the IRS interest. Assumes your pace so far continues and keeps the rest of your cash.";
  const total =
    "The full payment for your pace so far, as the IRS calculates it. Pay this and you are ahead; anything over the minimum comes back in April.";
  return { actual, minimum, total };
}

/** A label that opens its definition on hover or focus. */
export function FigureLabel({ label, tip }: { label: string; tip?: string }) {
  if (!tip) return <>{label}</>;
  return (
    <Tooltip content={tip} wide>
      <button
        type="button"
        className="cursor-help rounded underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
      </button>
    </Tooltip>
  );
}

/** The figures to choose between, one row each, jurisdictions across. */
function NextTable({
  rows,
  stateName,
}: {
  rows: { label: string; tip?: string; federal: string; state: string }[];
  stateName: string | null;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <th scope="col" className="sr-only">
            Figure
          </th>
          <th scope="col" className="pb-1 text-right font-medium">
            Federal
          </th>
          {stateName && (
            <th scope="col" className="pb-1 pl-4 text-right font-medium">
              {stateName}
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row" className="py-0.5 pr-3 text-left text-[11px] font-medium text-muted-foreground">
              <FigureLabel label={row.label} tip={row.tip} />
            </th>
            <td className="py-0.5 text-right font-semibold tabular-nums">{row.federal}</td>
            {stateName && (
              <td className="py-0.5 pl-4 text-right font-semibold tabular-nums">{row.state}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DueBadge({ daysUntil }: { daysUntil: number }) {
  const soon = daysUntil <= 14;
  const text =
    daysUntil === 0
      ? "Due today"
      : daysUntil === 1
        ? "Due tomorrow"
        : `Due in ${daysUntil} days`;
  return (
    <Badge variant={soon ? "warning" : "default"} size="sm">
      <Clock size={11} aria-hidden="true" />
      <span suppressHydrationWarning>{text}</span>
    </Badge>
  );
}
