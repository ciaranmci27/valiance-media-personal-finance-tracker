import { buildReportModel, type ReportModel } from "./report-model";
import { centsToDecimal, formatCents } from "./money";
import type { DetailedReportSnapshot, ReportData } from "./reports";
import {
  changeOf,
  changeTone,
  compareLabel,
  percentLabel,
  percentOf,
  profitLossMonths,
  profitLossTotals,
  rangeLabel,
  statementRows,
} from "./profit-loss";
import {
  balanceCompareLabel,
  balanceStatementRows,
  balanceTotals,
  dateText,
  equityLines,
  ownershipSentence,
} from "./balance-sheet";
import {
  TRIAL_NOTES,
  TRIAL_TYPES,
  TYPE_LABELS,
  byType,
  sideLabel,
  trialChecks,
  trialLines,
  trialTotals,
  typeWord,
} from "./trial-balance";
import {
  OWNER_NOTES,
  equityRollForward,
  ownerNotes,
  ownerSentence,
  ownerStatement,
  ownerTotals,
} from "./owner-activity";
import {
  CUSTOMER_NOTES,
  CUSTOMER_REPORT,
  VENDOR_NOTES,
  VENDOR_REPORT,
  spendByRole,
  concentrationOf,
  contactRows,
  contactStatement,
  contactSummary,
  rankedRows,
} from "./contact-report";
import {
  CASH_FLOW_NOTES,
  afterBusinessSentence,
  bridgeSentence,
  cashBridge,
  cashFlowStatement,
  profitCashSentence,
  profitToCash,
} from "./cash-flow";
import {
  LEDGER_NOTES,
  ledgerAccounts,
  ledgerLines,
  ledgerSections,
  ledgerTotals,
  lineText,
} from "./general-ledger";

type Tone = "good" | "bad" | "flat";
/** One line of a waterfall panel; `amount` is in dollars for the bars. */
export interface PanelLine {
  label: string;
  value: string;
  amount: number;
  /** A few words under the label saying what the movement means. */
  hint?: string;
}

/** A ranked list on paper: each line's amount, its share, and a bar. */
export interface RankedPanel {
  title: string;
  sentence: string;
  /** A plain note under the sentence, e.g. the concentration risk. */
  note?: string | null;
  rows: {
    label: string;
    value: string;
    share: string;
    amount: number;
    tag?: string;
    hint?: string;
    /** This row's bar color, when it differs from the panel's. */
    tone?: "income" | "expense";
  }[];
  total: { label: string; value: string };
  /** The bars' color: income (teal, the default) or spending (copper). */
  tone?: "income" | "expense";
}

/**
 * A waterfall card: an optional starting bar, lines that each move the
 * running total on, and the total they add up to.
 */
export interface StatementPanel {
  title: string;
  sentence: string;
  start?: PanelLine;
  lines: PanelLine[];
  total: PanelLine;
  /** A closing sentence under the total. */
  footer?: string | null;
}

/**
 * The branded statement the PDF draws (export layout 2): headline tiles,
 * then a monthly chart (profit and loss) or waterfall panels (the balance
 * sheet's equity, the cash flow's bridge and profit vs cash), then the
 * statement. Figures are display strings; the CSV keeps plain numbers in
 * `rows`.
 */
export interface StatementDocument {
  /** "Jan 1 to Oct 3, 2026", or "As of Oct 3, 2026". */
  periodLabel: string;
  comparisonLabel: string | null;
  scopeNote: string | null;
  tiles: {
    label: string;
    value: string;
    change: string | null;
    tone: Tone;
    /** What the figure is, shown when there is no comparison line. */
    note: string;
  }[];
  /** The tile drawn as the headline figure. */
  accentTile: number;
  months: {
    month: string;
    income: number;
    expense: number;
    partial: { from: string; to: string } | null;
  }[];
  columns: string[];
  /** Whether the second column is each line's share (drawn smaller). */
  shareColumn: boolean;
  rows: {
    key: string;
    kind: "heading" | "account" | "subtotal" | "total";
    label: string;
    indent: boolean;
    /** A heading that names a statement section, not a parent account. */
    section: boolean;
    /** The row's date, drawn in the date column when there is one. */
    date?: string;
    cells: string[];
    tones: (Tone | null)[];
  }[];
  hiddenNote: string | null;
  /** Waterfall cards drawn between the tiles and the statement. */
  panels: StatementPanel[];
  /** Ranked lists (who paid you, other income) drawn before the statement. */
  ranked?: RankedPanel[];
  /** The statement's title on paper, "Statement" when absent. */
  statementTitle?: string;
  /** The first column's head, "Account" when absent. */
  labelHead?: string;
  /** A date column before the label, this wide in points (the general ledger). */
  dateWidth?: number;
  /** The trial balance's checks: what an accountant would ask about. */
  checks?: {
    title: string;
    /** Said when there is nothing to list. */
    empty: string;
    items: { tone: "look" | "info"; title: string; detail: string }[];
  };
}

export interface ReportDocument {
  title: string;
  company: string;
  metadata: [string, string][];
  columns: string[];
  numeric: boolean[];
  rows: {
    key: string;
    kind: "heading" | "account" | "subtotal" | "total";
    cells: string[];
  }[];
  notes: string[];
  snapshotId: string;
  /** Present for a report captured with layout 2. */
  statement?: StatementDocument;
}
/** CSV and PDF consume the same retained values and presentation options. */
export function reportDocument(
  snapshot: DetailedReportSnapshot,
): ReportDocument {
  const { data, options, ledger } = snapshot.payload;
  const model = buildReportModel(options.report_id, data, options.show_zero);
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const transactions = (n: number) =>
    `${n} ${n === 1 ? "transaction" : "transactions"}`;
  const metadata: [string, string][] = [
    ["Period", `${data.filter.from} through ${data.filter.to}`],
    ["Basis", data.basis],
    [
      "Scope",
      data.filter.mode === "working"
        ? `All activity, includes ${transactions(awaiting)} awaiting review`
        : "Reviewed only",
    ],
    ["Currency", data.currency],
    ["Data revision", data.revision],
    ["Report definition", String(data.definition_version)],
    ["Retained at", snapshot.created_at],
  ];
  if (data.filter.compare_from)
    metadata.push([
      "Comparison",
      `${data.filter.compare_from} through ${data.filter.compare_to}`,
    ]);
  if (data.filter.account_ids?.length)
    metadata.push([
      "Accounts",
      data.filter.account_ids
        .map((id) => data.accounts.find((a) => a.id === id)?.name ?? id)
        .join(", "),
    ]);
  for (const kind of ["payee"] as const) {
    if (data.filter[kind])
      metadata.push([
        "Contact filter",
        data.filter[kind] === "unassigned"
          ? "Unassigned"
          : (data.dimensions.find(
              (d) => d.kind === kind && d.id === data.filter[kind],
            )?.name ??
            `Selected ${kind.replaceAll("_", " ")} (no period activity)`),
      ]);
  }
  const notes = [
    ...model.footnotes,
    data.filter.mode === "working"
      ? `Includes ${transactions(awaiting)} awaiting review. Incomplete transactions not included: ${data.quality.unbalanced_drafts}.`
      : `Transactions awaiting review, not included: ${data.quality.draft_count}.`,
    `Reviewed lines still needing a category: ${data.quality.uncategorized_lines}. Bank cash lines needing classification: ${data.quality.unclassified_cash_lines}.`,
  ];
  if (options.report_id === "general-ledger" && options.layout === 2) {
    if (!ledger)
      throw new Error(
        "The retained general ledger is missing its journal lines.",
      );
    const statement = generalLedgerDocument(data, ledger, options.fiscal_start_month ?? 1);
    return {
      title: "General ledger",
      company: data.legal_name,
      metadata,
      ...statement.table,
      // The model's note explains the older opening, debits, credits, closing columns.
      notes: [...LEDGER_NOTES, ...notes.filter((n) => !n.startsWith("Opening and closing balances use"))],
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "general-ledger") {
    if (!ledger)
      throw new Error(
        "The retained general ledger is missing its journal lines.",
      );
    return {
      title: model.title,
      company: data.legal_name,
      metadata,
      columns: [
        "Date",
        "Description / source",
        "Account",
        "Debit",
        "Credit",
        "Account balance",
      ],
      numeric: [false, false, false, true, true, true],
      rows: ledger.map((l) => ({
        key: l.id,
        kind: "account",
        cells: [
          l.entry_date,
          `${l.memo}${l.line_memo ? " / " + l.line_memo : ""} (${l.primary_origin}, ${l.status})`,
          l.account_name,
          BigInt(l.amount_cents) > BigInt(0)
            ? centsToDecimal(l.amount_cents)
            : "",
          BigInt(l.amount_cents) < BigInt(0)
            ? centsToDecimal(-BigInt(l.amount_cents))
            : "",
          centsToDecimal(l.running_cents),
        ],
      })),
      notes,
      snapshotId: snapshot.id,
    };
  }
  if (options.report_id === "balance-sheet" && options.layout === 2) {
    const statement = balanceSheetDocument(data, model, options.details);
    const asOf: [string, string][] = [
      ["As of", data.filter.to],
      ...metadata.filter(([k]) => k !== "Period" && k !== "Comparison"),
      ...(data.filter.compare_to
        ? ([["Comparison", data.filter.compare_to]] as [string, string][])
        : []),
    ];
    return {
      title: model.title,
      company: data.legal_name,
      metadata: asOf,
      ...statement.table,
      notes,
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "cash-flow" && options.layout === 2) {
    const statement = cashFlowDocument(data, options.details);
    return {
      title: "Cash flow",
      company: data.legal_name,
      metadata,
      ...statement.table,
      // The model's note describes the older cash movement view, not this
      // statement, so the cash flow's own notes replace it.
      notes: [
        ...CASH_FLOW_NOTES,
        ...notes.filter((n) => !n.startsWith("This operational cash movement")),
      ],
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "trial-balance" && options.layout === 2) {
    const statement = trialBalanceDocument(data, options.details);
    const asOf: [string, string][] = [
      ["As of", data.filter.to],
      ...metadata.filter(([k]) => k !== "Period" && k !== "Comparison"),
      ...(data.filter.compare_to ? ([["Comparison", data.filter.compare_to]] as [string, string][]) : []),
    ];
    return {
      title: "Trial balance",
      company: data.legal_name,
      metadata: asOf,
      ...statement.table,
      // The model's note explains the older opening, debits, credits, closing columns.
      notes: [...TRIAL_NOTES, ...notes.filter((n) => !n.startsWith("Opening and closing balances use"))],
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "owner-activity" && options.layout === 2) {
    const statement = ownerActivityDocument(data, options.details);
    return {
      title: "Owner activity",
      company: data.legal_name,
      metadata,
      ...statement.table,
      // The model's note explains the older debit and credit columns.
      notes: [...OWNER_NOTES, ...notes.filter((n) => !n.startsWith("Opening and closing balances use"))],
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "vendor-expenses" && options.layout === 2) {
    const statement = vendorExpensesDocument(data, options.details, options.contact_roles ?? []);
    return {
      title: "Expenses by vendor",
      company: data.legal_name,
      metadata,
      ...statement.table,
      // The model's note about Unassigned is said in the vendor notes.
      notes: [
        ...VENDOR_NOTES,
        ...notes.filter((n) => !n.startsWith("Expenses without a contact")),
      ],
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "customer-income" && options.layout === 2) {
    const statement = customerIncomeDocument(data, options.details, options.other_contacts ?? []);
    return {
      title: "Income by customer",
      company: data.legal_name,
      metadata,
      ...statement.table,
      // The model's note describes the older contribution view.
      notes: [
        ...CUSTOMER_NOTES,
        ...notes.filter((n) => !n.startsWith("Contribution means")),
      ],
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  if (options.report_id === "profit-loss" && options.layout === 2) {
    const statement = profitLossDocument(data, model, options.details);
    return {
      title: model.title,
      company: data.legal_name,
      metadata,
      ...statement.table,
      // With no cost of sales the model's note about it explains nothing.
      notes: statement.hiddenNote
        ? [
            statement.hiddenNote,
            ...notes.filter((n) => !n.startsWith("Cost of sales uses")),
          ]
        : notes,
      snapshotId: snapshot.id,
      statement: statement.document,
    };
  }
  const hasTotals =
    ["profit-loss", "balance-sheet"].includes(model.id) &&
    model.rows.some((r) => r.kind === "total" || r.kind === "subtotal");
  return {
    title: model.title,
    company: data.legal_name,
    metadata,
    columns: ["Account / category", ...model.columns],
    numeric: [false, ...model.columns.map(() => true)],
    rows: model.rows
      .filter((r) => options.details || !hasTotals || r.kind !== "account")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [r.label, ...r.values.map(centsToDecimal)],
      })),
    notes,
    snapshotId: snapshot.id,
  };
}
const signedMoney = (value: bigint) =>
  value > BigInt(0) ? `+${formatCents(value)}` : formatCents(value);
const twoDecimals = (value: number | null) =>
  value === null ? "" : value.toFixed(2);
const panelLine = (label: string, cents: bigint, hint?: string): PanelLine => ({
  label,
  value: formatCents(cents),
  amount: Number(cents) / 100,
  ...(hint ? { hint } : {}),
});

/**
 * The profit and loss in export layout 2. The CSV gets every account as a
 * flat, spreadsheet-ready table (Section, Account, Amount, % of income, and
 * the comparison columns); the PDF gets the statement as the owner chose it
 * (summary or every account) with the headline figures and months.
 */
function profitLossDocument(
  data: ReportData,
  model: ReportModel,
  details: boolean,
) {
  const comparing = model.comparison;
  const { rows, costOfSalesHidden } = statementRows(model, data);
  const income = BigInt(data.totals.income_cents);
  const changePercent = (row: (typeof rows)[number]) => {
    const previous = BigInt(row.values[1]);
    return percentOf(
      BigInt(row.values[2]),
      previous < BigInt(0) ? -previous : previous,
    );
  };
  const columns = [
    "Section",
    "Account",
    "Amount",
    "% of income",
    ...(comparing ? ["Comparison", "Change", "Change %"] : []),
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 2),
    rows: rows
      .filter((r) => r.kind !== "heading")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [
          r.kind === "total" ? r.label : r.section,
          r.kind === "total" ? "" : r.label,
          centsToDecimal(r.values[0]),
          twoDecimals(percentOf(BigInt(r.values[0]), income)),
          ...(comparing
            ? [
                centsToDecimal(r.values[1]),
                centsToDecimal(r.values[2]),
                twoDecimals(changePercent(r)),
              ]
            : []),
        ],
      })),
  };
  const { current, previous } = profitLossTotals(data);
  const compared = compareLabel(data.filter);
  const tileChange = (
    now: bigint,
    before: bigint | undefined,
    invert = false,
  ): { change: string | null; tone: Tone } => {
    if (before === undefined || !compared) return { change: null, tone: "flat" };
    const c = changeOf(now, before);
    if (c.kind === "none") return { change: "No change", tone: "flat" };
    return {
      change:
        c.kind === "near-zero"
          ? `${signedMoney(c.diff)} vs almost nothing`
          : `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${compared.short}`,
      tone: changeTone(c.diff, invert),
    };
  };
  const marginChange = (): { change: string | null; tone: Tone } => {
    if (!previous || !compared) return { change: null, tone: "flat" };
    if (current.margin === null || previous.margin === null)
      return {
        change: previous.margin === null ? `No income in ${compared.short}` : null,
        tone: "flat",
      };
    const points = current.margin - previous.margin;
    return {
      change: `${points > 0 ? "+" : ""}${points.toFixed(1)} pts vs ${compared.short}`,
      tone: points > 0 ? "good" : points < 0 ? "bad" : "flat",
    };
  };
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const document: StatementDocument = {
    periodLabel: rangeLabel(data.filter.from, data.filter.to),
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      {
        label: "Income",
        value: formatCents(current.income),
        note: "Money in",
        ...tileChange(current.income, previous?.income),
      },
      {
        label: "Expenses",
        value: formatCents(current.expense),
        note: "Money out",
        ...tileChange(current.expense, previous?.expense, true),
      },
      {
        label: current.net < BigInt(0) ? "Net loss" : "Net profit",
        value: formatCents(current.net),
        note: "Income less expenses",
        ...tileChange(current.net, previous?.net),
      },
      {
        label: "Margin",
        note: "Of income kept as profit",
        value: current.margin === null ? "No income" : `${current.margin.toFixed(1)}%`,
        ...marginChange(),
      },
    ],
    months: profitLossMonths(data).map((m) => ({
      month: m.month,
      income: Number(m.income) / 100,
      expense: Number(m.expense) / 100,
      partial: m.partial,
    })),
    accentTile: 2,
    columns: comparing
      ? ["Current", "% of income", "Comparison", "Change"]
      : ["Amount", "% of income"],
    shareColumn: true,
    rows: rows
      .filter((r) => details || r.kind !== "account")
      .map((r) => {
        const heading = r.kind === "heading";
        const change =
          comparing && !heading ? BigInt(r.values[2]) : BigInt(0);
        return {
          key: r.key,
          kind: r.kind,
          label: r.label,
          indent: !!r.indent,
          section: r.kind === "heading" && r.label === r.section,
          cells:
            r.kind === "heading"
              ? []
              : [
                  formatCents(r.values[0]),
                  heading ? "" : (percentLabel(BigInt(r.values[0]), income) ?? ""),
                  ...(comparing
                    ? [formatCents(r.values[1]), signedMoney(change)]
                    : []),
                ],
          tones:
            r.kind === "heading"
              ? []
              : [
                  r.kind === "total" && BigInt(r.values[0]) < BigInt(0)
                    ? ("bad" as Tone)
                    : null,
                  null,
                  ...(comparing
                    ? [null, changeTone(change, r.side === "expense")]
                    : []),
                ],
        };
      }),
    hiddenNote: costOfSalesHidden
      ? "No cost of sales in either period, so that section and gross profit are not shown."
      : null,
    panels: [],
  };
  return { table, document, hiddenNote: document.hiddenNote };
}

/**
 * The balance sheet in export layout 2: a flat CSV (Section, Account,
 * Balance, % of total assets, and Comparison and Change when comparing),
 * and for the PDF the headline tiles, the equity explained and the
 * statement as the owner chose it.
 */
function balanceSheetDocument(
  data: ReportData,
  model: ReportModel,
  details: boolean,
) {
  const comparing = model.comparison;
  const rows = balanceStatementRows(model);
  const { current, previous } = balanceTotals(data);
  const assets = current.assets;
  const columns = [
    "Section",
    "Account",
    "Balance",
    "% of total assets",
    ...(comparing ? ["Comparison", "Change"] : []),
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 2),
    rows: rows
      .filter((r) => r.kind !== "heading")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [
          r.section,
          r.label,
          centsToDecimal(r.values[0]),
          twoDecimals(percentOf(BigInt(r.values[0]), assets)),
          ...(comparing
            ? [centsToDecimal(r.values[1]), centsToDecimal(r.values[2])]
            : []),
        ],
      })),
  };
  const compared = balanceCompareLabel(data.filter);
  const tile = (
    label: string,
    now: bigint,
    before: bigint | undefined,
    invert: boolean,
    note: string,
  ) => {
    if (before === undefined || !compared)
      return { label, value: formatCents(now), change: null, tone: "flat" as Tone, note };
    const c = changeOf(now, before);
    return {
      label,
      value: formatCents(now),
      note,
      change:
        c.kind === "none"
          ? "No change"
          : c.kind === "near-zero"
            ? `${signedMoney(c.diff)} vs almost nothing`
            : `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% since ${compared.short}`,
      tone: c.kind === "none" ? ("flat" as Tone) : changeTone(c.diff, invert),
    };
  };
  const equity = equityLines(data);
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const document: StatementDocument = {
    periodLabel: `As of ${dateText(data.filter.to)}`,
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      tile("Assets", current.assets, previous?.assets, false, "What the business has"),
      tile("Liabilities", current.liabilities, previous?.liabilities, true, "What it owes"),
      tile("Equity", current.equity, previous?.equity, false, "What is left for you"),
      tile("Cash position", current.cash, previous?.cash, false, "Bank and cash less cards"),
    ],
    accentTile: 2,
    months: [],
    columns: comparing
      ? ["As of", "% of assets", "Comparison", "Change"]
      : ["Balance", "% of assets"],
    shareColumn: true,
    rows: rows
      .filter((r) => details || r.kind !== "account")
      .map((r) => {
        const heading = r.kind === "heading";
        const change = comparing && !heading ? BigInt(r.values[2]) : BigInt(0);
        return {
          key: r.key,
          kind: r.kind,
          label: r.label,
          indent: !!r.indent,
          section: heading && r.label === r.section,
          cells: heading
            ? []
            : [
                formatCents(r.values[0]),
                percentLabel(BigInt(r.values[0]), assets) ?? "",
                ...(comparing ? [formatCents(r.values[1]), signedMoney(change)] : []),
              ],
          tones: heading
            ? []
            : [
                BigInt(r.values[0]) < BigInt(0) ? ("bad" as Tone) : null,
                null,
                ...(comparing ? [null, changeTone(change, r.side === "expense")] : []),
              ],
        };
      }),
    hiddenNote: null,
    panels: [
      {
        title: "Equity, explained",
        sentence: ownershipSentence(current),
        lines: equity.lines.map((l) => panelLine(l.label, l.amount)),
        total: panelLine("Total equity", equity.total),
      },
    ],
  };
  return { table, document };
}

/**
 * The cash flow in export layout 2: a flat CSV of the statement with every
 * account (Section, Line, Amount, and Comparison and Change when comparing),
 * and for the PDF the tiles, the bridge from starting to ending cash, profit
 * vs cash explained, and the statement as the owner chose it.
 */
function cashFlowDocument(data: ReportData, details: boolean) {
  const comparing = !!data.filter.compare_from;
  const every = cashFlowStatement(data, true);
  const columns = [
    "Section",
    "Line",
    "Amount",
    ...(comparing ? ["Comparison", "Change"] : []),
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 2),
    rows: every
      .filter((r) => r.kind !== "heading")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [r.section, r.label, ...r.values.map(centsToDecimal)],
      })),
  };
  const bridge = cashBridge(data);
  const t = bridge.totals;
  const story = profitToCash(data);
  const compared = compareLabel(data.filter);
  const startChange = (): { change: string | null; tone: Tone } => {
    if (!comparing || !compared) return { change: null, tone: "flat" };
    const c = changeOf(t.starting, BigInt(data.comparison.cash_opening_cents));
    if (c.kind === "none") return { change: "No change", tone: "flat" };
    return {
      change:
        c.kind === "near-zero"
          ? `${signedMoney(c.diff)} vs almost nothing`
          : `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${compared.short}`,
      tone: changeTone(c.diff, false),
    };
  };
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const rows = cashFlowStatement(data, details);
  const document: StatementDocument = {
    periodLabel: rangeLabel(data.filter.from, data.filter.to),
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      {
        label: "Starting cash",
        value: formatCents(t.starting),
        note: `On ${dateText(data.filter.from)}`,
        ...startChange(),
      },
      {
        label: "Cash in",
        value: formatCents(t.cashIn),
        note: "From the business, owner and loans",
        change: null,
        tone: "flat",
      },
      {
        label: "Cash out",
        value: formatCents(-t.cashOut),
        note: "To the owner, loans and equipment",
        change: null,
        tone: "flat",
      },
      {
        label: "Ending cash",
        value: formatCents(t.ending),
        note: `On ${dateText(data.filter.to)}`,
        // Ending cash carries the period's net change, as on the screen.
        change: `${signedMoney(t.change)} this period`,
        tone: t.change > BigInt(0) ? "good" : t.change < BigInt(0) ? "bad" : "flat",
      },
    ],
    accentTile: 3,
    months: [],
    columns: comparing ? ["This period", "Comparison", "Change"] : ["Amount"],
    shareColumn: false,
    rows: rows.map((r) => {
      const heading = r.kind === "heading";
      const change = comparing && !heading ? BigInt(r.values[2]) : BigInt(0);
      return {
        key: r.key,
        kind: r.kind,
        label: r.label,
        indent: !!r.indent,
        section: heading,
        cells: heading
          ? []
          : [
              formatCents(r.values[0]),
              ...(comparing ? [formatCents(r.values[1]), signedMoney(change)] : []),
            ],
        tones: heading
          ? []
          : [
              r.kind !== "account" && BigInt(r.values[0]) < BigInt(0)
                ? ("bad" as Tone)
                : null,
              ...(comparing ? [null, changeTone(change, false)] : []),
            ],
      };
    }),
    hiddenNote: null,
    panels: [
      {
        title: "Where your cash came from and went",
        sentence: bridgeSentence(t),
        start: panelLine("Starting cash", t.starting),
        lines: bridge.lines.map((l) => panelLine(l.label, l.amount)),
        total: panelLine("Ending cash", t.ending),
      },
      {
        title: "Profit vs cash, explained",
        sentence: profitCashSentence(t, story.lines),
        start: panelLine("Profit this period", story.profit),
        lines: story.lines.map((l) => panelLine(l.label, l.amount, l.hint)),
        total: panelLine("Cash from running the business", story.operating),
        footer: afterBusinessSentence(t),
      },
    ],
  };
  return { table, document };
}

/**
 * Income by customer in export layout 2: a flat CSV of every contact
 * (Section, Contact, Income, % of income, and Comparison, Change and
 * Change % when comparing), and for the PDF the tiles, who paid you with
 * the concentration note, other income, and the statement as the owner
 * chose it. The contacts that were not clients at export time come with the
 * snapshot's options, so the copy groups them as the screen did.
 */
function customerIncomeDocument(
  data: ReportData,
  details: boolean,
  otherContacts: { id: string; role: string }[],
) {
  const config = CUSTOMER_REPORT;
  const comparing = !!data.filter.compare_from;
  const parties = otherContacts.map((c) => ({ id: c.id, roles: [c.role] }));
  const rows = contactRows(data, parties, config);
  const s = contactSummary(rows, data, config);
  const every = contactStatement(rows, data, config, true);
  const total = s.total;
  const changePercent = (r: (typeof every)[number]) => {
    const previous = BigInt(r.values[1]);
    return percentOf(BigInt(r.values[2]), previous < BigInt(0) ? -previous : previous);
  };
  const columns = [
    "Section",
    "Contact",
    "Income",
    "% of income",
    ...(comparing ? ["Comparison", "Change", "Change %"] : []),
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 2),
    rows: every
      .filter((r) => r.kind !== "heading")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [
          r.section,
          r.label,
          centsToDecimal(r.values[0]),
          twoDecimals(percentOf(BigInt(r.values[0]), total)),
          ...(comparing
            ? [centsToDecimal(r.values[1]), centsToDecimal(r.values[2]), twoDecimals(changePercent(r))]
            : []),
        ],
      })),
  };
  const compared = compareLabel(data.filter);
  const short = compared?.short ?? null;
  const moneyChange = (now: bigint | null, before: bigint | null) => {
    if (now === null || before === null || !short) return { change: null, tone: "flat" as Tone };
    const c = changeOf(now, before);
    if (c.kind === "none") return { change: "No change", tone: "flat" as Tone };
    return {
      change:
        c.kind === "near-zero"
          ? `${signedMoney(c.diff)} vs almost nothing`
          : `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${short}`,
      tone: changeTone(c.diff),
    };
  };
  const countChange = () => {
    if (!short) return { change: null, tone: "flat" as Tone };
    const diff = s.paying - s.previousPaying;
    return diff === 0
      ? { change: "No change", tone: "flat" as Tone }
      : { change: `${diff > 0 ? "+" : ""}${diff} vs ${short}`, tone: (diff > 0 ? "good" : "bad") as Tone };
  };
  const shareChange = () => {
    if (!short || s.topShare === null || s.previousTopShare === null)
      return { change: null, tone: "flat" as Tone };
    const diff = Math.round((s.topShare - s.previousTopShare) * 10) / 10;
    return diff === 0
      ? { change: "No change", tone: "flat" as Tone }
      : {
          change: `${diff > 0 ? "+" : ""}${diff.toFixed(1)} pts vs ${short}`,
          // A bigger share for one client is more risk.
          tone: (diff > 0 ? "bad" : "good") as Tone,
        };
  };
  const others = rows.filter((r) => r.group === "other" && r.amount !== BigInt(0)).length;
  const focus = concentrationOf(s, config);
  const ranked = (list: ReturnType<typeof rankedRows>) =>
    list.map((r) => ({
      label: r.label,
      value: formatCents(r.amount),
      share: percentLabel(r.amount, total) ?? "",
      amount: Number(r.amount) / 100,
      ...(r.tag ? { tag: r.tag } : {}),
      ...(r.hint ? { hint: r.hint } : {}),
    }));
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const statementRows = contactStatement(rows, data, config, details);
  const otherRows = rankedRows(rows, ["other", "none"], short, config, 20);
  const document: StatementDocument = {
    periodLabel: rangeLabel(data.filter.from, data.filter.to),
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      {
        label: "Income",
        value: formatCents(s.total),
        note: `From ${s.paying} ${s.paying === 1 ? "client" : "clients"}${others ? ` and ${others} other ${others === 1 ? "source" : "sources"}` : ""}`,
        ...moneyChange(s.total, comparing ? s.previousTotal : null),
      },
      {
        label: "Paying clients",
        value: String(s.paying),
        note: "Clients who paid you",
        ...countChange(),
      },
      {
        label: "Top client's share",
        value: s.topShare === null ? "None" : `${s.topShare.toFixed(1)}%`,
        note: s.top ? s.top.name : "No client paid yet",
        ...shareChange(),
      },
      {
        label: "Average per client",
        value: s.average === null ? "None" : formatCents(s.average),
        note: "Client income per paying client",
        ...moneyChange(s.average, s.previousAverage),
      },
    ],
    accentTile: 0,
    months: [],
    columns: comparing
      ? ["This period", "% of income", "Comparison", "Change"]
      : ["Amount", "% of income"],
    shareColumn: true,
    rows: statementRows.map((r) => {
      const heading = r.kind === "heading";
      const change = comparing && !heading ? BigInt(r.values[2]) : BigInt(0);
      return {
        key: r.key,
        kind: r.kind,
        label: r.label,
        indent: !!r.indent,
        section: heading,
        cells: heading
          ? []
          : [
              formatCents(r.values[0]),
              percentLabel(BigInt(r.values[0]), total) ?? "",
              ...(comparing ? [formatCents(r.values[1]), signedMoney(change)] : []),
            ],
        tones: heading
          ? []
          : [
              BigInt(r.values[0]) < BigInt(0) ? ("bad" as Tone) : null,
              null,
              ...(comparing ? [null, changeTone(change)] : []),
            ],
      };
    }),
    hiddenNote: null,
    panels: [],
    ranked: [
      {
        title: "Who paid you",
        sentence: focus?.sentence ?? "No client paid you in this period.",
        note: focus?.note ?? null,
        rows: ranked(rankedRows(rows, "main", short, config, 15)),
        total: { label: "Total from clients", value: formatCents(s.mainTotal) },
      },
      ...(otherRows.length
        ? [
            {
              title: "Other income",
              sentence: "Money from contacts that are not clients, and income with no contact yet.",
              rows: ranked(otherRows),
              total: { label: "Total other income", value: formatCents(s.otherTotal + s.noneTotal) },
            },
          ]
        : []),
    ],
  };
  return { table, document };
}

/**
 * Expenses by vendor in export layout 2: a flat CSV of every contact
 * (Section, Contact, Role, Expenses, % of spending, and Comparison, Change
 * and Change % when comparing), and for the PDF the tiles, who you paid,
 * where the money goes by kind of payee, and the statement as the owner
 * chose it. Each contact's role at export time comes with the snapshot's
 * options, so the copy tags and sorts payees as the screen did. Repeat
 * charges come from a separate read of the books and stay on the screen.
 */
function vendorExpensesDocument(
  data: ReportData,
  details: boolean,
  contactRoles: { id: string; role: string }[],
) {
  const config = VENDOR_REPORT;
  const comparing = !!data.filter.compare_from;
  const parties = contactRoles.map((c) => ({ id: c.id, roles: [c.role] }));
  const roleOf = new Map(contactRoles.map((c) => [c.id, c.role]));
  const rows = contactRows(data, parties, config);
  const s = contactSummary(rows, data, config);
  const every = contactStatement(rows, data, config, true);
  const total = s.total;
  const roleWords: Record<string, string> = {
    employee: "Payroll",
    owner: "Payroll",
    contractor: "Contractor",
    government: "Government",
    financial: "Bank",
    vendor: "Vendor",
    client: "Client",
  };
  const changePercent = (r: (typeof every)[number]) => {
    const previous = BigInt(r.values[1]);
    return percentOf(BigInt(r.values[2]), previous < BigInt(0) ? -previous : previous);
  };
  const columns = [
    "Section",
    "Contact",
    "Role",
    "Expenses",
    "% of spending",
    ...(comparing ? ["Comparison", "Change", "Change %"] : []),
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 3),
    rows: every
      .filter((r) => r.kind !== "heading")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [
          r.section,
          r.label,
          r.kind === "account" ? (roleWords[roleOf.get(r.key) ?? ""] ?? "") : "",
          centsToDecimal(r.values[0]),
          twoDecimals(percentOf(BigInt(r.values[0]), total)),
          ...(comparing
            ? [centsToDecimal(r.values[1]), centsToDecimal(r.values[2]), twoDecimals(changePercent(r))]
            : []),
        ],
      })),
  };
  const compared = compareLabel(data.filter);
  const short = compared?.short ?? null;
  const roles = spendByRole(rows, parties, total);
  const contractors = roles.find((r) => r.role === "contractor");
  const spendChange = () => {
    if (!comparing || !short) return { change: null, tone: "flat" as Tone };
    const c = changeOf(s.total, s.previousTotal);
    if (c.kind === "none") return { change: "No change", tone: "flat" as Tone };
    return {
      change:
        c.kind === "near-zero"
          ? `${signedMoney(c.diff)} vs almost nothing`
          : `${c.percent > 0 ? "+" : ""}${c.percent.toFixed(1)}% vs ${short}`,
      // More spending is the bad direction.
      tone: changeTone(c.diff, true),
    };
  };
  const flat = (text: string | null) => ({ change: text, tone: "flat" as Tone });
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const statementRows = contactStatement(rows, data, config, details);
  const ranked = (list: ReturnType<typeof rankedRows>) =>
    list.map((r) => ({
      label: r.label,
      value: formatCents(r.amount),
      share: percentLabel(r.amount, total) ?? "",
      amount: Number(r.amount) / 100,
      ...(r.tag ? { tag: r.tag } : {}),
      ...(r.hint ? { hint: r.hint } : {}),
    }));
  const otherRows = rankedRows(rows, ["other", "none"], short, config, 20);
  const biggest = roles[0];
  const document: StatementDocument = {
    periodLabel: rangeLabel(data.filter.from, data.filter.to),
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      {
        label: "Spending",
        value: formatCents(s.total),
        note: `Paid to ${s.paying} ${s.paying === 1 ? "contact" : "contacts"}`,
        ...spendChange(),
      },
      {
        label: "Contacts paid",
        value: String(s.paying),
        note: "Vendors, contractors and others",
        ...flat(
          short
            ? s.paying === s.previousPaying
              ? "No change"
              : `${s.paying > s.previousPaying ? "+" : ""}${s.paying - s.previousPaying} vs ${short}`
            : null,
        ),
      },
      {
        label: "Biggest payee's share",
        value: s.topShare === null ? "None" : `${s.topShare.toFixed(1)}%`,
        note: s.top ? s.top.name : "Nobody paid yet",
        ...flat(null),
      },
      {
        label: "Contractors",
        value: formatCents(contractors?.amount ?? BigInt(0)),
        note: contractors
          ? `${contractors.count} ${contractors.count === 1 ? "contractor" : "contractors"} paid`
          : "No contractors paid",
        ...flat(null),
      },
    ],
    accentTile: 0,
    months: [],
    columns: comparing
      ? ["This period", "% of spending", "Comparison", "Change"]
      : ["Amount", "% of spending"],
    shareColumn: true,
    rows: statementRows.map((r) => {
      const heading = r.kind === "heading";
      const change = comparing && !heading ? BigInt(r.values[2]) : BigInt(0);
      return {
        key: r.key,
        kind: r.kind,
        label: r.label,
        indent: !!r.indent,
        section: heading,
        cells: heading
          ? []
          : [
              formatCents(r.values[0]),
              percentLabel(BigInt(r.values[0]), total) ?? "",
              ...(comparing ? [formatCents(r.values[1]), signedMoney(change)] : []),
            ],
        tones: heading
          ? []
          : [
              BigInt(r.values[0]) < BigInt(0) ? ("bad" as Tone) : null,
              null,
              ...(comparing ? [null, changeTone(change, true)] : []),
            ],
      };
    }),
    hiddenNote: null,
    panels: [],
    ranked: [
      {
        title: "Who you paid",
        tone: "expense" as const,
        sentence: s.top
          ? `${s.top.name} was paid the most: ${Math.round(s.topShare ?? 0)}% of your spending.`
          : "Nobody was paid in this period.",
        rows: ranked(rankedRows(rows, "main", short, config, 15)),
        total: { label: config.mainTotal, value: formatCents(s.mainTotal) },
      },
      {
        title: "Where the money goes",
        tone: "expense" as const,
        sentence: biggest
          ? `${biggest.label} took ${Math.round(biggest.share)}% of your spending.`
          : "No spending in this period.",
        rows: roles.map((r) => ({
          label: r.label,
          value: formatCents(r.amount),
          share: percentLabel(r.amount, total) ?? "",
          amount: Number(r.amount) / 100,
          hint:
            r.role === "none"
              ? "Depreciation and charges not matched to a vendor yet."
              : `${r.names.join(", ")}${r.count > r.names.length ? ` and ${r.count - r.names.length} more` : ""}`,
        })),
        total: { label: "Total expenses", value: formatCents(total) },
      },
      ...(otherRows.length
        ? [
            {
              title: "Other spending",
              tone: "expense" as const,
              sentence: "Spending with contacts that are only clients, and spending with no contact yet.",
              rows: ranked(otherRows),
              total: { label: "Total other spending", value: formatCents(s.otherTotal + s.noneTotal) },
            },
          ]
        : []),
    ],
  };
  return { table, document };
}

/**
 * Owner activity in export layout 2: a flat CSV of the equity roll-forward
 * with every owner account (Section, Line, Amount, and Comparison and Change
 * when comparing), and for the PDF the tiles, where your equity went, salary
 * and draws with the plain notes, and the statement as the owner chose it.
 * The list of each transaction stays on the screen; the statement's lines
 * open them there.
 */
function ownerActivityDocument(data: ReportData, details: boolean) {
  const comparing = !!data.filter.compare_from;
  const t = ownerTotals(data);
  const every = ownerStatement(data, true);
  const columns = ["Section", "Line", "Amount", ...(comparing ? ["Comparison", "Change"] : [])];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 2),
    rows: every
      .filter((r) => r.kind !== "heading")
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        cells: [r.section, r.label, ...r.values.map(centsToDecimal)],
      })),
  };
  const compared = compareLabel(data.filter);
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const roll = equityRollForward(data);
  const whole = t.salary + t.takenOut;
  const rows = ownerStatement(data, details);
  const document: StatementDocument = {
    periodLabel: rangeLabel(data.filter.from, data.filter.to),
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      { label: "Money put in", value: formatCents(t.putIn), note: "Credits to your owner accounts", change: null, tone: "flat" },
      { label: "Money taken out", value: formatCents(t.takenOut), note: "Draws and distributions", change: null, tone: "flat" },
      {
        label: "Paid as salary",
        value: t.salaryTracked ? formatCents(t.salary) : "Not tracked",
        note: t.salaryTracked ? "Officer pay through payroll" : "No officer pay account",
        change: null,
        tone: "flat",
      },
      {
        label: "Taken out vs profit",
        value: t.takenShare === null ? "No profit" : `${t.takenShare.toFixed(1)}%`,
        note: t.takenShare === null ? "The business made no profit" : "Of this period's profit",
        change: null,
        tone: "flat",
      },
    ],
    accentTile: 1,
    months: [],
    columns: comparing ? ["This period", "Comparison", "Change"] : ["Amount"],
    shareColumn: false,
    rows: rows.map((r) => {
      const heading = r.kind === "heading";
      const change = comparing && !heading ? BigInt(r.values[2]) : BigInt(0);
      return {
        key: r.key,
        kind: r.kind,
        label: r.label,
        indent: !!r.indent,
        section: heading,
        cells: heading
          ? []
          : [formatCents(r.values[0]), ...(comparing ? [formatCents(r.values[1]), signedMoney(change)] : [])],
        // Owner money moving is neither good nor bad: no colors on it.
        tones: heading ? [] : [BigInt(r.values[0]) < BigInt(0) && r.kind !== "account" ? ("bad" as Tone) : null, ...(comparing ? [null, null] : [])],
      };
    }),
    hiddenNote: null,
    panels: [
      {
        title: "Where your equity went",
        sentence: `Your equity went from ${formatCents(t.startingEquity)} to ${formatCents(t.endingEquity)}.`,
        start: panelLine("Starting equity", roll.start),
        lines: roll.lines.map((l) => panelLine(l.label, l.amount, l.hint)),
        total: panelLine("Ending equity", roll.end),
      },
    ],
    ranked: [
      {
        title: "Salary and draws",
        sentence: ownerSentence(t),
        note: ownerNotes(t).map((n) => n.text).join(" ") || null,
        tone: "expense",
        rows: [
          ...(t.salaryTracked
            ? [
                {
                  label: "Salary through payroll",
                  value: formatCents(t.salary),
                  share: percentLabel(t.salary, whole) ?? "",
                  amount: Number(t.salary) / 100,
                  tone: "income" as const,
                },
              ]
            : []),
          { label: "Taken out as owner", value: formatCents(t.takenOut), share: percentLabel(t.takenOut, whole) ?? "", amount: Number(t.takenOut) / 100 },
        ],
        total: { label: "Salary and draws together", value: formatCents(whole) },
      },
    ],
  };
  return { table, document };
}

/**
 * The trial balance in export layout 2: an accountant-ready sheet (Account
 * number, Account, Type, Debit, Credit, and the comparison's Debit, Credit
 * and Change when comparing, change debit positive), and for the PDF the
 * tiles, what is worth a look, and the full table by type with subtotals.
 */
function trialBalanceDocument(data: ReportData, details: boolean) {
  const comparing = !!data.filter.compare_to;
  const lines = trialLines(data);
  const t = trialTotals(lines);
  const types = byType(lines);
  const plain = (v: bigint) => (v === BigInt(0) ? "" : centsToDecimal(v));
  const columns = [
    "Account number",
    "Account",
    "Type",
    "Debit",
    "Credit",
    ...(comparing ? ["Comparison debit", "Comparison credit", "Change"] : []),
  ];
  const debitOf = (v: bigint) => (v > BigInt(0) ? v : BigInt(0));
  const creditOf = (v: bigint) => (v < BigInt(0) ? -v : BigInt(0));
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 3),
    rows: [
      ...lines.map((l) => ({
        key: l.id,
        kind: "account" as const,
        cells: [
          l.code ?? "",
          l.name,
          typeWord(l.type),
          plain(l.debit),
          plain(l.credit),
          ...(comparing
            ? [plain(debitOf(l.compare)), plain(creditOf(l.compare)), centsToDecimal(l.balance - l.compare)]
            : []),
        ],
      })),
      {
        key: "total",
        kind: "total" as const,
        cells: [
          "",
          "Total",
          "",
          centsToDecimal(t.debits),
          centsToDecimal(t.credits),
          ...(comparing ? [centsToDecimal(t.compareDebits), centsToDecimal(t.compareCredits), ""] : []),
        ],
      },
    ],
  };
  const compared = balanceCompareLabel(data.filter);
  const since = compared ? `since ${compared.short}` : null;
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const balanced = t.difference === BigInt(0);
  const money = (v: bigint) => (v === BigInt(0) ? "" : formatCents(v));
  const rows: StatementDocument["rows"] = [];
  for (const type of TRIAL_TYPES) {
    const list = lines.filter((l) => l.type === type);
    if (!list.length) continue;
    const total = types.find((x) => x.type === type);
    rows.push({ key: `h-${type}`, kind: "heading", label: TYPE_LABELS[type], indent: false, section: true, cells: [], tones: [] });
    if (details)
      for (const l of list)
        rows.push({
          key: l.id,
          kind: "account",
          label: l.code ? `${l.code}  ${l.name}` : l.name,
          indent: true,
          section: false,
          cells: [
            money(l.debit),
            money(l.credit),
            ...(comparing ? [sideLabel(l.compare), l.balance === l.compare ? "No change" : sideLabel(l.balance - l.compare)] : []),
          ],
          tones: [null, null, ...(comparing ? [null, null] : [])],
        });
    const net = list.reduce((s, l) => s + l.balance, BigInt(0)),
      then = list.reduce((s, l) => s + l.compare, BigInt(0));
    rows.push({
      key: `t-${type}`,
      kind: "subtotal",
      label: `Total ${TYPE_LABELS[type].toLowerCase()}`,
      indent: false,
      section: false,
      cells: [
        money(total?.debit ?? BigInt(0)),
        money(total?.credit ?? BigInt(0)),
        ...(comparing ? [sideLabel(then), sideLabel(net - then)] : []),
      ],
      tones: [null, null, ...(comparing ? [null, null] : [])],
    });
  }
  rows.push({
    key: "total",
    kind: "total",
    label: "Total",
    indent: false,
    section: false,
    cells: [
      formatCents(t.debits),
      formatCents(t.credits),
      ...(comparing
        ? [
            t.compareDebits === t.compareCredits
              ? "Balanced"
              : `Off by ${formatCents(t.compareDebits - t.compareCredits)}`,
            "",
          ]
        : []),
    ],
    tones: [null, null, ...(comparing ? [null, null] : [])],
  });
  const checks = trialChecks(data, lines);
  const document: StatementDocument = {
    periodLabel: `As of ${dateText(data.filter.to)}`,
    comparisonLabel: compared?.long ?? null,
    scopeNote:
      data.filter.mode === "working"
        ? awaiting > 0
          ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
          : null
        : "Reviewed transactions only.",
    tiles: [
      {
        label: "Total debits",
        value: formatCents(t.debits),
        note: "Debit balances added up",
        change: since ? `${t.debits >= t.compareDebits ? "+" : ""}${formatCents(t.debits - t.compareDebits)} ${since}` : null,
        tone: "flat",
      },
      {
        label: "Total credits",
        value: formatCents(t.credits),
        note: "Credit balances added up",
        change: since ? `${t.credits >= t.compareCredits ? "+" : ""}${formatCents(t.credits - t.compareCredits)} ${since}` : null,
        tone: "flat",
      },
      {
        label: "Difference",
        value: balanced ? "Balanced" : formatCents(t.difference < BigInt(0) ? -t.difference : t.difference),
        note: balanced ? "Debits equal credits" : "Debits and credits differ",
        change: null,
        tone: balanced ? "good" : "bad",
      },
      {
        label: "Accounts with a balance",
        value: String(t.accounts),
        note: `On ${dateText(data.filter.to)}`,
        change: null,
        tone: "flat",
      },
    ],
    accentTile: 2,
    months: [],
    columns: comparing ? ["Debit", "Credit", "Comparison", "Change"] : ["Debit", "Credit"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [],
    checks: {
      title: "Worth a look",
      empty: "Nothing stands out: the books balance, every account sits on its usual side and nothing is waiting for a category.",
      items: checks.map((c) => ({ tone: c.tone, title: c.title, detail: c.detail })),
    },
  };
  return { table, document };
}

/** The PDF stops listing lines here; the CSV always carries every line. */
export const LEDGER_PDF_LINES = 4000;

/**
 * The general ledger in export layout 2. The CSV lists every line of every
 * account (Date, Entry, Description, Account number, Account, Debit,
 * Credit, Running balance), each account opened and closed by its balance
 * rows; the PDF draws the headline tiles, then one section per account
 * with its opening balance, its lines and its closing balance.
 */
function generalLedgerDocument(
  data: ReportData,
  rows: NonNullable<DetailedReportSnapshot["payload"]["ledger"]>,
  fiscalMonth: number,
) {
  const accounts = ledgerAccounts(data, fiscalMonth);
  const sections = ledgerSections(accounts, ledgerLines(rows, data, fiscalMonth));
  const t = ledgerTotals(accounts);
  const plain = (v: bigint) => (v === BigInt(0) ? "" : centsToDecimal(v));
  const columns = [
    "Date",
    "Entry",
    "Description",
    "Account number",
    "Account",
    "Debit",
    "Credit",
    "Running balance",
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 5),
    rows: sections.flatMap(({ account: a, lines }) => {
      const balanceRow = (key: string, date: string, label: string, value: bigint) => ({
        key: `${key}-${a.id}`,
        kind: "subtotal" as const,
        cells: [date, "", label, a.code ?? "", a.name, "", "", centsToDecimal(value)],
      });
      return [
        balanceRow("open", data.filter.from, "Opening balance", a.opening),
        ...lines.map((l) => ({
          key: l.id,
          kind: "account" as const,
          cells: [
            l.date,
            l.entryId,
            lineText(l) + (l.draft ? " (awaiting review)" : ""),
            a.code ?? "",
            a.name,
            plain(l.debit),
            plain(l.credit),
            centsToDecimal(l.balance),
          ],
        })),
        balanceRow("close", data.filter.to, "Closing balance", a.closing),
      ];
    }),
  };

  const sameYear = data.filter.from.slice(0, 4) === data.filter.to.slice(0, 4);
  const day = (date: string) => (sameYear ? dateText(date).replace(/, \d{4}$/, "") : dateText(date));
  const money = (v: bigint) => (v === BigInt(0) ? "" : formatCents(v));
  const out: StatementDocument["rows"] = [];
  let room = LEDGER_PDF_LINES;
  for (const { account: a, lines } of sections) {
    out.push({
      key: `h-${a.id}`,
      kind: "heading",
      label: a.code ? `${a.code}  ${a.name}` : a.name,
      indent: false,
      section: true,
      cells: [],
      tones: [],
    });
    out.push({
      key: `o-${a.id}`,
      kind: "subtotal",
      label: "Opening balance",
      date: day(data.filter.from),
      indent: false,
      section: false,
      cells: ["", "", formatCents(a.opening)],
      tones: [null, null, null],
    });
    const listed = lines.slice(0, Math.max(room, 0));
    room -= listed.length;
    for (const l of listed)
      out.push({
        key: l.id,
        kind: "account",
        label: `${lineText(l)}${l.draft ? " (awaiting review)" : ""}`,
        date: day(l.date),
        indent: true,
        section: false,
        cells: [money(l.debit), money(l.credit), formatCents(l.balance)],
        tones: [null, null, null],
      });
    const left = lines.length - listed.length;
    if (left > 0)
      out.push({
        key: `m-${a.id}`,
        kind: "account",
        label: `${left.toLocaleString("en-US")} more ${left === 1 ? "line" : "lines"}, listed in the CSV`,
        indent: true,
        section: false,
        cells: [money(a.debit), money(a.credit), ""],
        tones: [null, null, null],
      });
    out.push({
      key: `c-${a.id}`,
      kind: "subtotal",
      label: "Closing balance",
      date: day(data.filter.to),
      indent: false,
      section: false,
      cells: [money(a.debit), money(a.credit), formatCents(a.closing)],
      tones: [null, null, null],
    });
  }
  const awaiting = data.quality.draft_count - data.quality.unbalanced_drafts;
  const balanced = t.debits === t.credits;
  const capped = rows.length > LEDGER_PDF_LINES;
  const scope = [
    data.filter.mode === "working"
      ? awaiting > 0
        ? `All activity, including ${awaiting} ${awaiting === 1 ? "transaction" : "transactions"} awaiting review.`
        : null
      : "Reviewed transactions only.",
    capped
      ? `This PDF lists the first ${LEDGER_PDF_LINES.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} lines; the CSV lists every line.`
      : null,
  ].filter(Boolean);
  const document: StatementDocument = {
    periodLabel: rangeLabel(data.filter.from, data.filter.to),
    comparisonLabel: null,
    scopeNote: scope.length ? scope.join(" ") : null,
    tiles: [
      {
        label: "Lines",
        value: rows.length.toLocaleString("en-US"),
        note: "Journal lines",
        change: null,
        tone: "flat",
      },
      {
        label: "Debits",
        value: formatCents(t.debits),
        note: "In the period",
        change: null,
        tone: "flat",
      },
      {
        label: "Credits",
        value: formatCents(t.credits),
        note: balanced ? "Equal to the debits" : "Not equal to the debits",
        change: null,
        tone: balanced ? "flat" : "bad",
      },
      {
        label: "Accounts with activity",
        value: String(t.active),
        note: `Of ${accounts.length} in the ledger`,
        change: null,
        tone: "flat",
      },
    ],
    accentTile: 0,
    months: [],
    columns: ["Debit", "Credit", "Balance"],
    shareColumn: false,
    rows: out,
    hiddenNote: null,
    panels: [],
    statementTitle: "Ledger",
    labelHead: "Description",
    dateWidth: sameYear ? 50 : 72,
  };
  return { table, document };
}

export function documentCsv(doc: ReportDocument): string {
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const safeText = (s: string) =>
    quote((/^\s*[=+@\-\t\r]/.test(s) ? "'" : "") + s);
  return (
    "\uFEFF" +
    [
      ["Report", doc.title],
      ["Company", doc.company],
      ...doc.metadata,
      ["Snapshot", doc.snapshotId],
    ]
      .map((r) => r.map(safeText).join(","))
      .join("\r\n") +
    "\r\n\r\n" +
    doc.columns.map(safeText).join(",") +
    "\r\n" +
    doc.rows
      .map((r) =>
        r.cells
          .map((s, i) =>
            doc.numeric[i] && /^-?\d+\.\d{2}$/.test(s) ? s : safeText(s),
          )
          .join(","),
      )
      .join("\r\n") +
    "\r\n\r\n" +
    doc.notes.map(safeText).join("\r\n") +
    "\r\n"
  );
}
