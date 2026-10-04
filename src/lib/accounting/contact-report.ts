import type {
  BreakdownData,
  ReportData,
  ReportFilter,
} from "./reports";
import {
  periodScope,
  percentOf,
  type BreakdownRow,
  type StatementRow,
} from "./profit-loss";
import { formatCents } from "./money";

/**
 * Reports that rank the books by contact: who pays the business (income by
 * customer) and, next, who the business pays. Each contact's figure comes
 * from the report's own per-contact totals (accounting.report dimensions),
 * so the rows always add up to the period's income. Roles decide the
 * groups: the contacts the report is about (clients), other sources (a bank
 * paying interest, a store payout), and money with no contact at all.
 */

const ZERO = BigInt(0);
const big = (value: string | bigint | null | undefined) =>
  typeof value === "bigint" ? value : BigInt(value || "0");
const abs = (v: bigint) => (v < ZERO ? -v : v);
const byAmount = (a: { amount: bigint }, b: { amount: bigint }) =>
  b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0;

/** The id the books give money recorded without a contact. */
export const NO_CONTACT = "unassigned";

export type ContactGroup = "main" | "other" | "none";
export type ContactParty = { id: string; name?: string; roles?: string[] };

export interface ContactConfig {
  side: "income" | "expense";
  /** Whether a contact with these roles is one the report is about. */
  isMain: (roles: string[]) => boolean;
  /** Words for the page: "client", "clients", ... */
  one: string;
  many: string;
  /** The heading for contacts that are not `many` (other income sources). */
  otherHeading: string;
  /** The row for money with no contact. */
  noneLabel: string;
  noneHint: string;
  /** The statement's main section and its subtotal: "Clients", "Total from clients". */
  mainHeading: string;
  mainTotal: string;
  /** The month chart's count and average series: "Paying clients", "Per paying client". */
  countLabel: string;
  averageLabel: string;
  /**
   * Roles shown as a tag on the main group, in the order a tag is chosen;
   * empty when the main group needs none (every client is a client).
   */
  mainTags: string[];
}

/**
 * Income by customer. A contact still without a role (a suggestion not yet
 * confirmed) counts as a client: income from it is most likely client work,
 * and leaving it out would hide money rather than sort it.
 */
export const CUSTOMER_REPORT: ContactConfig = {
  side: "income",
  isMain: (roles) => roles.length === 0 || roles.includes("client"),
  one: "client",
  many: "clients",
  otherHeading: "Other income",
  noneLabel: "No client assigned",
  noneHint: "Income with no contact. Assign a client in Transactions to count it.",
  mainHeading: "Clients",
  mainTotal: "Total from clients",
  countLabel: "Paying clients",
  averageLabel: "Per paying client",
  mainTags: [],
};

/**
 * Expenses by vendor. Everyone the business pays is in the main group, with
 * a tag for what they are (vendor, contractor, payroll, government, bank);
 * a contact that is only a client (a refund, say) is listed apart. Owner
 * draws and transfers are not expenses, so they never reach this report.
 */
export const VENDOR_REPORT: ContactConfig = {
  side: "expense",
  isMain: (roles) => roles.length === 0 || roles.some((r) => r !== "client"),
  one: "payee",
  many: "payees",
  otherHeading: "Other spending",
  noneLabel: "No vendor assigned",
  noneHint:
    "No contact on these, for example depreciation or a charge not matched yet. Assign a vendor in Transactions where one applies.",
  mainHeading: "Paid to",
  mainTotal: "Total paid to contacts",
  countLabel: "Contacts paid",
  averageLabel: "Per contact paid",
  mainTags: ["employee", "contractor", "government", "financial", "vendor", "owner"],
};

/** Notes the exports and the coverage panel carry about how the report is built. */
export const CUSTOMER_NOTES = [
  "Each line is the income recorded with that contact; together the lines add up to total income.",
  "Clients are contacts with the client role, plus contacts not yet given a role. Contacts with other roles (a bank paying interest, a store payout) are listed under Other income.",
  "Income with no contact is listed as No client assigned until a contact is added to it.",
];

const ROLE_TAGS: Record<string, string> = {
  client: "Client",
  vendor: "Vendor",
  contractor: "Contractor",
  employee: "Payroll",
  owner: "Owner",
  government: "Government",
  financial: "Bank",
};

export interface ContactRow {
  id: string;
  name: string;
  group: ContactGroup;
  amount: bigint;
  /** The comparison period's figure; zero without a comparison. */
  previous: bigint;
  /** Share of the period's total, percent. */
  share: number;
  /** The role shown beside a contact outside the main group. */
  tag?: string;
  filter: Partial<ReportFilter>;
  compareFilter?: Partial<ReportFilter>;
}

const amountOf = (
  config: ContactConfig,
  d: ReportData["dimensions"][number],
  previous = false,
) =>
  big(
    config.side === "income"
      ? previous
        ? d.compare_income_cents
        : d.income_cents
      : previous
        ? d.compare_expense_cents
        : d.expense_cents,
  );

export const totalOf = (config: ContactConfig, data: ReportData, previous = false) =>
  big(
    config.side === "income"
      ? (previous ? data.comparison : data.totals).income_cents
      : (previous ? data.comparison : data.totals).expense_cents,
  );

/**
 * Every contact with money on this side in either period: the main group
 * biggest first, then the other sources, then money with no contact.
 */
export function contactRows(
  data: ReportData,
  parties: ContactParty[],
  config: ContactConfig,
): ContactRow[] {
  const comparing = !!data.filter.compare_from;
  const roles = new Map(parties.map((p) => [p.id, p.roles ?? []]));
  const total = totalOf(config, data);
  const scope = periodScope(data);
  const types = [config.side] as ("income" | "expense")[];
  const rows: ContactRow[] = data.dimensions
    .filter((d) => d.kind === "payee")
    .map((d) => {
      const amount = amountOf(config, d),
        previous = comparing ? amountOf(config, d, true) : ZERO;
      const contactRoles = roles.get(d.id) ?? [];
      const group: ContactGroup =
        d.id === NO_CONTACT ? "none" : config.isMain(contactRoles) ? "main" : "other";
      const role =
        group === "main"
          ? config.mainTags.find((r) => contactRoles.includes(r))
          : contactRoles[0];
      return {
        id: d.id,
        name: group === "none" ? config.noneLabel : d.name,
        group,
        amount,
        previous,
        share: percentOf(amount, total) ?? 0,
        tag: role ? ROLE_TAGS[role] : undefined,
        filter: { ...scope, payee: d.id, account_types: types },
        compareFilter: comparing
          ? {
              ...scope,
              from: data.filter.compare_from,
              to: data.filter.compare_to,
              payee: d.id,
              account_types: types,
            }
          : undefined,
      };
    })
    .filter((r) => r.amount !== ZERO || r.previous !== ZERO);
  const order: ContactGroup[] = ["main", "other", "none"];
  return order.flatMap((g) => rows.filter((r) => r.group === g).sort(byAmount));
}

export interface ContactSummary {
  total: bigint;
  previousTotal: bigint;
  /** The main group: everything from clients. */
  mainTotal: bigint;
  previousMainTotal: bigint;
  otherTotal: bigint;
  noneTotal: bigint;
  /** Clients with money this period, and in the comparison period. */
  paying: number;
  previousPaying: number;
  top: ContactRow | null;
  /** The top client's share of the total, percent. */
  topShare: number | null;
  previousTopShare: number | null;
  /** The top three clients' share of the total, percent. */
  topThreeShare: number | null;
  average: bigint | null;
  previousAverage: bigint | null;
  /** With a comparison: clients new this period, back again, and gone. */
  newcomers: ContactRow[];
  returning: ContactRow[];
  gone: ContactRow[];
}

export function contactSummary(
  rows: ContactRow[],
  data: ReportData,
  config: ContactConfig,
): ContactSummary {
  const comparing = !!data.filter.compare_from;
  const total = totalOf(config, data),
    previousTotal = comparing ? totalOf(config, data, true) : ZERO;
  const main = rows.filter((r) => r.group === "main");
  const sum = (list: ContactRow[], previous = false) =>
    list.reduce((s, r) => s + (previous ? r.previous : r.amount), ZERO);
  const paying = main.filter((r) => r.amount > ZERO),
    previousPaying = main.filter((r) => r.previous > ZERO);
  const mainTotal = sum(main),
    previousMainTotal = sum(main, true);
  const top = paying[0] ?? null;
  const previousTop = [...previousPaying].sort((a, b) =>
    b.previous > a.previous ? 1 : b.previous < a.previous ? -1 : 0,
  )[0];
  return {
    total,
    previousTotal,
    mainTotal,
    previousMainTotal,
    otherTotal: sum(rows.filter((r) => r.group === "other")),
    noneTotal: sum(rows.filter((r) => r.group === "none")),
    paying: paying.length,
    previousPaying: previousPaying.length,
    top,
    topShare: top ? percentOf(top.amount, total) : null,
    previousTopShare:
      comparing && previousTop ? percentOf(previousTop.previous, previousTotal) : null,
    topThreeShare: paying.length
      ? percentOf(sum(paying.slice(0, 3)), total)
      : null,
    average: paying.length ? sum(paying) / BigInt(paying.length) : null,
    previousAverage:
      comparing && previousPaying.length
        ? sum(previousPaying, true) / BigInt(previousPaying.length)
        : null,
    newcomers: comparing ? paying.filter((r) => r.previous <= ZERO) : [],
    returning: comparing ? paying.filter((r) => r.previous > ZERO) : [],
    gone: comparing
      ? previousPaying
          .filter((r) => r.amount <= ZERO)
          .sort((a, b) => (b.previous > a.previous ? 1 : b.previous < a.previous ? -1 : 0))
      : [],
  };
}

/* ------------------------------------------------------------------------ */
/* Concentration                                                             */
/* ------------------------------------------------------------------------ */

export interface Concentration {
  level: "high" | "moderate" | "spread";
  /** "Northwind Traders brought in 41% of your income, and your top 3 brought in 82%." */
  sentence: string;
  /** What that means, in plain words. */
  note: string;
}

const pct = (share: number) => `${Math.round(share)}%`;

export function concentrationOf(
  summary: ContactSummary,
  config: ContactConfig,
): Concentration | null {
  if (!summary.top || summary.topShare === null) return null;
  const share = summary.topShare;
  const verb = config.side === "income" ? "brought in" : "took";
  const of = config.side === "income" ? "your income" : "your spending";
  const three =
    summary.paying > 3 && summary.topThreeShare !== null
      ? `, and your top 3 ${config.many} ${verb} ${pct(summary.topThreeShare)}`
      : "";
  const sentence = `${summary.top.name} ${verb} ${pct(share)} of ${of}${three}.`;
  if (share >= 50)
    return {
      level: "high",
      sentence,
      note: `More than half of ${of} rides on one ${config.one}. Losing them would cut it by more than half, so a second anchor ${config.one} is worth the effort.`,
    };
  if (share >= 25)
    return {
      level: "moderate",
      sentence,
      note: `One ${config.one} is a big part of ${of}. Losing them would hurt, but not stop the business.`,
    };
  return {
    level: "spread",
    sentence,
    note: `No single ${config.one} is more than a quarter of ${of}, so losing any one of them is manageable.`,
  };
}

export interface Dependency {
  /** How few main contacts make up half the total; null when they never reach it. */
  half: number | null;
  /** The total without the top contact. */
  withoutTop: bigint | null;
  /** Main contacts each under 5% of the total, and their share together. */
  small: number;
  smallShare: number;
}

/** Plain measures of how spread the money is across the main contacts. */
export function dependencyOf(rows: ContactRow[], summary: ContactSummary): Dependency {
  const paying = rows.filter((r) => r.group === "main" && r.amount > ZERO);
  let running = ZERO,
    half: number | null = null;
  for (let i = 0; i < paying.length; i++) {
    running += paying[i].amount;
    if (running * BigInt(2) >= summary.total && summary.total > ZERO) {
      half = i + 1;
      break;
    }
  }
  const small = paying.filter((r) => r.share < 5);
  return {
    half,
    withoutTop: summary.top ? summary.total - summary.top.amount : null,
    small: small.length,
    smallShare: small.reduce((s, r) => s + r.share, 0),
  };
}

/* ------------------------------------------------------------------------ */
/* Ranked rows for the cards                                                 */
/* ------------------------------------------------------------------------ */

/** "+12.0% vs last year", "New this period", or nothing without a comparison. */
export function rowChange(row: ContactRow, short: string | null): string | undefined {
  if (!short) return undefined;
  if (row.previous <= ZERO && row.amount > ZERO) return "New this period";
  if (row.amount <= ZERO && row.previous > ZERO) return `Nothing this period, ${formatCents(row.previous)} ${short}`;
  if (row.previous === ZERO) return undefined;
  if (row.amount === row.previous) return `Same as ${short}`;
  const percent = Number(((row.amount - row.previous) * BigInt(1000)) / abs(row.previous)) / 10;
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}% vs ${short}`;
}

/** The main group as ranked rows, the smaller ones folded into one. */
export function rankedRows(
  rows: ContactRow[],
  group: ContactGroup | ContactGroup[],
  short: string | null,
  config: ContactConfig,
  limit = 10,
): (BreakdownRow & { hint?: string })[] {
  const groups = Array.isArray(group) ? group : [group];
  const list = rows
    .filter((r) => groups.includes(r.group) && r.amount !== ZERO)
    .map((r) => ({
      key: r.id,
      label: r.name,
      amount: r.amount,
      share: r.share,
      tag: r.tag,
      hint: r.group === "none" ? config.noneHint : rowChange(r, short),
      filter: r.filter,
    }));
  if (list.length <= limit + 1) return list;
  const rest = list.slice(limit);
  return [
    ...list.slice(0, limit),
    {
      key: "rest",
      label: `${rest.length} more ${config.many}`,
      amount: rest.reduce((s, r) => s + r.amount, ZERO),
      share: rest.reduce((s, r) => s + r.share, 0),
      count: rest.length,
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* Month by month                                                            */
/* ------------------------------------------------------------------------ */

/** How many contacts get a month series of their own. */
export const SERIES_LIMIT = 40;
/** How many named contacts the stacked chart shows before "Everyone else". */
export const STACKED = 4;

/** The contacts that need a month series: every paying main contact, up to the limit. */
export function seriesIds(rows: ContactRow[]): string[] {
  return rows
    .filter((r) => r.group === "main" && r.amount > ZERO)
    .slice(0, SERIES_LIMIT)
    .map((r) => r.id);
}

/** One contact's months: the report's scope narrowed to that contact. */
export function seriesFilter(filter: ReportFilter, id: string): ReportFilter {
  const one: ReportFilter = { ...filter, payee: id, offset: 0 };
  delete one.compare_from;
  delete one.compare_to;
  return one;
}

export interface ContactMonth {
  month: string;
  at: string;
  partial: { from: string; to: string } | null;
  total: bigint;
  /** The stacked contacts' amounts, in `stack` order, then everyone else. */
  stacked: bigint[];
  rest: bigint;
  /** Main contacts with money this month; null while their series are missing. */
  paying: number | null;
  /** The period's top contact's share of this month's total, percent. */
  topShare: number | null;
  /** The main group's money per paying contact this month. */
  average: bigint | null;
}

export interface ContactMonths {
  months: ContactMonth[];
  /** The contacts with a stack of their own, biggest first. */
  stack: { id: string; name: string }[];
  /** Every paying main contact has its series. */
  complete: boolean;
  /** More main contacts paid than have a series of their own. */
  capped: boolean;
}

const amountIn = (config: ContactConfig, row: BreakdownData["rows"][number] | undefined) =>
  big(config.side === "income" ? row?.income_cents : row?.expense_cents);

export function contactMonths(
  data: ReportData,
  rows: ContactRow[],
  series: Map<string, BreakdownData>,
  config: ContactConfig,
): ContactMonths {
  const paying = rows.filter((r) => r.group === "main" && r.amount > ZERO);
  const ids = seriesIds(rows);
  const stack = paying.slice(0, STACKED).filter((r) => series.has(r.id));
  const complete = paying.length <= SERIES_LIMIT && ids.every((id) => series.has(id));
  const byMonth = new Map(
    ids.map((id) => [
      id,
      new Map((series.get(id)?.rows ?? []).map((r) => [r.key.slice(0, 7), amountIn(config, r)])),
    ]),
  );
  const { from, to } = data.filter;
  const months = data.monthly.map((m) => {
    const key = m.month.slice(0, 7);
    const month = `${key}-01`;
    const last = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0))
      .toISOString()
      .slice(0, 10);
    const start = from > month ? from : month,
      end = to < last ? to : last;
    const total = big(config.side === "income" ? m.income_cents : m.expense_cents);
    const stacked = stack.map((r) => byMonth.get(r.id)?.get(key) ?? ZERO);
    const values = ids.map((id) => byMonth.get(id)?.get(key) ?? ZERO);
    const count = values.filter((v) => v > ZERO).length;
    const mainAmount = values.reduce((s, v) => s + v, ZERO);
    return {
      month,
      at: end,
      partial: start !== month || end !== last ? { from: start, to: end } : null,
      total,
      stacked,
      rest: total - stacked.reduce((s, v) => s + v, ZERO),
      paying: complete ? count : null,
      topShare:
        stack[0] && total > ZERO ? percentOf(stacked[0], total) : null,
      average: complete && count ? mainAmount / BigInt(count) : complete ? ZERO : null,
    };
  });
  return {
    months,
    stack: stack.map((r) => ({ id: r.id, name: r.name })),
    complete,
    capped: paying.length > SERIES_LIMIT,
  };
}

/* ------------------------------------------------------------------------ */
/* The statement                                                             */
/* ------------------------------------------------------------------------ */

/**
 * The formal table: the main group (every contact, or the biggest ten and
 * the rest folded when `details` is off), the other sources, money with no
 * contact, and the total. Comparison and change sit beside when comparing.
 */
export function contactStatement(
  rows: ContactRow[],
  data: ReportData,
  config: ContactConfig,
  details: boolean,
): StatementRow[] {
  const comparing = !!data.filter.compare_from;
  const out: StatementRow[] = [];
  const values = (now: bigint, then: bigint) =>
    comparing ? [now.toString(), then.toString(), (now - then).toString()] : [now.toString()];
  const side = config.side === "income" ? "income" : "expense";
  const push = (
    key: string,
    label: string,
    kind: StatementRow["kind"],
    section: string,
    now: bigint,
    then: bigint,
    detail?: (Partial<ReportFilter> | undefined)[],
    indent = false,
  ) =>
    out.push({
      key,
      label,
      kind,
      section,
      side: kind === "total" ? "result" : side,
      values: kind === "heading" ? [] : values(now, then),
      detail,
      indent,
    });
  const sum = (list: ContactRow[], previous = false) =>
    list.reduce((s, r) => s + (previous ? r.previous : r.amount), ZERO);
  const scope = periodScope(data);
  const types = [config.side] as ("income" | "expense")[];
  const section = (title: string, list: ContactRow[], subtotal: string | null, fold: boolean) => {
    if (!list.length) return;
    out.push({ key: `h-${title}`, label: title, kind: "heading", section: title, side, values: [] });
    const shown = fold && list.length > 11 ? list.slice(0, 10) : list;
    for (const r of shown)
      push(r.id, r.name, "account", title, r.amount, r.previous, [r.filter, r.compareFilter], true);
    if (shown.length < list.length) {
      const rest = list.slice(shown.length);
      push(
        `rest-${title}`,
        `${rest.length} more ${config.many}`,
        "account",
        title,
        sum(rest),
        sum(rest, true),
        undefined,
        true,
      );
    }
    if (subtotal) push(`t-${title}`, subtotal, "subtotal", title, sum(list), sum(list, true));
  };
  section(config.mainHeading, rows.filter((r) => r.group === "main"), config.mainTotal, !details);
  section(
    config.otherHeading,
    rows.filter((r) => r.group !== "main"),
    `Total ${config.otherHeading.toLowerCase()}`,
    false,
  );
  push(
    "total",
    config.side === "income" ? "Total income" : "Total expenses",
    "total",
    "Total",
    totalOf(config, data),
    comparing ? totalOf(config, data, true) : ZERO,
    [
      { ...scope, account_types: types },
      comparing
        ? {
            ...scope,
            from: data.filter.compare_from,
            to: data.filter.compare_to,
            account_types: types,
          }
        : undefined,
    ],
  );
  return out;
}

/** Whether nothing on this side moved in either period. */
export function isEmptyContactReport(data: ReportData, config: ContactConfig): boolean {
  return (
    totalOf(config, data) === ZERO &&
    (!data.filter.compare_from || totalOf(config, data, true) === ZERO) &&
    !data.dimensions.some((d) => amountOf(config, d) !== ZERO)
  );
}

/* ------------------------------------------------------------------------ */
/* Spending by role                                                          */
/* ------------------------------------------------------------------------ */

export type SpendRole =
  | "vendor"
  | "contractor"
  | "payroll"
  | "government"
  | "financial"
  | "unroled"
  | "clients"
  | "none";

export const SPEND_ROLE_LABELS: Record<SpendRole, string> = {
  vendor: "Vendors",
  contractor: "Contractors",
  payroll: "Payroll",
  government: "Taxes and government",
  financial: "Banks and fees",
  unroled: "No role yet",
  clients: "Paid to clients",
  none: "No vendor assigned",
};

/** Which kind of payee a contact is, from its roles, for spending. */
export function spendRoleOf(row: Pick<ContactRow, "group">, roles: string[]): SpendRole {
  if (row.group === "none") return "none";
  if (row.group === "other") return "clients";
  if (roles.includes("employee") || roles.includes("owner")) return "payroll";
  if (roles.includes("contractor")) return "contractor";
  if (roles.includes("government")) return "government";
  if (roles.includes("financial")) return "financial";
  if (roles.includes("vendor")) return "vendor";
  return "unroled";
}

export interface RoleShare {
  role: SpendRole;
  label: string;
  amount: bigint;
  share: number;
  count: number;
  /** The biggest payees in the group, for the row's hint. */
  names: string[];
}

/** The period's spending by kind of payee, biggest first; every dollar on a line. */
export function spendByRole(
  rows: ContactRow[],
  parties: ContactParty[],
  total: bigint,
): RoleShare[] {
  const roles = new Map(parties.map((p) => [p.id, p.roles ?? []]));
  const groups = new Map<SpendRole, ContactRow[]>();
  for (const r of rows) {
    if (r.amount === ZERO) continue;
    const role = spendRoleOf(r, roles.get(r.id) ?? []);
    groups.set(role, [...(groups.get(role) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([role, list]) => {
      const amount = list.reduce((s, r) => s + r.amount, ZERO);
      return {
        role,
        label: SPEND_ROLE_LABELS[role],
        amount,
        share: percentOf(amount, total) ?? 0,
        count: list.length,
        names: list.slice(0, 3).map((r) => r.name),
      };
    })
    .sort(byAmount);
}

/** The one role that sorts a contact's spending, for the export's role list. */
export function primaryRole(roles: string[]): string | null {
  return (
    ["employee", "owner", "contractor", "government", "financial", "vendor", "client"].find((r) =>
      roles.includes(r),
    ) ?? null
  );
}

/** Notes the exports and the coverage panel carry about how the report is built. */
export const VENDOR_NOTES = [
  "Each line is the spending recorded with that contact; together the lines add up to total expenses.",
  "Owner draws, transfers between your own accounts and card payments are not expenses, so they are not on this report.",
  "Roles sort the spending: vendors, contractors, payroll, taxes and government, and banks. A contact that is only a client (a refund, say) is listed under Other spending.",
  "Spending with no contact is listed as No vendor assigned until a contact is added to it.",
];
