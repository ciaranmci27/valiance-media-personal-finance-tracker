"use client";
import { Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { useAccountingTaxLink } from "./use-accounting-tax-link";
export function TaxAccountingStatus({
  year,
  state,
  issue,
}: {
  year: number;
  state: ReturnType<typeof useAccountingTaxLink>;
  issue: string;
}) {
  const view = state.view,
    linked = view?.link?.enabled,
    issues = view?.snapshot?.payload.calculation.issues ?? [];
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
  }).format(new Date());
  const cutoff =
    view?.snapshot?.through_date ??
    (year === Number(today.slice(0, 4)) ? today : `${year}-12-31`);
  const partial = issues.some((i) => i.severity === "blocking");
  const href = `/accounting?view=manage&section=tax&tax_year=${year}&tax_through=${cutoff}&tax_tab=estimator`;
  return (
    <div className="rounded-xl border border-border bg-secondary/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link2 size={16} className="text-primary" />
          <p className="text-sm font-medium">
            {linked
              ? view.current && !issue
                ? partial
                  ? "Some linked inputs still need review"
                  : "Using selected accounting inputs"
                : "Accounting inputs need review"
              : "Connect your company books"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {linked && (
            <Button
              size="sm"
              variant="ghost"
              disabled={state.loading}
              onClick={() => void state.refresh(true)}
            >
              <RefreshCw
                size={14}
                className={state.loading ? "animate-spin" : ""}
              />{" "}
              Refresh
            </Button>
          )}
          <a href={href} className="text-sm text-primary">
            {linked ? "Review link & forecast" : "Choose linked inputs"}
          </a>
          <a href={href.replace("tax_tab=estimator", "tax_tab=payments")} className="text-sm text-primary">Payment planning</a>
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {linked
          ? view.current && !issue
            ? `Actuals through ${view.snapshot?.through_date}, plus explicit remaining-year forecasts. Linked amounts are read-only here; unlinking restores your original manual values.`
            : "Original manual inputs are in use until the link is current and valid."
          : "Link selected business income, payroll and withholding rows. Your other personal inputs remain editable."}
      </p>
      {(issue || state.error || view?.job?.last_error) && (
        <p role="alert" className="mt-2 text-sm text-warning">
          {issue || state.error || view?.job?.last_error}
        </p>
      )}
      {linked && issues.length > 0 && (
        <details className="mt-3 text-sm" open={partial}>
          <summary className="cursor-pointer text-warning">
            {issues.length} source or forecast items need review
          </summary>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-muted-foreground">
            {issues.map((i) => (
              <li key={i.key}>{i.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
