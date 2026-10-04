"use client";
import { Fragment } from "react";
import { useSearchParams } from "next/navigation";
import { BarChart3, BookOpen, ChevronRight, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BooksMetadata } from "./types";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import { reportCatalog, type ReportId } from "@/lib/accounting/report-model";
import {
  supportReportCatalog,
  type SupportReportId,
} from "@/lib/accounting/support-reports";
import { booksPackageCatalog } from "@/lib/accounting/books-package";
import { defaultReportFilter, reportQuery } from "@/lib/accounting/preload";
import { AccountingBooksPackage } from "./accounting-books-package";
import { AccountingProfitLoss } from "./accounting-profit-loss";
import { AccountingBalanceSheet } from "./accounting-balance-sheet";
import { AccountingCashFlow } from "./accounting-cash-flow";
import { AccountingCustomerIncome } from "./accounting-customer-income";
import { AccountingVendorExpenses } from "./accounting-vendor-expenses";
import { AccountingOwnerActivity } from "./accounting-owner-activity";
import { AccountingTrialBalance } from "./accounting-trial-balance";
import { AccountingGeneralLedger } from "./accounting-general-ledger";
import { AccountingContractorWorksheet } from "./accounting-contractor-worksheet";
import { AccountingTaxWorkpapersReport } from "./accounting-tax-workpapers-report";
import { AccountingPayrollRegister } from "./accounting-payroll-register";
import { AccountingFixedAssets } from "./accounting-fixed-assets";
import { AccountingLoanBalances } from "./accounting-loan-balances";
import { DEMO_SUPPORT_REPORTS } from "@/lib/accounting/demo-reports";
import { useAccountingCache } from "./accounting-cache";
import {
  AccountingPageHeader,
  accountingHeader,
} from "./accounting-page-header";

const REPORT_GROUPS: {
  name: string;
  icon: typeof Landmark;
  description: string;
}[] = [
  {
    name: "Financial statements",
    icon: Landmark,
    description: "The core view of profit, financial position and cash.",
  },
  {
    name: "Business performance",
    icon: BarChart3,
    description: "Customers, vendors and the costs behind your income.",
  },
  {
    name: "Detailed accounting",
    icon: BookOpen,
    description: "Balances, journal activity and owner transactions.",
  },
  {
    name: "Customers & receivables",
    icon: BookOpen,
    description: "Unpaid invoices, customer advances and deposit policies.",
  },
  {
    name: "Payroll & year end",
    icon: BookOpen,
    description:
      "Payroll registers, contractor totals and the year-end package.",
  },
];

/**
 * The reports list, and each report's own screen. Every report in the
 * catalog, each support report and the year-end package has a screen of
 * its own that reads its own data.
 */
export function AccountingReports({
  from,
  to,
  manage,
  onEntry,
  onReview,
  demo = false,
}: {
  from: string;
  to: string;
  /** Kept for the shell's call; each screen reads its own revision. */
  revision: string;
  manage: BooksMetadata;
  /** Kept for the shell's call; the report screens read accounts with their data. */
  accounts: AccountingAccount[];
  onEntry: (id: string) => void;
  onReview: () => void;
  demo?: boolean;
}) {
  const params = useSearchParams(),
    candidate = params.get("report");
  const report = reportCatalog.find((r) => r.id === candidate);
  const cache = useAccountingCache();
  const warm = (id: string) => {
    if (demo || !reportCatalog.some((r) => r.id === id)) return;
    void cache
      .read(reportQuery(id, defaultReportFilter(from, to)))
      .catch(() => undefined);
  };
  function navigate(id?: ReportId | SupportReportId | "books-package") {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "reports");
    if (id) url.searchParams.set("report", id);
    else url.searchParams.delete("report");
    window.history.pushState(null, "", url);
  }
  const support = supportReportCatalog.find((r) => r.id === candidate);
  if (candidate === "books-package")
    return <AccountingBooksPackage onBack={() => navigate()} onReview={onReview} demo={demo} />;
  if (report?.id === "profit-loss")
    return (
      <AccountingProfitLoss
        from={from}
        to={to}
        manage={manage}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "balance-sheet")
    return (
      <AccountingBalanceSheet
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "general-ledger")
    return (
      <AccountingGeneralLedger
        from={from}
        to={to}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "trial-balance")
    return (
      <AccountingTrialBalance
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "owner-activity")
    return (
      <AccountingOwnerActivity
        from={from}
        to={to}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "vendor-expenses")
    return (
      <AccountingVendorExpenses
        from={from}
        to={to}
        manage={manage}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        onOpenReport={(id) => navigate(id)}
        demo={demo}
      />
    );
  if (report?.id === "customer-income")
    return (
      <AccountingCustomerIncome
        from={from}
        to={to}
        manage={manage}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (report?.id === "cash-flow")
    return (
      <AccountingCashFlow
        from={from}
        to={to}
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (support?.id === "contractor-worksheet")
    return (
      <AccountingContractorWorksheet
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        demo={demo}
      />
    );
  if (support?.id === "tax-workpapers")
    return (
      <AccountingTaxWorkpapersReport
        onBack={() => navigate()}
        onEntry={onEntry}
        onReview={onReview}
        onOpenReport={(id) => navigate(id)}
        demo={demo}
      />
    );
  if (support?.id === "payroll-register")
    return <AccountingPayrollRegister onBack={() => navigate()} onEntry={onEntry} demo={demo} />;
  if (support?.id === "asset-register")
    return <AccountingFixedAssets onBack={() => navigate()} onEntry={onEntry} demo={demo} />;
  if (support?.id === "loan-register")
    return <AccountingLoanBalances manage={manage} onBack={() => navigate()} onEntry={onEntry} demo={demo} />;
  return (
    <div className="space-y-5 lg:space-y-6">
      <AccountingPageHeader {...accountingHeader("reports", "")} />
      {REPORT_GROUPS.filter((g) => g.name !== "Customers & receivables").map((g) => {
        const group = g.name;
        const Icon = g.icon;
        return (
          <Fragment key={group}>
            <section className="glass-card overflow-hidden rounded-xl md:grid md:grid-cols-[240px_1fr]">
              <div className="border-b border-border bg-secondary/20 p-6 md:border-b-0 md:border-r">
                <Icon
                  size={20}
                  aria-hidden="true"
                  className="mb-3 text-teal-light"
                />
                <h2 className="font-semibold">{group}</h2>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {g.description}
                </p>
              </div>
              <div className="divide-y divide-border">
                {[
                  ...reportCatalog,
                  // The demo shows the support reports it has synthetic books for.
                  ...(demo
                    ? [booksPackageCatalog, ...supportReportCatalog.filter((r) => DEMO_SUPPORT_REPORTS.includes(r.id))]
                    : [booksPackageCatalog, ...supportReportCatalog]),
                ]
                  .filter((r) => r.group === group)
                  .map((r) => (
                    <Button
                      key={r.id}
                      variant="ghost"
                      onClick={() => navigate(r.id)}
                      onPointerEnter={() => warm(r.id)}
                      onFocus={() => warm(r.id)}
                      className="group h-auto w-full justify-between gap-5 rounded-none p-5 text-left font-normal whitespace-normal focus-visible:-outline-offset-2"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium group-hover:text-teal-light">
                          {r.title}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                          {r.description}
                        </span>
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-teal-light"
                      />
                    </Button>
                  ))}
              </div>
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
