"use client";

import * as React from "react";
import {
  ArrowDownLeft,
  Building2,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Landmark,
  PiggyBank,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { IncomeChart } from "@/components/charts/income-chart";
import { formatCurrency, toMonthlyAmount, cn } from "@/lib/utils";
import { MaskedValue } from "@/components/ui/masked-value";
import { PageHeader } from "@/components/layout/page-header";
import { SetupGuide } from "@/components/features/accounting/setup-guide";
import {
  BooksRecent,
  CashFlowCard,
  Panel,
  RangeToggle,
  cents,
  useDashboardBooks,
} from "@/components/features/dashboard/books-panel";
import { useAccess } from "@/contexts/access-context";
import { isDemoMode } from "@/lib/demo";
import type {
  IncomeEntry,
  IncomeSource,
  IncomeAmount,
  Expense,
  ExpenseHistory,
  NetWorth,
} from "@/types/database";

type ChartRange = "6mo" | "12mo" | "all";

/**
 * One row of stat cards that scrolls sideways when the permissions grant more
 * cards than fit. No scrollbar; arrows on desktop, a swipe on phones.
 */
function StatStrip({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  React.useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [update, children]);

  // One card at a time, so the half card at the edge becomes the next full one.
  const scroll = (direction: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const step = card ? card.offsetWidth + 16 : el.clientWidth * 0.5;
    el.scrollBy({ left: direction * step, behavior: "smooth" });
  };

  const scrollable = canLeft || canRight;
  // Soft edges where more cards wait, instead of a hard cut through a card.
  const fade = 40;
  const mask = !scrollable
    ? undefined
    : canLeft && canRight
      ? `linear-gradient(to right, transparent, black ${fade}px, black calc(100% - ${fade}px), transparent)`
      : canRight
        ? `linear-gradient(to right, black calc(100% - ${fade}px), transparent)`
        : `linear-gradient(to right, transparent, black ${fade}px)`;

  // Small solid discs sitting on the faded edge, in line with the cards.
  const arrowClass =
    "absolute top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 place-items-center rounded-full border border-border bg-card text-foreground shadow-md transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:grid";

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={update}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden px-1 py-1 lg:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {canLeft && (
        <button
          type="button"
          aria-label="Show earlier stats"
          onClick={() => scroll(-1)}
          className={cn(arrowClass, "left-2")}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>
      )}
      {canRight && (
        <button
          type="button"
          aria-label="Show more stats"
          onClick={() => scroll(1)}
          className={cn(arrowClass, "right-2")}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  );
}

/**
 * Each stat takes an even share of the row. From desktop width the row shows
 * five and a half cards at most, so the cut card says there is more to the
 * right; fewer cards grow to fill the row.
 */
function Stat({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 grow shrink-0 basis-[240px] snap-start lg:basis-[calc((100%-5rem)/5.5)] [&>*]:h-full [&>*]:w-full">
      {children}
    </div>
  );
}

interface DashboardContentProps {
  incomeEntries: IncomeEntry[];
  incomeSources: IncomeSource[];
  incomeAmounts: (IncomeAmount & {
    income_entries: { month: string; deleted_at: string | null };
  })[];
  expenses: Expense[];
  expenseHistory: ExpenseHistory[];
  netWorthEntries: NetWorth[];
  /** The books answered for this session (server probe); false hides every books figure. */
  booksAvailable?: boolean;
}

export function DashboardContent({
  incomeEntries,
  incomeSources,
  incomeAmounts,
  expenses,
  expenseHistory,
  netWorthEntries,
  booksAvailable = false,
}: DashboardContentProps) {
  const { member, hasPermission } = useAccess();
  const canIncome = hasPermission("income.read");
  const canExpenses = hasPermission("expenses.read");
  const canNetWorth = hasPermission("net_worth.read") && member.show_net_worth;
  const canBooks = hasPermission("accounting.manage");
  const demo = isDemoMode();
  const showBooks = canBooks && (booksAvailable || demo);
  const books = useDashboardBooks({ demo, enabled: showBooks });
  const haveBooks = showBooks && !books.unavailable;

  // --- Income tracking -----------------------------------------------------
  const availableMonths = React.useMemo(
    () => incomeEntries.map((e) => e.month),
    [incomeEntries],
  );
  const selectedMonth = availableMonths[0] || "";
  const previousMonth = availableMonths[1];
  const [incomeChartRange, setIncomeChartRange] =
    React.useState<ChartRange>("6mo");

  const monthTotal = React.useCallback(
    (month: string) =>
      incomeAmounts
        .filter((a) => a.income_entries?.month === month)
        .reduce((sum, a) => sum + Number(a.amount), 0),
    [incomeAmounts],
  );
  const trackedIncome = selectedMonth ? monthTotal(selectedMonth) : 0;
  const previousTrackedIncome = previousMonth ? monthTotal(previousMonth) : 0;

  const incomeChartData = React.useMemo(() => {
    const limit =
      incomeChartRange === "6mo"
        ? 6
        : incomeChartRange === "12mo"
          ? 12
          : incomeEntries.length;
    return incomeEntries
      .slice(0, limit)
      .reverse()
      .map((entry) => {
        const monthAmounts = incomeAmounts.filter(
          (a) => a.income_entries?.month === entry.month,
        );
        const total = monthAmounts.reduce(
          (sum, a) => sum + Number(a.amount),
          0,
        );
        const bySource: Record<string, number> = {};
        incomeSources.forEach((source) => {
          const amount = monthAmounts.find((a) => a.source_id === source.id);
          bySource[source.slug] = Number(amount?.amount ?? 0);
        });
        return { month: entry.month, total, ...bySource };
      });
  }, [incomeEntries, incomeAmounts, incomeSources, incomeChartRange]);

  // --- Fixed expenses -------------------------------------------------------
  // Monthly cost of the expenses of one type, as they stood on a given date.
  // History rows record the values a change replaced, so the first change
  // after the date tells us what the expense was on that date.
  const expensesAt = React.useCallback(
    (type: Expense["expense_type"] | "all", asOfDate?: Date) =>
      expenses
        .filter((e) => type === "all" || e.expense_type === type)
        .reduce((sum, expense) => {
          let amount = Number(expense.amount);
          let frequency = expense.frequency;
          if (asOfDate) {
            const later = expenseHistory
              .filter(
                (h) =>
                  h.expense_id === expense.id &&
                  new Date(h.changed_at) > asOfDate,
              )
              .sort(
                (a, b) =>
                  new Date(a.changed_at).getTime() -
                  new Date(b.changed_at).getTime(),
              )[0];
            if (later) {
              amount = Number(later.amount);
              frequency = later.frequency as typeof expense.frequency;
            }
          }
          return sum + toMonthlyAmount(amount, frequency);
        }, 0),
    [expenses, expenseHistory],
  );
  const previousMonthStart = React.useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() - 1, 1);
  }, []);
  const personalExpenses = expensesAt("personal");
  const previousPersonalExpenses = expensesAt("personal", previousMonthStart);
  const businessExpenses = expensesAt("business");
  const totalMonthlyExpenses = expensesAt("all");

  // --- Net worth ------------------------------------------------------------
  const currentNetWorth = Number(netWorthEntries[0]?.amount ?? 0);
  const previousNetWorth = Number(netWorthEntries[1]?.amount ?? 0);

  // --- Books figures ----------------------------------------------------------
  const booksIncome = books.current
    ? cents(books.current.income_cents)
    : cents(books.workspace?.reports.income_cents);
  const booksExpenses = Math.abs(
    books.current
      ? cents(books.current.expense_cents)
      : cents(books.workspace?.reports.expense_cents),
  );
  const booksNet = books.current
    ? cents(books.current.net_cents)
    : cents(books.workspace?.reports.net_income_cents);
  const previousBooksIncome = books.previous
    ? cents(books.previous.income_cents)
    : undefined;
  const previousBooksExpenses = books.previous
    ? Math.abs(cents(books.previous.expense_cents))
    : undefined;
  const previousBooksNet = books.previous
    ? cents(books.previous.net_cents)
    : undefined;

  // --- Stat cards, in the order the owner reads them ---------------------------
  const stats: React.ReactNode[] = [];
  if (haveBooks || canIncome)
    stats.push(
      <Stat key="income">
        <StatCard
          title="Income this month"
          value={haveBooks ? booksIncome : trackedIncome}
          previousValue={
            haveBooks ? previousBooksIncome : previousTrackedIncome
          }
          icon={<TrendingUp className="h-5 w-5" />}
          subtitle={haveBooks ? "From the books" : "From income tracking"}
        />
      </Stat>,
    );
  if (haveBooks)
    stats.push(
      <Stat key="business-expenses">
        <StatCard
          title="Business expenses"
          value={booksExpenses}
          previousValue={previousBooksExpenses}
          invertTrend
          icon={<Building2 className="h-5 w-5" />}
          subtitle="This month, from the books"
        />
      </Stat>,
      <Stat key="net-profit">
        <StatCard
          title="Net profit"
          value={booksNet}
          previousValue={previousBooksNet}
          icon={<ArrowDownLeft className="h-5 w-5" />}
          subtitle="This month, from the books"
        />
      </Stat>,
    );
  if (canExpenses)
    stats.push(
      <Stat key="personal-expenses">
        <StatCard
          title="Personal expenses"
          value={personalExpenses}
          previousValue={previousPersonalExpenses}
          invertTrend
          icon={<Wallet className="h-5 w-5" />}
          subtitle="Fixed expenses per month"
        />
      </Stat>,
    );
  if (haveBooks && canExpenses)
    stats.push(
      <Stat key="net-position">
        <StatCard
          title="Net position"
          value={booksNet - personalExpenses}
          previousValue={
            previousBooksNet === undefined
              ? undefined
              : previousBooksNet - previousPersonalExpenses
          }
          icon={<DollarSign className="h-5 w-5" />}
          subtitle="Net profit less personal expenses"
        />
      </Stat>,
    );
  if (haveBooks)
    stats.push(
      <Stat key="cash">
        <StatCard
          title="Cash in bank"
          value={books.cash === null ? 0 : Number(books.cash) / 100}
          icon={<Landmark className="h-5 w-5" />}
          subtitle={books.cashLabel}
        />
      </Stat>,
    );
  if (canNetWorth)
    stats.push(
      <Stat key="net-worth">
        <StatCard
          title="Net worth"
          value={currentNetWorth}
          previousValue={previousNetWorth}
          icon={<PiggyBank className="h-5 w-5" />}
        />
      </Stat>,
    );

  const middleCount = (haveBooks ? 1 : 0) + (canIncome ? 1 : 0);
  const bottomCount = (haveBooks ? 1 : 0) + (canExpenses ? 1 : 0);

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = member.name.split(" ")[0];

  return (
    <div className="space-y-5 lg:space-y-6">
      <PageHeader
        title={`${greeting}, ${firstName}`}
        subtitle="Here's where things stand today."
      />

      {canBooks && <SetupGuide year={new Date().getFullYear()} />}

      {stats.length > 0 && <StatStrip>{stats}</StatStrip>}

      {middleCount > 0 && (
        <div
          className={cn(
            "grid gap-4 sm:gap-6",
            middleCount === 2 && "lg:grid-cols-2",
          )}
        >
          {haveBooks && <CashFlowCard books={books} />}
          {canIncome && (
            <Panel
              title="Income trend"
              right={
                <RangeToggle
                  value={incomeChartRange}
                  onChange={setIncomeChartRange}
                  options={[
                    { value: "6mo", label: "6mo" },
                    { value: "12mo", label: "12mo" },
                    { value: "all", label: "All" },
                  ]}
                />
              }
            >
              {(isRevealed) => (
                <IncomeChart
                  data={incomeChartData}
                  sources={incomeSources}
                  isRevealed={isRevealed}
                />
              )}
            </Panel>
          )}
        </div>
      )}

      {bottomCount > 0 && (
        <div
          className={cn(
            "grid gap-4 sm:gap-6",
            bottomCount === 2 && "lg:grid-cols-2",
          )}
        >
          {haveBooks && <BooksRecent books={books} />}
          {canExpenses && (
            <Panel
              title="Expense summary"
              right={
                <span className="text-xs text-muted-foreground">per month</span>
              }
            >
              {() => (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-border py-3">
                    <div>
                      <p className="font-medium">Personal</p>
                      <p className="text-sm text-muted-foreground">
                        {
                          expenses.filter((e) => e.expense_type === "personal")
                            .length
                        }{" "}
                        expenses
                      </p>
                    </div>
                    <p className="text-lg font-semibold currency">
                      <MaskedValue value={formatCurrency(personalExpenses)} />
                    </p>
                  </div>
                  <div className="flex items-center justify-between border-b border-border py-3">
                    <div>
                      <p className="font-medium">Business</p>
                      <p className="text-sm text-muted-foreground">
                        {
                          expenses.filter((e) => e.expense_type === "business")
                            .length
                        }{" "}
                        expenses
                      </p>
                    </div>
                    <p className="text-lg font-semibold currency">
                      <MaskedValue value={formatCurrency(businessExpenses)} />
                    </p>
                  </div>
                  <div className="flex items-center justify-between pt-2">
                    <p className="font-medium text-muted-foreground">
                      Total monthly
                    </p>
                    <p className="text-xl font-bold currency text-teal-light">
                      <MaskedValue
                        value={formatCurrency(totalMonthlyExpenses)}
                      />
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <p className="text-muted-foreground">Annual projection</p>
                    <p className="font-medium currency">
                      <MaskedValue
                        value={formatCurrency(totalMonthlyExpenses * 12)}
                      />
                    </p>
                  </div>
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
