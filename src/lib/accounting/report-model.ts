import type { ReportAccount, ReportData, ReportFilter } from "./reports";

export const reportCatalog = [
  {
    id: "profit-loss",
    title: "Profit & loss",
    description:
      "Income, costs and profit, with account detail and period comparisons.",
    group: "Financial statements",
  },
  {
    id: "balance-sheet",
    title: "Balance sheet",
    description: "What the company owns, owes and retains as of a chosen date.",
    group: "Financial statements",
  },
  {
    id: "cash-flow",
    title: "Bank cash movements",
    description:
      "Follow cash from opening to closing, including transfers and unresolved classifications.",
    group: "Financial statements",
  },
  {
    id: "customer-income",
    title: "Income by customer",
    description:
      "Recognized revenue and directly attributed costs for each customer.",
    group: "Business performance",
  },
  {
    id: "vendor-expenses",
    title: "Expenses by vendor",
    description: "Review spending by payee, including unassigned expenses.",
    group: "Business performance",
  },
  {
    id: "trial-balance",
    title: "Trial balance",
    description:
      "Opening balances, debits, credits and closing balances for every account.",
    group: "Detailed accounting",
  },
  {
    id: "general-ledger",
    title: "General ledger",
    description:
      "Every contributing journal line, with running balances and source evidence.",
    group: "Detailed accounting",
  },
  {
    id: "owner-activity",
    title: "Owner activity",
    description:
      "Contributions, distributions and shareholder balances in the books.",
    group: "Detailed accounting",
  },
] as const;
export type ReportId = (typeof reportCatalog)[number]["id"];
export type ReportRow = {
  key: string;
  label: string;
  kind: "heading" | "account" | "subtotal" | "total";
  values: string[];
  detail?: (Partial<ReportFilter> | undefined)[];
  entryFilter?: Partial<ReportFilter>;
  indent?: boolean;
  code?: string;
};
export interface ReportModel {
  id: ReportId;
  title: string;
  description: string;
  columns: string[];
  rows: ReportRow[];
  footnotes: string[];
  comparison: boolean;
}
const zero = BigInt(0);
const add = (...values: string[]) =>
  values.reduce((s, v) => s + BigInt(v), zero).toString();
const subtract = (a: string, b: string) => (BigInt(a) - BigInt(b)).toString();
const sum = (
  accounts: ReportAccount[],
  field: keyof ReportAccount,
  sign = BigInt(1),
) =>
  accounts
    .reduce((s, a) => s + BigInt(String(a[field])) * sign, zero)
    .toString();
export function isCostOfSales(a: ReportAccount) {
  return (
    a.account_type === "expense" &&
    [
      "cogs",
      "cost_of_goods_sold",
      "cost of goods sold",
      "direct_costs",
    ].includes(a.subtype.toLowerCase())
  );
}
export function ratioPercent(value: string, total: string): string | null {
  const base = BigInt(total);
  if (!base) return null;
  const ratio = (BigInt(value) * BigInt(10000)) / base;
  const negative = ratio < BigInt(0),
    absolute = negative ? -ratio : ratio;
  return `${negative ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}%`;
}
/** Render the exact SQL result; all money stays integer cents throughout presentation. */
export function buildReportModel(
  id: ReportId,
  data: ReportData,
  showZero = false,
): ReportModel {
  const meta = reportCatalog.find((r) => r.id === id)!;
  const comparison = !!data.filter.compare_from;
  const rows: ReportRow[] = [];
  const t = data.totals,
    p = data.comparison;
  const base: Partial<ReportFilter> = { ...data.filter, offset: 0 };
  delete base.compare_from;
  delete base.compare_to;
  const compareBase: Partial<ReportFilter> = {
    ...base,
    from: data.filter.compare_from ?? data.filter.from,
    to: data.filter.compare_to ?? data.filter.to,
  };
  const yearStart = (date: string) => `${date.slice(0, 4)}-01-01`;
  const priorEnd = (date: string) => `${Number(date.slice(0, 4)) - 1}-12-31`;
  const scope = (
    which: "period" | "asof" | "prior" | "year",
    previous = false,
  ): Partial<ReportFilter> => {
    const b = previous ? compareBase : base,
      to = b.to!;
    return {
      ...b,
      from:
        which === "asof" || which === "prior"
          ? "1900-01-01"
          : which === "year"
            ? yearStart(to)
            : b.from,
      to: which === "prior" ? priorEnd(to) : to,
    };
  };
  function heading(label: string) {
    rows.push({
      key: `heading-${rows.length}`,
      label,
      kind: "heading",
      values: [],
    });
  }
  function moneyRow(
    label: string,
    current: string,
    previous: string,
    kind: ReportRow["kind"] = "account",
    filter?: Partial<ReportFilter>,
    previousFilter?: Partial<ReportFilter>,
    account?: ReportAccount,
  ) {
    rows.push({
      key: account?.id ?? `${kind}-${rows.length}`,
      label,
      kind,
      values: comparison
        ? [current, previous, subtract(current, previous)]
        : [current],
      detail: filter
        ? [filter, previousFilter ?? { ...filter, ...compareBase }]
        : undefined,
      indent: !!account?.parent_account_id,
      code: account?.code,
    });
  }
  function accounts(
    list: ReportAccount[],
    field: "period_cents" | "ending_cents",
    which: "period" | "asof",
    sign: bigint,
  ) {
    const previousField =
      field === "period_cents"
        ? "compare_period_cents"
        : "compare_ending_cents";
    let group = "";
    for (const a of [...list].sort(
      (a, b) =>
        (a.parent_name ?? "").localeCompare(b.parent_name ?? "") ||
        a.code.localeCompare(b.code) ||
        a.name.localeCompare(b.name),
    )) {
      const current = (BigInt(a[field]) * sign).toString(),
        previous = (BigInt(a[previousField]) * sign).toString();
      if (!showZero && current === "0" && (!comparison || previous === "0"))
        continue;
      if (a.parent_name && a.parent_name !== group) {
        heading(a.parent_name);
        group = a.parent_name;
      }
      moneyRow(
        a.name,
        current,
        previous,
        "account",
        { ...scope(which), account_ids: [a.id] },
        { ...scope(which, true), account_ids: [a.id] },
        a,
      );
    }
  }
  let columns = comparison
    ? ["Current period", "Comparison", "Change"]
    : ["Amount"];
  const footnotes = [
    "Amounts are USD. Only the selected book mode is included. Original entries and their reversals remain in the ledger.",
  ];
  if (id === "profit-loss") {
    const income = data.accounts.filter((a) => a.account_type === "income"),
      cogs = data.accounts.filter(isCostOfSales),
      expenses = data.accounts.filter(
        (a) => a.account_type === "expense" && !isCostOfSales(a),
      );
    heading("Income");
    accounts(income, "period_cents", "period", -BigInt(1));
    moneyRow(
      "Total income",
      t.income_cents,
      p.income_cents,
      "subtotal",
      { ...base, account_types: ["income"] },
      { ...compareBase, account_types: ["income"] },
    );
    heading("Cost of sales");
    accounts(cogs, "period_cents", "period", BigInt(1));
    moneyRow(
      "Total cost of sales",
      t.cogs_cents,
      p.cogs_cents,
      "subtotal",
      cogs.length ? { ...base, account_ids: cogs.map((a) => a.id) } : undefined,
      cogs.length
        ? { ...compareBase, account_ids: cogs.map((a) => a.id) }
        : undefined,
    );
    moneyRow(
      "Gross profit",
      subtract(t.income_cents, t.cogs_cents),
      subtract(p.income_cents, p.cogs_cents),
      "total",
      { ...base, account_ids: [...income, ...cogs].map((a) => a.id) },
      { ...compareBase, account_ids: [...income, ...cogs].map((a) => a.id) },
    );
    heading("Operating expenses");
    accounts(expenses, "period_cents", "period", BigInt(1));
    moneyRow(
      "Total operating expenses",
      subtract(t.expense_cents, t.cogs_cents),
      subtract(p.expense_cents, p.cogs_cents),
      "subtotal",
      expenses.length
        ? { ...base, account_ids: expenses.map((a) => a.id) }
        : undefined,
      expenses.length
        ? { ...compareBase, account_ids: expenses.map((a) => a.id) }
        : undefined,
    );
    moneyRow(
      "Net profit",
      t.net_cents,
      p.net_cents,
      "total",
      { ...base, account_types: ["income", "expense"] },
      { ...compareBase, account_types: ["income", "expense"] },
    );
    footnotes.push(
      "Cost of sales uses the reviewed cost-of-sales account subtype. Gross profit is income less those costs; net profit also includes operating expenses.",
    );
  } else if (id === "balance-sheet") {
    columns = comparison
      ? ["As of date", "Comparison date", "Change"]
      : ["Closing balance"];
    for (const [type, label, sign, total, prior] of [
      ["asset", "Assets", BigInt(1), t.assets_cents, p.assets_cents],
      [
        "liability",
        "Liabilities",
        -BigInt(1),
        t.liabilities_cents,
        p.liabilities_cents,
      ],
    ] as const) {
      heading(label);
      accounts(
        data.accounts.filter((a) => a.account_type === type),
        "ending_cents",
        "asof",
        sign,
      );
      moneyRow(
        `Total ${label.toLowerCase()}`,
        total,
        prior,
        "total",
        { ...scope("asof"), account_types: [type] },
        { ...scope("asof", true), account_types: [type] },
      );
    }
    heading("Equity");
    accounts(
      data.accounts.filter((a) => a.account_type === "equity"),
      "ending_cents",
      "asof",
      -BigInt(1),
    );
    moneyRow(
      "Profit from prior years",
      t.prior_cents,
      p.prior_cents,
      "account",
      { ...scope("prior"), account_types: ["income", "expense"] },
      { ...scope("prior", true), account_types: ["income", "expense"] },
    );
    moneyRow(
      "Current-year profit",
      t.year_cents,
      p.year_cents,
      "account",
      { ...scope("year"), account_types: ["income", "expense"] },
      { ...scope("year", true), account_types: ["income", "expense"] },
    );
    moneyRow(
      "Total equity",
      add(t.equity_cents, t.prior_cents, t.year_cents),
      add(p.equity_cents, p.prior_cents, p.year_cents),
      "total",
      { ...scope("asof"), account_types: ["equity", "income", "expense"] },
      {
        ...scope("asof", true),
        account_types: ["equity", "income", "expense"],
      },
    );
    moneyRow(
      "Total liabilities & equity",
      add(t.liabilities_cents, t.equity_cents, t.prior_cents, t.year_cents),
      add(p.liabilities_cents, p.equity_cents, p.prior_cents, p.year_cents),
      "total",
      {
        ...scope("asof"),
        account_types: ["liability", "equity", "income", "expense"],
      },
      {
        ...scope("asof", true),
        account_types: ["liability", "equity", "income", "expense"],
      },
    );
    footnotes.push(
      "Earlier income and expenses carry into computed profit from prior years. Verified opening retained earnings remain in their equity account. No annual closing journal is added.",
    );
  } else if (id === "cash-flow") {
    columns = ["Cash movement"];
    rows.push({
      key: "opening",
      label: "Opening bank & cash balance",
      kind: "subtotal",
      values: [t.cash_opening_cents],
    });
    const labels = {
      operating: "Operating activities",
      investing: "Investing activities",
      financing: "Financing activities",
      internal_transfer: "Internal transfers & transit",
      unclassified: "Needs classification",
    };
    for (const classification of [
      "operating",
      "investing",
      "financing",
      "internal_transfer",
      "unclassified",
    ] as const) {
      const c = data.cash.find((c) => c.classification === classification);
      rows.push({
        key: classification,
        label: labels[classification],
        kind: "account",
        values: [c?.amount_cents ?? "0"],
        detail: [{ ...base, cash_class: classification }],
      });
    }
    rows.push({
      key: "change",
      label: "Net change in bank cash",
      kind: "subtotal",
      values: [subtract(t.cash_ending_cents, t.cash_opening_cents)],
      detail: [
        {
          ...base,
          account_ids: data.accounts
            .filter((a) => ["bank", "cash"].includes(a.cash_kind))
            .map((a) => a.id),
        },
      ],
    });
    rows.push({
      key: "closing",
      label: "Closing bank & cash balance",
      kind: "total",
      values: [t.cash_ending_cents],
      detail: [
        {
          ...scope("asof"),
          account_ids: data.accounts
            .filter((a) => ["bank", "cash"].includes(a.cash_kind))
            .map((a) => a.id),
        },
      ],
    });
    footnotes.push(
      "This operational cash movement report is not a formal statement of cash flows. Card purchases affect debt; card payments affect bank cash. Transfers spanning the selected dates appear in transit. Unclassified movements require review before this report can be called fully classified.",
    );
  } else if (
    id === "trial-balance" ||
    id === "general-ledger" ||
    id === "owner-activity"
  ) {
    columns = ["Opening", "Debits", "Credits", "Closing"];
    const list =
      id === "owner-activity"
        ? data.accounts.filter(
            (a) =>
              a.account_type === "equity" ||
              [
                "due_to_shareholder",
                "due_from_shareholder",
                "shareholder_loan",
              ].includes(a.purpose ?? ""),
          )
        : data.accounts;
    for (const a of list) {
      if (
        !showZero &&
        [a.opening_cents, a.debit_cents, a.credit_cents, a.ending_cents].every(
          (v) => v === "0",
        )
      )
        continue;
      rows.push({
        key: a.id,
        label: a.name,
        kind: "account",
        values: [
          a.opening_cents,
          a.debit_cents,
          a.credit_cents,
          a.ending_cents,
        ],
        code: a.code,
        entryFilter: { ...base, account_ids: [a.id] },
        detail: [
          undefined,
          undefined,
          undefined,
          { ...scope("asof"), account_ids: [a.id] },
        ],
      });
    }
    if (id !== "owner-activity")
      rows.push({
        key: "total",
        label: "Total",
        kind: "total",
        values: [
          sum(list, "opening_cents"),
          sum(list, "debit_cents"),
          sum(list, "credit_cents"),
          sum(list, "ending_cents"),
        ],
      });
    footnotes.push(
      "Opening and closing balances use debit-positive, credit-negative signs. Debit and credit activity are displayed separately. Select an account to inspect its chronological running balance.",
    );
  } else {
    const kind = "payee";
    const vendor = id === "vendor-expenses";
    columns = vendor
      ? comparison
        ? ["Expenses", "Comparison", "Change"]
        : ["Expenses"]
      : comparison
        ? [
            "Income",
            "Attributed costs",
            "Contribution",
            "Prior income",
            "Prior costs",
          ]
        : ["Income", "Attributed costs", "Contribution"];
    for (const d of data.dimensions.filter((d) => d.kind === kind)) {
      const match = { ...base, [kind]: d.id },
        previous = { ...compareBase, [kind]: d.id };
      if (vendor) {
        if (
          !showZero &&
          d.expense_cents === "0" &&
          (!comparison || d.compare_expense_cents === "0")
        )
          continue;
        rows.push({
          key: d.id,
          label: d.name,
          kind: "account",
          values: comparison
            ? [
                d.expense_cents,
                d.compare_expense_cents,
                subtract(d.expense_cents, d.compare_expense_cents),
              ]
            : [d.expense_cents],
          detail: [
            { ...match, account_types: ["expense"] },
            { ...previous, account_types: ["expense"] },
          ],
        });
      } else {
        rows.push({
          key: d.id,
          label: d.name,
          kind: "account",
          values: [
            d.income_cents,
            d.expense_cents,
            subtract(d.income_cents, d.expense_cents),
            ...(comparison
              ? [d.compare_income_cents, d.compare_expense_cents]
              : []),
          ],
          detail: [
            { ...match, account_types: ["income"] },
            { ...match, account_types: ["expense"] },
            { ...match, account_types: ["income", "expense"] },
            { ...previous, account_types: ["income"] },
            { ...previous, account_types: ["expense"] },
          ],
        });
      }
    }
    rows.push({
      key: "total",
      label: "Total",
      kind: "total",
      values: vendor
        ? comparison
          ? [
              t.expense_cents,
              p.expense_cents,
              subtract(t.expense_cents, p.expense_cents),
            ]
          : [t.expense_cents]
        : [
            t.income_cents,
            t.expense_cents,
            t.net_cents,
            ...(comparison ? [p.income_cents, p.expense_cents] : []),
          ],
    });
    footnotes.push(
      vendor
        ? "Expenses without a payee remain visible as Unassigned."
        : "Contribution means income less directly attributed costs. Unassigned activity remains visible; this is not full project profitability without overhead allocation.",
    );
  }
  // Empty account sets should show zero, never turn an empty drill-down into the whole ledger.
  for (const row of rows)
    row.detail = row.detail?.map((d) =>
      d?.account_ids?.length === 0 || (d?.to && d.to < "1900-01-01")
        ? undefined
        : d,
    );
  return {
    id,
    title: meta.title,
    description: meta.description,
    columns,
    rows,
    footnotes,
    comparison:
      comparison &&
      [
        "profit-loss",
        "balance-sheet",
        "customer-income",
        "vendor-expenses",
      ].includes(id),
  };
}
