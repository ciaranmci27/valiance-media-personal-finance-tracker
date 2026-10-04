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

type Tone = "good" | "bad" | "flat";
/**
 * The branded statement the PDF draws (export layout 2): headline tiles,
 * then a monthly chart (profit and loss) or the equity explained (balance
 * sheet), then the statement with each line's share. Figures are display
 * strings; the CSV keeps plain numbers in `rows`.
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
  months: {
    month: string;
    income: number;
    expense: number;
    partial: { from: string; to: string } | null;
  }[];
  columns: string[];
  rows: {
    key: string;
    kind: "heading" | "account" | "subtotal" | "total";
    label: string;
    indent: boolean;
    /** A heading that names a statement section, not a parent account. */
    section: boolean;
    cells: string[];
    tones: (Tone | null)[];
  }[];
  hiddenNote: string | null;
  /** The balance sheet's equity in plain lines that add up to the total. */
  equity?: {
    sentence: string;
    lines: { label: string; value: string; amount: number }[];
    total: { label: string; value: string; amount: number };
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
  /** Present for a profit and loss captured with layout 2. */
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
    columns: comparing
      ? ["Current", "% of income", "Comparison", "Change"]
      : ["Amount", "% of income"],
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
    months: [],
    columns: comparing
      ? ["As of", "% of assets", "Comparison", "Change"]
      : ["Balance", "% of assets"],
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
    equity: {
      sentence: ownershipSentence(current),
      lines: equity.lines.map((l) => ({
        label: l.label,
        value: formatCents(l.amount),
        amount: Number(l.amount) / 100,
      })),
      total: {
        label: "Total equity",
        value: formatCents(equity.total),
        amount: Number(equity.total) / 100,
      },
    },
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
