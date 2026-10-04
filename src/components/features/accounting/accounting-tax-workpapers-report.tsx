"use client";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MaskedValue, useMaskedHover } from "@/components/ui/masked-value";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/accounting/money";
import { reportFilterSchema, type ReportFilter } from "@/lib/accounting/reports";
import { supportReportFilterSchema, type SupportReportData } from "@/lib/accounting/support-reports";
import { demoReportDetail } from "@/lib/accounting/demo-reports";
import { accountingHref } from "@/lib/accounting/views";
import type { TaxSource } from "@/lib/accounting/tax-workpapers";
import {
  TAX_NOTES,
  classificationPhrase,
  taxAdjustments,
  taxBridge,
  taxGroups,
  taxLines,
  taxReadiness,
  taxScope,
  taxSentence,
  taxSeparately,
  taxSourceOf,
  taxTotals,
  taxYears,
  type TaxCheck,
  type TaxLine,
} from "@/lib/accounting/tax-workpaper-report";
import { AccountingPageHeader } from "./accounting-page-header";
import { AccountingReportDetail } from "./accounting-report-detail";
import { todayInBooks } from "./format";
import {
  CardRow,
  ExportMenu,
  ReportSkeleton,
  SectionCard,
  StatTile,
  WaterfallList,
  type Drill,
} from "./report-kit";
import { CheckList, SupportNotes, YearControls, useSupportExport, useSupportReport } from "./support-report-kit";

const ZERO = BigInt(0);

/** Where each kind of fix happens: the workpapers editor in Manage, review, or settings. */
function fixHref(fix: TaxCheck["fix"], year: number, through: string): string | null {
  if (fix === "accounts" || fix === "adjustments")
    return accountingHref("manage", "tax", { tax_year: String(year), tax_through: through, tax_tab: fix });
  if (fix === "settings") return "/settings/business";
  return null;
}
const FIX_LABELS: Record<NonNullable<TaxCheck["fix"]>, string> = {
  accounts: "Set the treatment",
  adjustments: "Open the adjustment",
  review: "Review them",
  settings: "Open Business settings",
};

/**
 * Tax workpapers: what to hand a tax preparer, or type into a return, for
 * a calendar tax year, and what is not ready yet. The figures are the
 * books' own; the page never claims a tax result.
 */
export function AccountingTaxWorkpapersReport({
  onBack,
  onEntry,
  onReview,
  onOpenReport,
  demo = false,
}: {
  onBack: () => void;
  onEntry: (id: string) => void;
  onReview: () => void;
  onOpenReport: (id: "owner-activity") => void;
  demo?: boolean;
}) {
  const params = useSearchParams();
  const today = todayInBooks();
  const years = taxYears(today);
  const saved = (() => {
    try {
      const parsed = supportReportFilterSchema.safeParse(JSON.parse(params.get("support_filter") ?? "{}"));
      return parsed.success ? Number(parsed.data.to.slice(0, 4)) : null;
    } catch {
      return null;
    }
  })();
  const year = saved && years.includes(saved) ? saved : years[0];
  const filter = taxScope(year, today);
  const read = useSupportReport(filter, demo);
  const data = read.data;
  const exporter = useSupportExport();
  const { isHidden } = usePrivacy();
  const [drill, setDrill] = useState<{ title: string; filter: ReportFilter } | null>(null);
  const source = data ? taxSourceOf(data) : null;
  const as = source ? classificationPhrase(source) : null;

  function chooseYear(next: number) {
    setDrill(null);
    const url = new URL(window.location.href);
    url.searchParams.set("support_filter", JSON.stringify(taxScope(next, today)));
    window.history.pushState(null, "", url);
  }
  const openDetail: Drill = (title, scope) => {
    const parsed = reportFilterSchema.safeParse({ from: filter.from, to: filter.to, mode: "posted", offset: 0, ...scope });
    if (parsed.success) setDrill({ title, filter: parsed.data });
  };

  const errorMessage = exporter.error || (!data && read.error) || "";
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader
        back={{ label: "All reports", onClick: onBack }}
        title="Tax workpapers"
        subtitle="What to hand your tax preparer, and what is not ready yet."
        actions={
          <ExportMenu
            label="Export the tax workpapers"
            disabled={!data || !source || read.loading}
            exporting={exporter.exporting}
            demo={demo}
            pdfDescription="Branded workpapers for your preparer"
            csvDescription="Every account and adjustment, by treatment"
            onExport={(format) => data && void exporter.run(data, format)}
          />
        }
      />
      <YearControls
        years={years}
        year={year}
        from={filter.from}
        to={filter.to}
        scope={as ? `Reviewed activity, taxed as ${as}` : "Reviewed activity"}
        updating={read.updating}
        onYear={chooseYear}
      />
      {errorMessage && (
        <p role="alert" className="rounded-lg border border-error/30 p-4 text-sm text-error">
          {errorMessage}
        </p>
      )}
      {read.loading && !data ? (
        <ReportSkeleton label="Preparing the tax workpapers" />
      ) : data && source ? (
        <div
          aria-busy={read.updating || undefined}
          className={cn("space-y-5 transition-opacity lg:space-y-6", read.updating && "opacity-70")}
        >
          <Workpapers
            data={data}
            source={source}
            privacy={isHidden}
            onDrill={openDetail}
            onReview={onReview}
            onOwner={() => onOpenReport("owner-activity")}
            onReload={read.reload}
          />
        </div>
      ) : data ? (
        <Card className="px-6 py-10 text-center text-sm text-muted-foreground">
          The books returned no tax source for {year}. Refresh to try again.
        </Card>
      ) : null}
      {drill && data && (
        <AccountingReportDetail
          key={JSON.stringify(drill)}
          title={drill.title}
          filter={drill.filter}
          revision={data.revision}
          load={demo ? demoReportDetail : undefined}
          onClose={() => setDrill(null)}
          onEntry={(id) => {
            setDrill(null);
            onEntry(id);
          }}
          onChanged={read.reload}
        />
      )}
    </div>
  );
}

function Workpapers({
  data,
  source,
  privacy,
  onDrill,
  onReview,
  onOwner,
  onReload,
}: {
  data: SupportReportData;
  source: TaxSource;
  privacy: boolean;
  onDrill: Drill;
  onReview: () => void;
  onOwner: () => void;
  onReload: () => void;
}) {
  const year = source.year;
  const inProgress = source.through < `${year}-12-31`;
  const readiness = useMemo(() => taxReadiness(source), [source]);
  const t = taxTotals(source, readiness);
  const lines = useMemo(() => taxLines(source), [source]);
  const bridge = taxBridge(source);
  const separately = taxSeparately(source);
  if (!lines.length && !source.adjustments.length)
    return (
      <Card className="flex flex-col items-center px-6 py-14 text-center">
        <Landmark size={26} aria-hidden="true" className="mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">No reviewed activity in {year}</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          Review the year&apos;s transactions, and the workpapers fill in.
        </p>
      </Card>
    );
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatTile label="Book profit" value={formatCents(t.book)} context="Income less expenses" />
        <StatTile label="Adjustments" value={formatCents(t.difference)} context="Book to tax" />
        <StatTile label="Ordinary income" value={formatCents(t.taxable)} context="Books' figure, not tax" />
        <StatTile
          label="Not ready"
          value={String(t.notReady)}
          context={t.notReady ? "Before you hand it over" : "Ready to hand over"}
          tone={t.notReady ? "bad" : "good"}
        />
      </section>

      <CardRow wide>
        <SectionCard
          labelledBy="tw-ready"
          title={t.notReady ? "Not ready yet" : "Ready to hand over"}
          description={privacy ? "What to settle before you hand the workpapers over." : taxSentence(source, t, inProgress)}
        >
          <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6">
            <CheckList
              empty="Nothing is missing: every account has a tax treatment, every adjustment has its document, and every transaction is reviewed."
              items={readiness.map((c) => ({
                key: c.key,
                tone: c.tone,
                title: c.title,
                detail: privacy ? c.detail.replace(/\$[\d,]+\.\d\d/g, "•••••") : c.detail,
                action: c.fix ? <FixLink check={c} year={year} through={source.through} onReview={onReview} /> : undefined,
              }))}
            />
          </div>
        </SectionCard>
        <BridgeCard bridge={bridge} year={year} privacy={privacy} onDrill={onDrill} />
      </CardRow>

      <CardRow>
        <SeparatelyCard items={separately} year={year} />
        <BasisCard onOwner={onOwner} />
      </CardRow>

      <Statement source={source} lines={lines} t={t} onDrill={onDrill} />

      <SupportNotes data={data} notes={TAX_NOTES} onReload={onReload} />
    </>
  );
}

function FixLink({
  check,
  year,
  through,
  onReview,
}: {
  check: TaxCheck;
  year: number;
  through: string;
  onReview: () => void;
}) {
  const className =
    "inline-flex items-center gap-1 rounded-md text-xs font-medium text-teal-light hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
  if (check.fix === "review")
    return (
      <button type="button" onClick={onReview} className={className}>
        {FIX_LABELS.review}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    );
  const href = fixHref(check.fix, year, through);
  if (!href || !check.fix) return null;
  return (
    <a href={href} className={className}>
      {FIX_LABELS[check.fix]}
      <ArrowUpRight size={12} aria-hidden="true" />
      <span className="sr-only">, {check.title}</span>
    </a>
  );
}

/** Book profit to the books' ordinary income, line by line. */
function BridgeCard({
  bridge,
  year,
  privacy,
  onDrill,
}: {
  bridge: ReturnType<typeof taxBridge>;
  year: number;
  privacy: boolean;
  onDrill: Drill;
}) {
  const hover = useMaskedHover();
  const hide = privacy && !hover.showValue;
  return (
    <SectionCard
      labelledBy="tw-bridge"
      title="From book profit to ordinary income"
      description={
        bridge.lines.length
          ? `How ${year}'s book profit becomes the books' ordinary income figure. Select a line to see its accounts.`
          : `In ${year} the two figures are the same: no treatment or adjustment changes the profit.`
      }
    >
      <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6" {...hover.hoverProps}>
        <WaterfallList
          label="Book profit to ordinary income"
          start={{ label: "Book profit", amount: bridge.start, hint: "Reviewed income less expenses" }}
          lines={bridge.lines.map((l) => ({
            key: l.key,
            label: l.label,
            amount: l.amount,
            hint: l.hint,
            ...(l.accounts.length ? { filter: { account_ids: l.accounts } } : {}),
          }))}
          total={{ label: "Ordinary income, books' figure", amount: bridge.end }}
          onDrill={onDrill}
          hide={hide}
        />
      </div>
    </SectionCard>
  );
}

/** Items the return lists on their own, off the ordinary income line. */
function SeparatelyCard({ items, year }: { items: ReturnType<typeof taxSeparately>; year: number }) {
  const total = items.reduce((s, i) => s + i.amount, ZERO);
  return (
    <SectionCard
      labelledBy="tw-separate"
      title="Stated separately"
      description="Listed on their own for your preparer, not in the ordinary income figure."
    >
      <div className="flex flex-1 flex-col px-5 pb-4 lg:px-6">
        {items.length ? (
          <dl className="divide-y divide-border border-y border-border text-sm">
            {items.map((i) => (
              <div key={i.concept} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt>{i.label}</dt>
                <dd className="tabular-nums">
                  <MaskedValue value={formatCents(i.amount)} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing is stated separately for {year}.</p>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-4 border-t border-border px-5 py-3.5 text-sm font-semibold lg:px-6">
        <span>Stated separately</span>
        <span className="tabular-nums">
          <MaskedValue value={formatCents(total)} />
        </span>
      </div>
    </SectionCard>
  );
}

/** Shareholder basis: the books do not track it, so say what to bring instead. */
function BasisCard({ onOwner }: { onOwner: () => void }) {
  return (
    <SectionCard
      labelledBy="tw-basis"
      title="Shareholder basis"
      description="The books do not track basis, so there is no basis figure here."
    >
      <div className="flex flex-1 flex-col px-5 pb-5 lg:px-6 lg:pb-6">
        <p className="text-sm leading-relaxed">Your preparer works basis out from:</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>Last year&apos;s ending basis, from last year&apos;s return</li>
          <li>This year&apos;s income, from these workpapers</li>
          <li>What you put in and took out, from Owner activity</li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Distributions above your basis can be taxed differently; your preparer decides that.
        </p>
        <div className="mt-auto pt-4">
          <Button variant="outline" size="sm" onClick={onOwner}>
            Open Owner activity
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

/** Every account by treatment, then the adjustments: book, adjustment and tax amount. */
function Statement({
  source,
  lines,
  t,
  onDrill,
}: {
  source: TaxSource;
  lines: TaxLine[];
  t: ReturnType<typeof taxTotals>;
  onDrill: Drill;
}) {
  const groups = taxGroups(lines);
  const adjustments = taxAdjustments(source).filter((a) => a.ordinary);
  const grid =
    "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 @2xl:grid-cols-[minmax(0,1fr)_8rem_8rem_8rem]";
  const adjHref = accountingHref("manage", "tax", {
    tax_year: String(source.year),
    tax_through: source.through,
    tax_tab: "adjustments",
  });
  const row = (name: string, sub: string | null, book: bigint | null, adj: bigint, tax: bigint) => (
    <>
      <span className="min-w-0">
        <span className="block truncate" title={name}>
          {name}
        </span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
        <span className="block text-xs text-muted-foreground @2xl:hidden">
          {book !== null && (
            <>
              Book <MaskedValue value={formatCents(book)} />
              {adj !== ZERO && ", "}
            </>
          )}
          {adj !== ZERO && (
            <>
              adjusted <MaskedValue value={`${adj > ZERO ? "+" : ""}${formatCents(adj)}`} />
            </>
          )}
        </span>
      </span>
      <span className="hidden text-right tabular-nums @2xl:block">
        {book !== null && <MaskedValue value={formatCents(book)} />}
      </span>
      <span className="hidden text-right tabular-nums text-muted-foreground @2xl:block">
        {adj !== ZERO && <MaskedValue value={`${adj > ZERO ? "+" : ""}${formatCents(adj)}`} />}
      </span>
      <span className="text-right tabular-nums">
        <MaskedValue value={formatCents(tax)} />
      </span>
    </>
  );
  const buttonClass = cn(
    grid,
    "w-full items-baseline rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-[rgba(var(--ink),0.05)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
  );
  return (
    <SectionCard
      labelledBy="tw-statement"
      title="By tax treatment"
      description="Each account with reviewed activity, under its treatment. Income adds, expenses subtract. Select an account to see its transactions."
    >
      <div className="@container border-t border-border">
        <div
          aria-hidden="true"
          className={cn(
            grid,
            "hidden px-5 pt-3 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground @2xl:grid lg:px-6",
          )}
        >
          <span>Account</span>
          <span className="text-right">Book</span>
          <span className="text-right">Adjustment</span>
          <span className="text-right">Tax amount</span>
        </div>
        {groups.map((g) => (
          <div key={g.key} className="px-2.5 pb-2 lg:px-3.5">
            <p
              className={cn(
                "px-2.5 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.12em]",
                g.key === "none" ? "text-warning" : "text-teal-light",
              )}
            >
              {g.label}
            </p>
            <ul className="space-y-0.5">
              {g.lines.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => onDrill(l.name, { account_ids: [l.id] })}
                  >
                    {row(
                      l.name,
                      [l.code, l.separately ? "stated separately" : l.percent !== null && l.percent < 100 ? `${l.percent}% counted` : null]
                        .filter(Boolean)
                        .join(" · ") || null,
                      l.book,
                      l.adjustment,
                      l.tax,
                    )}
                    <span className="sr-only">, show transactions</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {adjustments.length > 0 && (
          <div className="px-2.5 pb-2 lg:px-3.5">
            <p className="px-2.5 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.12em] text-teal-light">
              Your adjustments
            </p>
            <ul className="space-y-0.5">
              {adjustments.map((a) => (
                <li key={a.id}>
                  <a href={adjHref} className={buttonClass}>
                    {row(a.reason, `${a.label}${a.supported ? "" : " · no document attached"}`, null, a.amount, a.amount)}
                    <span className="sr-only">, open the adjustment</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-border px-5 py-3.5 text-sm lg:px-6">
        <span className="text-muted-foreground">Book profit</span>
        <span className="text-right tabular-nums">
          <MaskedValue value={formatCents(t.book)} />
        </span>
        <span className="text-muted-foreground">Adjustments</span>
        <span className="text-right tabular-nums">
          <MaskedValue value={formatCents(t.difference)} />
        </span>
        <span className="font-semibold">Ordinary income, books&apos; figure</span>
        <span className="text-right font-semibold tabular-nums">
          <MaskedValue value={formatCents(t.taxable)} />
        </span>
      </div>
    </SectionCard>
  );
}
