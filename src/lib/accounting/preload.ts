import type { AccountingQuery } from "./read-cache";
import type { ReportFilter } from "./reports";
import type { AccountingView } from "./views";
import { registerFilterSchema, type RegisterFilter } from "./workflows";

/**
 * What each screen of the books reads before it can paint, written down once
 * so the shell can warm it ahead of a click and the screen then finds it
 * waiting. Pure on purpose: the strings built here have to match what the
 * screens ask for byte for byte, and verify-accounting-preload holds them to
 * it.
 */

export const REGISTER_PAGE = 50;

/** The first day of the month `months` before the month of `date`. */
export function monthsBefore(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 - months;
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/** The ledger's filter controls, as it holds them in state. */
export type LedgerFilterState = {
  search: string;
  account: string;
  status: RegisterFilter["status"];
  sort: NonNullable<RegisterFilter["sort"]>;
  source: string;
  payee: string;
  from: string;
  to: string;
  missing: boolean;
  minCents?: string;
  maxCents?: string;
  offset: number;
};

/**
 * Where the ledger lands: the inbox while anything needs review, otherwise
 * everything. A link can ask for a status; a reviewed or posted link opens
 * the full list because those rows are not an inbox.
 */
export function journalInitialState(
  initial: Partial<RegisterFilter>,
  reviewCount: number,
): LedgerFilterState {
  const inboxStatus: RegisterFilter["status"] =
    reviewCount > 0 ? "draft" : "all";
  const status: RegisterFilter["status"] =
    initial.review === "needs_review"
      ? "draft"
      : initial.review === "reviewed" || initial.status === "posted"
        ? "all"
        : (initial.status ?? inboxStatus);
  return {
    search: initial.query ?? "",
    account: initial.account ?? "",
    status,
    sort: initial.sort ?? "date_desc",
    source: initial.source ?? "",
    payee: initial.payee ?? "",
    from: initial.from ?? "",
    to: initial.to ?? "",
    missing: initial.missing_receipt ?? false,
    minCents: initial.min_cents,
    maxCents: initial.max_cents,
    offset: initial.offset ?? 0,
  };
}

/** The ledger's page request. Key order is part of the cache identity. */
export function buildRegisterFilter(
  state: LedgerFilterState,
): Partial<RegisterFilter> {
  return {
    from: state.from || undefined,
    to: state.to || undefined,
    account: state.account || undefined,
    status:
      state.status === "discarded" || state.status === "reversed"
        ? state.status
        : "all",
    review:
      state.status === "draft"
        ? "needs_review"
        : state.status === "posted"
          ? "reviewed"
          : undefined,
    query: state.search || undefined,
    source: (state.source || undefined) as RegisterFilter["source"],
    payee: state.payee || undefined,
    missing_receipt: state.missing,
    min_cents: state.minCents,
    max_cents: state.maxCents,
    sort: state.sort,
    offset: state.offset,
    limit: REGISTER_PAGE,
  };
}

export function registerSignature(filter: Partial<RegisterFilter>): string {
  return JSON.stringify(filter);
}

export function registerQuery(
  filter: Partial<RegisterFilter>,
): AccountingQuery {
  return { view: "register", filter: registerSignature(filter) };
}

/** A shared `?transactions=` link, or nothing when it is absent or broken. */
export function journalFilterFromLocation(
  search: URLSearchParams,
): Partial<RegisterFilter> {
  const raw = search.get("transactions");
  if (!raw) return {};
  try {
    const parsed = registerFilterSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The Overview's cash flow: the last twelve months, posted only. */
export function overviewReportFilter(to: string): ReportFilter {
  return { from: monthsBefore(to, 11), to, mode: "posted", offset: 0 };
}

/** A report opened from the catalog: the books' date range, posted only. */
export function defaultReportFilter(from: string, to: string): ReportFilter {
  return { from, to, mode: "posted", offset: 0 };
}

export function reportSignature(filter: ReportFilter): string {
  return JSON.stringify(filter);
}

export function reportQuery(
  report: string,
  filter: ReportFilter,
): AccountingQuery {
  return { view: "report", report, filter: reportSignature(filter) };
}

export function payrollListFilter(input: {
  year: number;
  today: string;
  query: string;
  offset: number;
}): string {
  return JSON.stringify({
    year: input.year,
    as_of: input.today,
    query: input.query,
    offset: input.offset,
  });
}

/** Month end reads the checklist for one month and the history of closes. */
export function closeQueries(month: string): AccountingQuery[] {
  return [{ view: "close", date: `${month}-01` }, { view: "close-history" }];
}

export type PreloadContext = {
  from: string;
  to: string;
  today: string;
  reviewCount: number;
  entry?: string | null;
  section?: string | null;
  /** A `?month=` link for Month end, already validated. */
  month?: string | null;
  /** A `?transactions=` link for the ledger. */
  journal?: Partial<RegisterFilter>;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The context the page would build for this address, using its own defaults. */
export function preloadContextFromLocation(
  search: URLSearchParams,
  today: string,
  reviewCount: number,
): PreloadContext {
  const month = search.get("month");
  return {
    from: search.get("from") ?? `${today.slice(0, 4)}-01-01`,
    to: search.get("to") ?? today,
    today,
    reviewCount,
    entry: search.get("entry"),
    section: search.get("section"),
    month: month && MONTH.test(month) ? month : null,
    journal: journalFilterFromLocation(search),
  };
}

/** What the shell itself needs before any view can paint. */
export function bootQueries(ctx: PreloadContext): AccountingQuery[] {
  return [
    { view: "manage" },
    { view: "feeds" },
    { view: "setup", year: ctx.today.slice(0, 4) },
    ...(ctx.entry ? [{ view: "evidence", entry: ctx.entry }] : []),
  ];
}

/** What one view reads on its first paint; empty when it paints from the workspace alone. */
export function viewQueries(
  view: AccountingView,
  ctx: PreloadContext,
  initialFilter: Partial<RegisterFilter> = ctx.journal ?? {},
): AccountingQuery[] {
  switch (view) {
    case "overview":
      return [
        reportQuery("profit-loss", overviewReportFilter(ctx.to)),
        registerQuery({
          review: "needs_review",
          sort: "date_desc",
          offset: 0,
          limit: 5,
        }),
        registerQuery({
          status: "posted",
          sort: "date_desc",
          offset: 0,
          limit: 8,
        }),
        { view: "close", date: `${ctx.to.slice(0, 7)}-01` },
      ];
    case "journal":
      return [
        registerQuery(
          buildRegisterFilter(
            journalInitialState(initialFilter, ctx.reviewCount),
          ),
        ),
      ];
    case "payroll":
      return [
        {
          view: "payroll",
          filter: payrollListFilter({
            year: Number(ctx.today.slice(0, 4)),
            today: ctx.today,
            query: "",
            offset: 0,
          }),
        },
      ];
    case "close":
      return closeQueries(ctx.month ?? ctx.to.slice(0, 7));
    default:
      return [];
  }
}
