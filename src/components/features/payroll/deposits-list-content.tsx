"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  ExternalLink,
  History as HistoryIconLucide,
  Landmark,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/select";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toast";
import { cn, formatCurrency } from "@/lib/utils";
import {
  listDepositHistory,
  markDepositPaid,
} from "@/lib/payroll/deposits-actions";
import { FUTA_DEPOSIT_THRESHOLD } from "@/lib/payroll/deposits";
import {
  DEPOSIT_TYPE_LABELS,
  type DepositStatus,
  type DepositType,
  type PayrollDepositEventType,
  type PayrollDepositHistory,
  type PayrollTaxDeposit,
  type StatePaymentPortal,
  type StatePaymentPortals,
  type StateTaxConfig,
} from "@/types/payroll";
import {
  DEPOSIT_STATUS_HUMAN,
  depositStatusLabel,
} from "@/lib/payroll/labels";
import { Term } from "./term";

type StatusFilter = "upcoming" | "all" | DepositStatus;

type HistoryCacheEntry =
  | { status: "loading"; entries: PayrollDepositHistory[] }
  | { status: "loaded"; entries: PayrollDepositHistory[] }
  | { status: "error"; entries: PayrollDepositHistory[]; error?: string };

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "upcoming", label: "Upcoming" },
  { value: "scheduled", label: DEPOSIT_STATUS_HUMAN.scheduled },
  { value: "paid", label: DEPOSIT_STATUS_HUMAN.paid },
  { value: "late", label: DEPOSIT_STATUS_HUMAN.late },
  { value: "all", label: "All" },
];

const TYPE_OPTIONS: { value: DepositType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "federal_941", label: DEPOSIT_TYPE_LABELS.federal_941 },
  { value: "federal_940", label: DEPOSIT_TYPE_LABELS.federal_940 },
  { value: "state_withholding", label: DEPOSIT_TYPE_LABELS.state_withholding },
  { value: "state_suta", label: DEPOSIT_TYPE_LABELS.state_suta },
];

// ─── Federal payment portal (hardcoded, universal) ────────────────────────────
// Federal 941 and 940 both go to EFTPS. State deposits load their portal
// metadata from state_tax_configs.payment_portals (see state config UI).
interface PaymentDestination {
  url: string;
  portal: string;
  agency: string;
  form: string;
  steps: string[];
}

const FEDERAL_PAYMENT_DESTINATIONS: Record<
  "federal_941" | "federal_940",
  PaymentDestination
> = {
  federal_941: {
    url: "https://www.eftps.gov/eftps/",
    portal: "EFTPS",
    agency: "IRS - Electronic Federal Tax Payment System",
    form: "Form 941",
    steps: [
      "Log in to EFTPS with your EIN, PIN, and password",
      'Choose "Make a Payment"',
      "Select 941 - Employer's Quarterly Federal Tax Return",
      "Pick the tax period (quarter end) shown below, then enter the amount",
      "Schedule the payment at least 1 business day before the due date",
      "Copy the EFTPS confirmation number and mark this deposit paid below",
    ],
  },
  federal_940: {
    url: "https://www.eftps.gov/eftps/",
    portal: "EFTPS",
    agency: "IRS - Electronic Federal Tax Payment System",
    form: "Form 940",
    steps: [
      "Log in to EFTPS",
      "Choose Make a Payment, then 940 - Employer's Annual Federal Unemployment",
      "Pick the tax year shown below and enter the amount",
      "Schedule the payment 1+ business day before the due date",
      "Save the EFTPS confirmation and mark this deposit paid below",
    ],
  },
};

/**
 * Resolve the active payment portal for a given state deposit type. Looks
 * at the most recent state_tax_configs row for any state (a single-tenant
 * admin is assumed to work with one state at a time - when we go multi-state
 * this will need scoping by the deposit's source employee's state).
 */
function resolveStatePortal(
  depositType: DepositType,
  stateConfigs: StateTaxConfig[],
): StatePaymentPortal | null {
  if (depositType === "federal_941" || depositType === "federal_940") return null;
  const mostRecent = stateConfigs
    .slice()
    .sort((a, b) => b.tax_year - a.tax_year)[0];
  if (!mostRecent) return null;
  const portals = mostRecent.payment_portals as StatePaymentPortals | undefined;
  if (!portals) return null;
  return portals[depositType as keyof StatePaymentPortals] ?? null;
}

function resolveDestination(
  depositType: DepositType,
  stateConfigs: StateTaxConfig[],
): PaymentDestination | null {
  if (depositType === "federal_941" || depositType === "federal_940") {
    return FEDERAL_PAYMENT_DESTINATIONS[depositType];
  }
  const portal = resolveStatePortal(depositType, stateConfigs);
  return portal ?? null;
}

export function DepositsListContent({
  deposits,
  stateConfigs,
}: {
  deposits: PayrollTaxDeposit[];
  stateConfigs: StateTaxConfig[];
}) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("upcoming");
  const [typeFilter, setTypeFilter] = React.useState<DepositType | "all">("all");
  const [year, setYear] = React.useState<number | "all">(() =>
    deposits.length > 0 ? yearOf(deposits[0].period_end) : "all",
  );

  const [payingDeposit, setPayingDeposit] = React.useState<PayrollTaxDeposit | null>(
    null,
  );
  const [paymentReference, setPaymentReference] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [historyCache, setHistoryCache] = React.useState<
    Record<string, HistoryCacheEntry>
  >({});

  const toggleHistory = React.useCallback(
    (depositId: string) => {
      setExpandedId((prev) => (prev === depositId ? null : depositId));
      // Fetch on first open only; subsequent opens reuse the cached entries.
      if (historyCache[depositId]) return;
      setHistoryCache((prev) => ({
        ...prev,
        [depositId]: { status: "loading", entries: [] },
      }));
      void listDepositHistory(depositId).then((res) => {
        setHistoryCache((prev) => ({
          ...prev,
          [depositId]: res.ok
            ? { status: "loaded", entries: res.data ?? [] }
            : { status: "error", entries: [], error: res.error },
        }));
      });
    },
    [historyCache],
  );

  const years = React.useMemo(() => {
    const set = new Set<number>();
    for (const d of deposits) set.add(yearOf(d.period_end));
    return Array.from(set).sort((a, b) => b - a);
  }, [deposits]);

  const decorated = React.useMemo(() => {
    const today = todayYmd();

    // IRS Pub 15: FUTA quarterly deposit is only required once accumulated
    // undeposited FUTA exceeds $500. Below that, the amount rolls forward and
    // ultimately pays with Form 940 in January. Compute per-year cumulative
    // FUTA so we can render Q1-Q3 scheduled buckets under threshold as
    // "Carries to Form 940" rather than a misleading quarterly due date.
    const rollsForwardIds = new Set<string>();
    const futaByYear = new Map<number, PayrollTaxDeposit[]>();
    for (const d of deposits) {
      if (d.deposit_type !== "federal_940") continue;
      const y = yearOf(d.period_end);
      if (!futaByYear.has(y)) futaByYear.set(y, []);
      futaByYear.get(y)!.push(d);
    }
    for (const list of futaByYear.values()) {
      const sorted = [...list].sort((a, b) =>
        a.period_end.localeCompare(b.period_end),
      );
      let cumulative = 0;
      for (const d of sorted) {
        cumulative += Number(d.amount || 0);
        const isQ4 = d.period_end.endsWith("-12-31");
        if (
          !isQ4 &&
          d.status !== "paid" &&
          cumulative <= FUTA_DEPOSIT_THRESHOLD
        ) {
          rollsForwardIds.add(d.id);
        }
      }
    }

    return deposits.map((d) => {
      const futaRollsForward = rollsForwardIds.has(d.id);
      return {
        ...d,
        futaRollsForward,
        // Under-threshold FUTA isn't actually due on its quarterly date, so
        // don't colour it as overdue/due-soon.
        isOverdue:
          !futaRollsForward &&
          d.status === "scheduled" &&
          d.due_date < today,
        isSoon:
          !futaRollsForward &&
          d.status === "scheduled" &&
          withinDays(d.due_date, today, 7),
      };
    });
  }, [deposits]);

  const filtered = React.useMemo(() => {
    const today = todayYmd();
    return decorated.filter((d) => {
      if (year !== "all" && yearOf(d.period_end) !== year) return false;
      if (typeFilter !== "all" && d.deposit_type !== typeFilter) return false;
      if (statusFilter === "all") return true;
      if (statusFilter === "upcoming") {
        // Under-threshold FUTA buckets carry to Form 940 rather than their
        // quarterly date, so keep them visible as upcoming regardless of the
        // stamped due_date.
        return d.status !== "paid" && (d.futaRollsForward || d.due_date >= today);
      }
      return d.status === statusFilter;
    });
  }, [decorated, statusFilter, typeFilter, year]);

  const stats = React.useMemo(() => {
    const today = todayYmd();
    let dueSoon = 0;
    let overdue = 0;
    let paidYtd = 0;
    for (const d of decorated) {
      if (d.status === "paid") paidYtd += Number(d.amount || 0);
      if (d.status === "scheduled" && !d.futaRollsForward) {
        if (d.due_date < today) overdue += Number(d.amount || 0);
        else if (withinDays(d.due_date, today, 7)) dueSoon += Number(d.amount || 0);
      }
    }
    return { dueSoon, overdue, paidYtd };
  }, [decorated]);

  const openPayDialog = (dep: PayrollTaxDeposit) => {
    setPayingDeposit(dep);
    setPaymentReference("");
  };

  const closePayDialog = () => {
    if (submitting) return;
    setPayingDeposit(null);
  };

  const handleMarkPaid = async () => {
    if (!payingDeposit) return;
    setSubmitting(true);
    try {
      const res = await markDepositPaid({
        deposit_id: payingDeposit.id,
        payment_reference: paymentReference.trim() || null,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to mark paid");
        return;
      }
      toast("success", "Deposit marked as paid");
      // The trigger just wrote a new `paid` history row; drop the cached
      // entries so the next expand re-fetches and shows it.
      setHistoryCache((prev) => {
        if (!prev[payingDeposit.id]) return prev;
        const next = { ...prev };
        delete next[payingDeposit.id];
        return next;
      });
      router.refresh();
    } finally {
      setSubmitting(false);
      setPayingDeposit(null);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Landmark className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Tax Deposits</h1>
            <p className="text-sm text-muted-foreground">
              Federal <Term slug="941">941</Term>,{" "}
              <Term slug="futa">FUTA</Term>, and state withholding payments,
              scheduled automatically when a pay run is{" "}
              <Term slug="finalized">approved</Term>.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          title="Due in 7 days"
          value={stats.dueSoon}
          icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
          className="stagger-1"
        />
        <StatCard
          title="Overdue"
          value={stats.overdue}
          icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
          className="stagger-2"
        />
        <StatCard
          title="Paid YTD"
          value={stats.paidYtd}
          icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
          className="stagger-3"
        />
      </div>

      <div className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg bg-card p-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                statusFilter === opt.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="w-48">
          <CustomSelect
            size="sm"
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as DepositType | "all")}
            options={TYPE_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
            }))}
          />
        </div>

        {years.length > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-muted-foreground">Year</label>
            <div className="w-28">
              <CustomSelect
                size="sm"
                value={year === "all" ? "all" : String(year)}
                onChange={(v) => setYear(v === "all" ? "all" : Number(v))}
                options={[
                  { value: "all", label: "All" },
                  ...years.map((y) => ({ value: String(y), label: String(y) })),
                ]}
              />
            </div>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="glass-card rounded-xl p-10 text-center text-sm text-muted-foreground">
          No deposits match these filters.{" "}
          <Term slug="finalized">Approve</Term> pay runs to generate scheduled
          deposits automatically.
        </div>
      ) : (
        <>
          <div className="glass-card rounded-xl overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">Period</th>
                    <th className="text-left px-4 py-3 font-medium">Due</th>
                    <th className="text-left px-4 py-3 font-medium">Amount</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((dep) => (
                    <DepositRow
                      key={dep.id}
                      deposit={dep}
                      destination={resolveDestination(
                        dep.deposit_type,
                        stateConfigs,
                      )}
                      onPay={() => openPayDialog(dep)}
                      isExpanded={expandedId === dep.id}
                      onToggleHistory={() => toggleHistory(dep.id)}
                      history={historyCache[dep.id]}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {filtered.map((dep) => (
              <DepositCard
                key={dep.id}
                deposit={dep}
                destination={resolveDestination(
                  dep.deposit_type,
                  stateConfigs,
                )}
                onPay={() => openPayDialog(dep)}
                isExpanded={expandedId === dep.id}
                onToggleHistory={() => toggleHistory(dep.id)}
                history={historyCache[dep.id]}
              />
            ))}
          </div>
        </>
      )}

      <PayDialog
        deposit={payingDeposit}
        reference={paymentReference}
        onReferenceChange={setPaymentReference}
        onConfirm={handleMarkPaid}
        onCancel={closePayDialog}
        submitting={submitting}
      />
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface DepositRowProps {
  deposit: PayrollTaxDeposit & {
    isOverdue?: boolean;
    isSoon?: boolean;
    futaRollsForward?: boolean;
  };
  /** Resolved payment destination: federal (hardcoded) or state (loaded from
   *  state_tax_configs.payment_portals). Null when no portal is configured. */
  destination: PaymentDestination | null;
  onPay: () => void;
  isExpanded: boolean;
  onToggleHistory: () => void;
  history: HistoryCacheEntry | undefined;
}

function DepositRow({
  deposit,
  destination,
  onPay,
  isExpanded,
  onToggleHistory,
  history,
}: DepositRowProps) {
  const panelId = `deposit-history-${deposit.id}`;
  // Whole-row toggle: clicking anywhere on the row expands/collapses history.
  // Interactive cells (Pay / Mark paid links + buttons) call stopPropagation
  // on their own click handlers so they don't also trigger the toggle.
  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleHistory();
    }
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <tr
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        onClick={onToggleHistory}
        onKeyDown={handleRowKeyDown}
        className="border-t border-border hover:bg-secondary/20 focus-visible:outline-none focus-visible:bg-secondary/30"
      >
        <td className="px-4 py-3 font-medium">
          <div className="flex items-center gap-2 flex-wrap">
            <span>{DEPOSIT_TYPE_LABELS[deposit.deposit_type]}</span>
            {deposit.notes?.includes("$100k next-day") && (
              <span className="inline-flex items-center rounded-md bg-error/10 text-error px-1.5 py-0.5 text-xs font-medium whitespace-nowrap">
                $100k rule
              </span>
            )}
            {deposit.futaRollsForward && (
              <span className="inline-flex items-center rounded-md bg-secondary text-muted-foreground px-1.5 py-0.5 text-xs font-medium whitespace-nowrap">
                Under $500
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
          {deposit.period_start} → {deposit.period_end}
        </td>
        <td
          className={cn(
            "px-4 py-3 whitespace-nowrap",
            deposit.isOverdue && "text-error font-medium",
            deposit.isSoon && !deposit.isOverdue && "text-warning font-medium",
            deposit.futaRollsForward && "text-muted-foreground",
          )}
        >
          {deposit.futaRollsForward ? "Carries to Form 940" : deposit.due_date}
        </td>
        <td className="px-4 py-3 font-mono whitespace-nowrap">
          {formatCurrency(Number(deposit.amount || 0))}
        </td>
        <td className="px-4 py-3">
          <StatusBadge
            status={deposit.status}
            overdue={deposit.isOverdue === true}
          />
        </td>
        <td className="px-4 py-3" onClick={stop}>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            {deposit.status !== "paid" && destination && (
              <PayAtPortalButton destination={destination} />
            )}
            {deposit.status !== "paid" && (
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  onPay();
                }}
                className="whitespace-nowrap"
              >
                Mark paid
              </Button>
            )}
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr id={panelId} className="bg-secondary/10">
          <td colSpan={6} className="px-6 py-4 space-y-3">
            {deposit.status !== "paid" && (
              <PaymentInstructions
                deposit={deposit}
                destination={destination}
              />
            )}
            <SourceRunsList runIds={deposit.included_run_ids ?? []} />
            <DepositHistoryPanel entry={history} />
          </td>
        </tr>
      )}
    </>
  );
}

interface DepositCardProps {
  deposit: PayrollTaxDeposit & {
    isOverdue?: boolean;
    isSoon?: boolean;
    futaRollsForward?: boolean;
  };
  destination: PaymentDestination | null;
  onPay: () => void;
  isExpanded: boolean;
  onToggleHistory: () => void;
  history: HistoryCacheEntry | undefined;
}

function DepositCard({
  deposit,
  destination,
  onPay,
  isExpanded,
  onToggleHistory,
  history,
}: DepositCardProps) {
  const panelId = `deposit-history-card-${deposit.id}`;
  return (
    <div className="glass-card rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="font-medium flex items-center gap-2 flex-wrap">
            <span className="truncate">{DEPOSIT_TYPE_LABELS[deposit.deposit_type]}</span>
            {deposit.notes?.includes("$100k next-day") && (
              <span className="inline-flex items-center rounded-md bg-error/10 text-error px-1.5 py-0.5 text-xs font-medium">
                $100k rule
              </span>
            )}
            {deposit.futaRollsForward && (
              <span className="inline-flex items-center rounded-md bg-secondary text-muted-foreground px-1.5 py-0.5 text-xs font-medium">
                Under $500
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {deposit.period_start} → {deposit.period_end}
          </div>
        </div>
        <StatusBadge status={deposit.status} overdue={deposit.isOverdue === true} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Due
          </div>
          <div
            className={cn(
              "text-sm",
              deposit.isOverdue && "text-error font-medium",
              deposit.isSoon && !deposit.isOverdue && "text-warning font-medium",
              deposit.futaRollsForward && "text-muted-foreground",
            )}
          >
            {deposit.futaRollsForward ? "Carries to Form 940" : deposit.due_date}
          </div>
        </div>
        <div className="text-right space-y-0.5">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Amount
          </div>
          <div className="font-mono text-base">
            {formatCurrency(Number(deposit.amount || 0))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 flex-wrap">
        <button
          type="button"
          onClick={onToggleHistory}
          aria-expanded={isExpanded}
          aria-controls={panelId}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <HistoryIconLucide className="h-3.5 w-3.5" aria-hidden="true" />
          {isExpanded ? "Hide details" : "Details"}
        </button>
        {deposit.status !== "paid" && destination && (
          <PayAtPortalButton destination={destination} />
        )}
        {deposit.status !== "paid" && (
          <Button
            size="sm"
            variant="outline"
            onClick={onPay}
            className="ml-auto"
          >
            Mark paid
          </Button>
        )}
      </div>

      {isExpanded && (
        <div id={panelId} className="pt-2 border-t border-border space-y-3">
          {deposit.status !== "paid" && (
            <PaymentInstructions
              deposit={deposit}
              destination={destination}
            />
          )}
          <SourceRunsList runIds={deposit.included_run_ids ?? []} />
          <DepositHistoryPanel entry={history} />
        </div>
      )}
    </div>
  );
}

// ─── Pay-at-portal affordances ────────────────────────────────────────────────

function PayAtPortalButton({ destination }: { destination: PaymentDestination }) {
  return (
    <a
      href={destination.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background whitespace-nowrap"
    >
      Pay at {destination.portal}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function PaymentInstructions({
  deposit,
  destination,
}: {
  deposit: PayrollTaxDeposit & { futaRollsForward?: boolean };
  destination: PaymentDestination | null;
}) {
  // State deposits without a configured portal get a "configure it" hint
  // pointing at the state config page. Federal deposits always have a
  // destination (EFTPS is hardcoded).
  if (!destination) {
    const isState = deposit.deposit_type.startsWith("state_");
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <div className="text-foreground font-medium">
          No payment portal configured
        </div>
        <p>
          {isState
            ? "Set the portal URL, agency, and step-by-step instructions for this deposit type on the state config page so future reminders deep-link correctly."
            : "This deposit type does not have a default portal configured."}
        </p>
        {isState && (
          <Link
            href="/payroll/config/states"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Open state config
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      {deposit.futaRollsForward && (
        <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Optional now.</span>{" "}
          YTD FUTA is under the $500 quarterly threshold, so this amount rolls
          forward and gets paid with Form 940 by January 31. You can pay it
          early through EFTPS at any time if you prefer — or wait.
        </div>
      )}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 space-y-0.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">
            How to pay this deposit
          </div>
          <div className="text-sm font-medium text-foreground">
            {destination.agency}
          </div>
          <div className="text-xs text-muted-foreground">
            Pay {formatCurrency(Number(deposit.amount || 0))} using{" "}
            <span className="text-foreground font-medium">
              {destination.form}
            </span>
            , period {deposit.period_start} → {deposit.period_end}, due{" "}
            <span className="text-foreground font-medium">
              {deposit.futaRollsForward
                ? "with Form 940 (Jan 31)"
                : deposit.due_date}
            </span>
            .
          </div>
        </div>
        <a
          href={destination.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background shrink-0"
        >
          Open {destination.portal}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
      <ol className="pl-5 text-xs text-muted-foreground list-decimal space-y-1 leading-5">
        {destination.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function SourceRunsList({ runIds }: { runIds: string[] }) {
  if (runIds.length === 0) return null;
  const plural = runIds.length === 1 ? "pay run" : "pay runs";
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Source {plural}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {runIds.map((id, idx) => (
          <Link
            key={id}
            href={`/payroll/runs/${id}`}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-foreground hover:bg-primary/10 hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Pay run {idx + 1}
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  overdue,
}: {
  status: DepositStatus;
  overdue: boolean;
}) {
  if (overdue) {
    return (
      <span className="inline-flex items-center rounded-md bg-error/10 text-error px-2 py-0.5 text-xs font-medium">
        Overdue
      </span>
    );
  }
  const tone =
    status === "paid"
      ? "bg-success/10 text-success"
      : status === "late"
        ? "bg-error/10 text-error"
        : "bg-primary/10 text-primary";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        tone,
      )}
    >
      {depositStatusLabel(status)}
    </span>
  );
}

// ─── Pay dialog ───────────────────────────────────────────────────────────────

function PayDialog({
  deposit,
  reference,
  onReferenceChange,
  onConfirm,
  onCancel,
  submitting,
}: {
  deposit: PayrollTaxDeposit | null;
  reference: string;
  onReferenceChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const open = deposit !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="space-y-4">
        <DialogTitle>Mark deposit as paid</DialogTitle>
        {deposit && (
          <>
            <DialogDescription>
              {DEPOSIT_TYPE_LABELS[deposit.deposit_type]} of{" "}
              {formatCurrency(Number(deposit.amount || 0))} for{" "}
              {deposit.period_start} through {deposit.period_end}. Record the
              confirmation or EFTPS reference so you can tie the deposit back
              to your bank records.
            </DialogDescription>
            <Input
              label="Payment reference (optional)"
              value={reference}
              onChange={(e) => onReferenceChange(e.target.value)}
              placeholder="EFTPS confirmation number, check #, etc."
            />
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={onConfirm} disabled={submitting}>
                {submitting && (
                  <Loader2
                    className="h-4 w-4 mr-1 animate-spin"
                    aria-hidden="true"
                  />
                )}
                Mark paid
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── History panel ────────────────────────────────────────────────────────────

function DepositHistoryPanel({ entry }: { entry: HistoryCacheEntry | undefined }) {
  if (!entry || entry.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Loader2
          className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        Loading history...
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <p role="alert" className="text-xs text-error">
        Could not load history{entry.error ? `: ${entry.error}` : "."}
      </p>
    );
  }

  if (entry.entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No history recorded yet.</p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {entry.entries.map((h) => (
        <li
          key={h.id}
          className="flex items-start justify-between gap-3 flex-wrap text-xs"
        >
          <div className="flex items-start gap-2 min-w-0">
            <span className="mt-0.5 flex-none">
              <DepositHistoryIcon type={h.event_type} />
            </span>
            <div className="min-w-0">
              <span className="font-medium text-foreground">
                {humanizeDepositEvent(h.event_type)}
              </span>
              {h.notes && (
                <span className="text-muted-foreground"> - {h.notes}</span>
              )}
              <span className="ml-2 font-mono text-muted-foreground">
                {formatCurrency(Number(h.amount || 0))}
              </span>
            </div>
          </div>
          <span className="text-muted-foreground">{formatTime(h.changed_at)}</span>
        </li>
      ))}
    </ol>
  );
}

function DepositHistoryIcon({ type }: { type: PayrollDepositEventType }) {
  const map: Record<PayrollDepositEventType, React.ReactNode> = {
    created: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    amount_changed: <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    runs_changed: <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    paid: <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />,
    unpaid: <Circle className="h-3.5 w-3.5 text-warning" aria-hidden="true" />,
    marked_late: <AlertTriangle className="h-3.5 w-3.5 text-error" aria-hidden="true" />,
    note_updated: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    deleted: <Trash2 className="h-3.5 w-3.5 text-error" aria-hidden="true" />,
    restored: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
    updated: <Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />,
  };
  return <>{map[type]}</>;
}

function humanizeDepositEvent(type: PayrollDepositEventType): string {
  switch (type) {
    case "created":
      return "Created";
    case "amount_changed":
      return "Amount changed";
    case "runs_changed":
      return "Runs included updated";
    case "paid":
      return "Marked paid";
    case "unpaid":
      return "Reverted to scheduled";
    case "marked_late":
      return "Flagged past due";
    case "note_updated":
      return "Notes updated";
    case "deleted":
      return "Deleted";
    case "restored":
      return "Restored";
    case "updated":
      return "Updated";
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function yearOf(ymd: string): number {
  return Number(ymd.split("-")[0]);
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function withinDays(target: string, from: string, days: number): boolean {
  const t = Date.parse(`${target}T00:00:00Z`);
  const f = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(f)) return false;
  const diff = (t - f) / 86_400_000;
  return diff >= 0 && diff <= days;
}
