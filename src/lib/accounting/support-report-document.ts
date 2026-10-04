import { centsToDecimal, formatCents } from "./money";
import { rangeLabel } from "./profit-loss";
import type { ReportDocument, StatementDocument } from "./report-document";
import {
  supportReportCatalog,
  supportReportDocument,
  type SupportReportData,
  type SupportReportId,
  type SupportReportSnapshot,
} from "./support-reports";
import {
  CONTRACTOR_GROUPS,
  CONTRACTOR_NOTES,
  KIND_LABELS,
  STATUS_LABELS,
  W9_LABELS,
  contractorDecisions,
  contractorLines,
  contractorRule,
  contractorTotals,
} from "./contractor-worksheet";
import {
  TAX_NOTES,
  classificationPhrase,
  taxAdjustments,
  taxBridge,
  taxGroups,
  taxLines,
  taxReadiness,
  taxSeparately,
  taxSourceOf,
  taxTotals,
} from "./tax-workpaper-report";
import { PAYROLL_NOTES, payrollTotals, quarterSummaries, registerRuns } from "./payroll-register";
import { ASSET_NOTES, assetLines, assetTies, assetTotals } from "./fixed-assets";
import { LOAN_NOTES, loanLines, loanTies, loanTotals } from "./loan-balances";

const ZERO_BIG = BigInt(0);

/**
 * The support reports in export layout 2: the branded statement the main
 * reports use (tiles, checks, statement) for the PDF and a CSV shaped for
 * the job (the contractor worksheet's is ready for 1099 filing). The
 * snapshot holds the same retained data either way; the layout is how it
 * is drawn, chosen when it is downloaded. Reports without a layout 2 yet
 * keep the original table.
 */
export const SUPPORT_LAYOUT_2: readonly SupportReportId[] = [
  "contractor-worksheet",
  "tax-workpapers",
  "payroll-register",
  "asset-register",
  "loan-register",
];

export function supportStatementDocument(snapshot: SupportReportSnapshot): ReportDocument {
  const d = snapshot.payload.data;
  if (d.report_id === "contractor-worksheet") {
    if (d.rows.length !== d.count) throw new Error("The retained report is incomplete.");
    return contractorDocument(d, snapshot);
  }
  if (d.report_id === "tax-workpapers") {
    if (d.rows.length !== d.count) throw new Error("The retained report is incomplete.");
    return taxDocument(d, snapshot);
  }
  if (d.report_id === "payroll-register") {
    if (d.rows.length !== d.count) throw new Error("The retained report is incomplete.");
    return payrollDocument(d, snapshot);
  }
  if (d.report_id === "asset-register") {
    if (d.rows.length !== d.count) throw new Error("The retained report is incomplete.");
    return assetDocument(d, snapshot);
  }
  if (d.report_id === "loan-register") {
    if (d.rows.length !== d.count) throw new Error("The retained report is incomplete.");
    return loanDocument(d, snapshot);
  }
  return supportReportDocument(snapshot);
}

function metadataOf(d: SupportReportData, snapshot: SupportReportSnapshot, extra: [string, string][]): [string, string][] {
  return [
    ["Period", `${d.filter.from} through ${d.filter.to}`],
    ...extra,
    ["Currency", "USD"],
    ["Data revision", d.revision],
    ["Report definition", String(d.definition_version)],
    ["Retained at", snapshot.created_at],
  ];
}

function contractorDocument(d: SupportReportData, snapshot: SupportReportSnapshot): ReportDocument {
  const year = Number(d.filter.to.slice(0, 4));
  const rule = contractorRule(year);
  const lines = contractorLines(d);
  const t = contractorTotals(lines);
  const decisions = contractorDecisions(lines);
  const plain = (v: bigint) => centsToDecimal(v);
  const columns = [
    "Contact",
    "Contractor type",
    "W-9",
    "Reportable payments",
    "Card payments (left out)",
    "Total paid",
    "Needs a 1099",
    "Next step",
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 3 && i <= 5),
    rows: [
      ...lines.map((l) => ({
        key: l.id,
        kind: "account" as const,
        cells: [
          l.name,
          KIND_LABELS[l.kind],
          W9_LABELS[l.w9],
          plain(l.reportable),
          plain(l.card),
          plain(l.total),
          l.needs1099 ? "Yes" : "No",
          l.step,
        ],
      })),
      {
        key: "total",
        kind: "total" as const,
        cells: ["Total", "", "", plain(t.reportable), plain(t.card), plain(t.total), String(t.needs1099), ""],
      },
    ],
  };
  const money = (v: bigint) => (v === BigInt(0) ? "" : formatCents(v));
  const rows: StatementDocument["rows"] = [];
  for (const g of CONTRACTOR_GROUPS) {
    const list = lines.filter(g.match);
    if (!list.length) continue;
    rows.push({ key: `h-${g.key}`, kind: "heading", label: g.label, indent: false, section: true, cells: [], tones: [] });
    for (const l of list)
      rows.push({
        key: l.id,
        kind: "account",
        // The name alone: the status says what matters, the CSV has the type and W-9.
        label: l.name,
        indent: true,
        section: false,
        cells: [money(l.reportable), money(l.card), money(l.total), STATUS_LABELS[l.status]],
        tones: [null, null, null, l.status === "missing-w9" || l.status === "decide" ? "bad" : l.status === "ready" ? "good" : null],
      });
    if (g.key !== "unpaid")
      rows.push({
        key: `t-${g.key}`,
        kind: "subtotal",
        label: `Total, ${g.label.toLowerCase()}`,
        indent: false,
        section: false,
        cells: [
          formatCents(list.reduce((s, l) => s + l.reportable, BigInt(0))),
          money(list.reduce((s, l) => s + l.card, BigInt(0))),
          formatCents(list.reduce((s, l) => s + l.total, BigInt(0))),
          "",
        ],
        tones: [null, null, null, null],
      });
  }
  rows.push({
    key: "total",
    kind: "total",
    label: "All contractors",
    indent: false,
    section: false,
    cells: [formatCents(t.reportable), money(t.card), formatCents(t.total), ""],
    tones: [null, null, null, null],
  });
  const lineText = rule.line === null ? "not set in the rules" : formatCents(rule.line);
  const document: StatementDocument = {
    periodLabel: rangeLabel(d.filter.from, d.filter.to),
    comparisonLabel: null,
    scopeNote: `Reviewed transactions only. The ${year} line is ${lineText}; payments by card are left out.`,
    tiles: [
      {
        label: "Contractors paid",
        value: String(t.paid),
        note: t.unpaid ? `${t.unpaid} more not paid in ${year}` : `In ${year}`,
        change: null,
        tone: "flat",
      },
      {
        label: "Need a 1099",
        value: String(t.needs1099),
        note: `Paid ${lineText} or more`,
        change: null,
        tone: "flat",
      },
      {
        label: "Missing W-9 or details",
        value: String(t.missing),
        note: t.missing ? "Before you can file" : "Nothing missing",
        change: null,
        tone: t.missing ? "bad" : "good",
      },
      {
        label: "Paid to contractors",
        value: formatCents(t.total),
        note: `${formatCents(t.reportable)} counts toward 1099s`,
        change: null,
        tone: "flat",
      },
    ],
    accentTile: 1,
    months: [],
    columns: ["Reportable", "By card", "Total paid", "Status"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [],
    statementTitle: "Contractors",
    labelHead: "Contact",
    checks: {
      title: "Needs a decision",
      empty: "Nothing to decide: every contractor paid this year has a type and a W-9 setting that fit.",
      items: decisions.map((x) => ({ tone: x.tone, title: x.title, detail: x.detail })),
    },
  };
  return {
    title: supportReportCatalog.find((r) => r.id === d.report_id)!.title,
    company: d.legal_name,
    snapshotId: snapshot.id,
    metadata: metadataOf(d, snapshot, [
      ["Reporting line", rule.line === null ? "Not set" : `${centsToDecimal(rule.line)} (${year})`],
      ["Scope", "Reviewed only"],
      ...(rule.source ? ([["Rule source", rule.source]] as [string, string][]) : []),
    ]),
    ...table,
    notes: CONTRACTOR_NOTES,
    statement: document,
  };
}

const taxPanelLine = (label: string, cents: bigint, hint?: string) => ({
  label,
  value: formatCents(cents),
  amount: Number(cents) / 100,
  ...(hint ? { hint } : {}),
});

/**
 * The tax workpapers in layout 2. The CSV is one row per account and per
 * adjustment, by treatment, with the book amount, the adjustment and the
 * tax amount, ready for a preparer; the PDF draws the tiles, the bridge
 * from book profit to the books' taxable figure, what is not ready, and
 * the statement by treatment.
 */
function taxDocument(d: SupportReportData, snapshot: SupportReportSnapshot): ReportDocument {
  const source = taxSourceOf(d);
  if (!source) throw new Error("The retained tax workpapers are missing their tax source.");
  const lines = taxLines(source);
  const groups = taxGroups(lines);
  const adjustments = taxAdjustments(source);
  const readiness = taxReadiness(source);
  const t = taxTotals(source, readiness);
  const bridge = taxBridge(source);
  const separately = taxSeparately(source);
  const as = classificationPhrase(source);
  const plain = (v: bigint) => centsToDecimal(v);
  const columns = [
    "Treatment",
    "Account number",
    "Account or adjustment",
    "Book amount",
    "Adjustment",
    "Tax amount",
    "Counted",
    "Note",
  ];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 3 && i <= 5),
    rows: [
      ...lines.map((l) => ({
        key: l.id,
        kind: "account" as const,
        cells: [
          l.label,
          l.code ?? "",
          l.name,
          plain(l.book),
          plain(l.adjustment),
          plain(l.tax),
          l.treatment === null ? "" : l.separately ? "Separately stated" : l.percent === null ? "Not counted" : `${l.percent}%`,
          l.treatment === null ? "No tax treatment yet: left out" : "",
        ],
      })),
      ...adjustments.map((a) => ({
        key: a.id,
        kind: "account" as const,
        cells: [
          a.label,
          "",
          `Adjustment: ${a.reason}`,
          plain(ZERO_BIG),
          plain(a.ordinary ? a.amount : ZERO_BIG),
          plain(a.ordinary ? a.amount : ZERO_BIG),
          a.ordinary ? "" : "Separately stated",
          `${a.date}${a.supported ? "" : ", no document attached"}${a.ordinary ? "" : `, amount ${plain(a.amount)}`}`,
        ],
      })),
      ...separately.map((s) => ({
        key: `sep-${s.concept}`,
        kind: "subtotal" as const,
        cells: ["Separately stated", "", s.label, plain(s.amount), "", "", "", "Listed on its own, not in the tax amount"],
      })),
      {
        key: "total",
        kind: "total" as const,
        cells: ["Total", "", "Ordinary income, books' figure", plain(t.book), plain(t.difference), plain(t.taxable), "", ""],
      },
    ],
  };
  const money = (v: bigint) => (v === ZERO_BIG ? "" : formatCents(v));
  const rows: StatementDocument["rows"] = [];
  for (const g of groups) {
    rows.push({ key: `h-${g.key}`, kind: "heading", label: g.label, indent: false, section: true, cells: [], tones: [] });
    for (const l of g.lines)
      rows.push({
        key: l.id,
        kind: "account",
        label: l.code ? `${l.code}  ${l.name}` : l.name,
        indent: true,
        section: false,
        cells: [formatCents(l.book), money(l.adjustment), formatCents(l.tax)],
        tones: [null, null, null],
      });
    if (g.lines.length > 1)
      rows.push({
        key: `t-${g.key}`,
        kind: "subtotal",
        label: `Total, ${g.label.charAt(0).toLowerCase()}${g.label.slice(1)}`,
        indent: false,
        section: false,
        cells: [
          formatCents(g.lines.reduce((s, l) => s + l.book, ZERO_BIG)),
          money(g.lines.reduce((s, l) => s + l.adjustment, ZERO_BIG)),
          formatCents(g.lines.reduce((s, l) => s + l.tax, ZERO_BIG)),
        ],
        tones: [null, null, null],
      });
  }
  const ordinaryAdjustments = adjustments.filter((a) => a.ordinary);
  if (ordinaryAdjustments.length) {
    rows.push({ key: "h-adj", kind: "heading", label: "Your adjustments", indent: false, section: true, cells: [], tones: [] });
    for (const a of ordinaryAdjustments)
      rows.push({
        key: a.id,
        kind: "account",
        label: `${a.reason}${a.supported ? "" : " (no document)"}`,
        indent: true,
        section: false,
        cells: ["", formatCents(a.amount), formatCents(a.amount)],
        tones: [null, null, a.supported ? null : "bad"],
      });
  }
  if (separately.length) {
    rows.push({ key: "h-sep", kind: "heading", label: "Stated separately, not in the tax amount", indent: false, section: true, cells: [], tones: [] });
    for (const s of separately)
      rows.push({
        key: `sep-${s.concept}`,
        kind: "account",
        label: s.label,
        indent: true,
        section: false,
        cells: [formatCents(s.amount), "", ""],
        tones: [null, null, null],
      });
  }
  rows.push({
    key: "total",
    kind: "total",
    label: "Ordinary income, books' figure",
    indent: false,
    section: false,
    cells: [formatCents(t.book), formatCents(t.difference), formatCents(t.taxable)],
    tones: [null, null, null],
  });
  const year = source.year;
  const document: StatementDocument = {
    periodLabel: rangeLabel(d.filter.from, d.filter.to),
    comparisonLabel: null,
    scopeNote: `Reviewed transactions only${as ? `, for ${as}` : ""}. These are the books' figures to hand your preparer, not a tax result.`,
    tiles: [
      { label: "Book profit", value: formatCents(t.book), note: "Reviewed income less expenses", change: null, tone: "flat" },
      { label: "Adjustments", value: formatCents(t.difference), note: "Treatments and your adjustments", change: null, tone: "flat" },
      { label: "Ordinary income", value: formatCents(t.taxable), note: "The books' figure, not a tax result", change: null, tone: "flat" },
      {
        label: "Not ready",
        value: String(t.notReady),
        note: t.notReady ? "To settle before you hand it over" : "Ready for your preparer",
        change: null,
        tone: t.notReady ? "bad" : "good",
      },
    ],
    accentTile: 2,
    months: [],
    columns: ["Book", "Adjustment", "Tax"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [
      {
        title: "From book profit to ordinary income",
        sentence: `How ${year}'s book profit becomes the books' ordinary income figure.`,
        start: taxPanelLine("Book profit", bridge.start),
        lines: bridge.lines.map((l) => taxPanelLine(l.label, l.amount, l.hint)),
        total: taxPanelLine("Ordinary income, books' figure", bridge.end),
        footer: null,
      },
    ],
    statementTitle: "By tax treatment",
    labelHead: "Account",
    checks: {
      title: t.notReady ? "Not ready yet" : "Ready to hand over",
      empty: "Nothing is missing: every account has a tax treatment, every adjustment has its document, and every transaction is reviewed.",
      items: readiness.map((c) => ({ tone: c.tone, title: c.title, detail: c.detail })),
    },
  };
  return {
    title: supportReportCatalog.find((r) => r.id === d.report_id)!.title,
    company: d.legal_name,
    snapshotId: snapshot.id,
    metadata: metadataOf(d, snapshot, [
      ["Tax year", String(year)],
      ["Taxed as", as ?? "Not set"],
      ["Scope", "Reviewed only"],
      ["Tax source fingerprint", source.fingerprint],
    ]),
    ...table,
    notes: TAX_NOTES,
    statement: document,
  };
}

/**
 * The payroll register in layout 2, from the retained runs. The CSV has a
 * row per run with its quarter, then each quarter's totals and the year's,
 * for W-2 and quarterly checks; the PDF draws the tiles, gross to net, the
 * run checks and the runs by quarter.
 */
function payrollDocument(d: SupportReportData, snapshot: SupportReportSnapshot): ReportDocument {
  const runs = registerRuns(d);
  const t = payrollTotals(runs, null);
  const year = Number(d.filter.to.slice(0, 4));
  const quarters = quarterSummaries(runs, null);
  const plain = (v: bigint) => centsToDecimal(v);
  const columns = [
    "Quarter",
    "Pay date",
    "Provider run",
    "Gross wages",
    "Employee withholding",
    "Employer taxes",
    "Net pay",
    "Total cost",
  ];
  const quarterName = (q: number) => `Q${q} ${year}`;
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 3),
    rows: [
      ...quarters.flatMap((q) => [
        ...runs
          .filter((r) => r.quarter === q.quarter)
          .map((r) => ({
            key: r.id,
            kind: "account" as const,
            cells: [
              quarterName(r.quarter),
              r.date,
              r.run,
              plain(r.gross),
              plain(r.withholding),
              plain(r.employer),
              plain(r.net),
              plain(r.gross + r.employer),
            ],
          })),
        {
          key: `q-${q.quarter}`,
          kind: "subtotal" as const,
          cells: [
            quarterName(q.quarter),
            "",
            `Total, ${q.runs} ${q.runs === 1 ? "run" : "runs"}`,
            plain(q.gross),
            plain(q.withholding),
            plain(q.employer),
            plain(q.net),
            plain(q.gross + q.employer),
          ],
        },
      ]),
      {
        key: "total",
        kind: "total" as const,
        cells: [
          String(year),
          "",
          `Total, ${t.runs} ${t.runs === 1 ? "run" : "runs"}`,
          plain(t.gross),
          plain(t.withholding),
          plain(t.employerTax),
          plain(t.net),
          plain(t.gross + t.employerTax),
        ],
      },
    ],
  };
  const sameYear = d.filter.from.slice(0, 4) === d.filter.to.slice(0, 4);
  const day = (date: string) => {
    const text = rangeLabel(date, date);
    return sameYear ? text.replace(/, \d{4}$/, "") : text;
  };
  const rows: StatementDocument["rows"] = [];
  for (const q of quarters) {
    rows.push({ key: `h-${q.quarter}`, kind: "heading", label: quarterName(q.quarter), indent: false, section: true, cells: [], tones: [] });
    for (const r of runs.filter((x) => x.quarter === q.quarter))
      rows.push({
        key: r.id,
        kind: "account",
        label: r.run,
        date: day(r.date),
        indent: true,
        section: false,
        cells: [formatCents(r.gross), formatCents(r.withholding), formatCents(r.employer), formatCents(r.net)],
        tones: [null, null, null, r.gross === r.net + r.withholding ? null : "bad"],
      });
    rows.push({
      key: `t-${q.quarter}`,
      kind: "subtotal",
      label: `Total, ${quarterName(q.quarter)}`,
      date: "",
      indent: false,
      section: false,
      cells: [formatCents(q.gross), formatCents(q.withholding), formatCents(q.employer), formatCents(q.net)],
      tones: [null, null, null, null],
    });
  }
  rows.push({
    key: "total",
    kind: "total",
    label: `Total, ${t.runs} ${t.runs === 1 ? "run" : "runs"}`,
    date: "",
    indent: false,
    section: false,
    cells: [formatCents(t.gross), formatCents(t.withholding), formatCents(t.employerTax), formatCents(t.net)],
    tones: [null, null, null, null],
  });
  const off = runs.filter((r) => r.gross !== r.net + r.withholding);
  const document: StatementDocument = {
    periodLabel: rangeLabel(d.filter.from, d.filter.to),
    comparisonLabel: null,
    scopeNote: "Payroll runs posted to the books and not reversed by the end of the period.",
    tiles: [
      { label: "Gross wages", value: formatCents(t.gross), note: `${t.runs} ${t.runs === 1 ? "run" : "runs"}`, change: null, tone: "flat" },
      { label: "Employer taxes", value: formatCents(t.employerTax), note: "On top of gross wages", change: null, tone: "flat" },
      { label: "Net pay", value: formatCents(t.net), note: "What was paid out", change: null, tone: "flat" },
      {
        label: "Total payroll cost",
        value: formatCents(t.gross + t.employerTax),
        note: "Gross wages plus employer taxes",
        change: null,
        tone: "flat",
      },
    ],
    accentTile: 3,
    months: [],
    columns: ["Gross", "Withheld", "Employer", "Net pay"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [
      {
        title: "Gross to net",
        sentence: `What came out of ${year}'s gross wages before pay went out, and what the business paid on top.`,
        start: payPanelLine("Gross wages", t.gross),
        lines: [payPanelLine("Withheld from pay", -t.withholding, "Taxes and deductions taken out")],
        total: payPanelLine("Net pay", t.net),
        footer: `Employer taxes of ${formatCents(t.employerTax)} were paid on top, for a total cost of ${formatCents(t.gross + t.employerTax)}.`,
      },
    ],
    statementTitle: "Runs by quarter",
    labelHead: "Run",
    dateWidth: sameYear ? 50 : 72,
    checks: {
      title: "Run checks",
      empty: "Every run adds up: gross wages equal net pay plus withholding.",
      items: off.map((r) => ({
        tone: "look" as const,
        title: `${r.run} does not add up`,
        detail: `Gross ${formatCents(r.gross)} is not net pay ${formatCents(r.net)} plus withholding ${formatCents(r.withholding)}.`,
      })),
    },
  };
  return {
    title: supportReportCatalog.find((r) => r.id === d.report_id)!.title,
    company: d.legal_name,
    snapshotId: snapshot.id,
    metadata: metadataOf(d, snapshot, [["Runs", String(t.runs)]]),
    ...table,
    notes: PAYROLL_NOTES,
    statement: document,
  };
}

const payPanelLine = (label: string, cents: bigint, hint?: string) => ({
  label,
  value: formatCents(cents),
  amount: Number(cents) / 100,
  ...(hint ? { hint } : {}),
});

/**
 * The fixed asset register in layout 2, from the retained register. The
 * CSV lists each asset (acquired, cost, depreciation, book value, share
 * used up) with a total; the register's ties to the books follow as notes.
 * The PDF draws the tiles, the ties as checks, and the assets.
 */
function assetDocument(d: SupportReportData, snapshot: SupportReportSnapshot): ReportDocument {
  const lines = assetLines(d, null, null);
  const t = assetTotals(lines, d);
  const ties = assetTies(d);
  const plain = (v: bigint) => centsToDecimal(v);
  const columns = ["Asset", "Acquired", "Cost", "Accumulated depreciation", "Book value", "Used up"];
  const table = {
    columns,
    numeric: columns.map((_, i) => i >= 2 && i <= 4),
    rows: [
      ...lines.map((l) => ({
        key: l.id,
        kind: "account" as const,
        cells: [l.name, l.acquired, plain(l.cost), plain(l.accumulated), plain(l.book), l.cost > ZERO_BIG ? `${l.used.toFixed(1)}%` : ""],
      })),
      {
        key: "total",
        kind: "total" as const,
        cells: ["Total", "", plain(t.cost), plain(t.accumulated), plain(t.book), ""],
      },
    ],
  };
  const asOf = rangeLabel(d.filter.to, d.filter.to);
  const rows: StatementDocument["rows"] = [
    ...lines.map((l) => ({
      key: l.id,
      kind: "account" as const,
      label: `${l.name}${l.disposed ? " (sold or written off)" : ""}`,
      date: rangeLabel(l.acquired, l.acquired),
      indent: true,
      section: false,
      cells: [formatCents(l.cost), formatCents(l.accumulated), formatCents(l.book)],
      tones: [null, null, null] as (null)[],
    })),
    {
      key: "total",
      kind: "total" as const,
      label: `Total, ${t.count} ${t.count === 1 ? "asset" : "assets"}`,
      date: "",
      indent: false,
      section: false,
      cells: [formatCents(t.cost), formatCents(t.accumulated), formatCents(t.book)],
      tones: [null, null, null],
    },
  ];
  const off = ties.filter((x) => x.tone === "look");
  const document: StatementDocument = {
    periodLabel: `As of ${asOf}`,
    comparisonLabel: null,
    scopeNote: "Assets recorded in the register, with the depreciation posted to them. Nothing here projects depreciation ahead.",
    tiles: [
      { label: "Cost", value: formatCents(t.cost), note: `${t.count} ${t.count === 1 ? "asset" : "assets"}`, change: null, tone: "flat" },
      { label: "Depreciated to date", value: formatCents(t.accumulated), note: "Posted to the books", change: null, tone: "flat" },
      { label: "Book value", value: formatCents(t.book), note: "Cost less depreciation", change: null, tone: "flat" },
      {
        label: "Ties to the books",
        value: off.length ? `${off.length} off` : "Yes",
        note: off.length ? "See below" : "Register equals the accounts",
        change: null,
        tone: off.length ? "bad" : "good",
      },
    ],
    accentTile: 2,
    months: [],
    columns: ["Cost", "Depreciated", "Book value"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [],
    statementTitle: "Assets",
    labelHead: "Asset",
    dateWidth: 72,
    checks: {
      title: "Ties to the books",
      empty: "The register ties to the books: the fixed asset and accumulated depreciation accounts hold exactly what the register explains.",
      items: off.map((x) => ({ tone: "look" as const, title: x.title, detail: x.detail })),
    },
  };
  return {
    title: supportReportCatalog.find((r) => r.id === d.report_id)!.title,
    company: d.legal_name,
    snapshotId: snapshot.id,
    metadata: [
      ["As of", d.filter.to],
      ["Currency", "USD"],
      ["Data revision", d.revision],
      ["Report definition", String(d.definition_version)],
      ["Retained at", snapshot.created_at],
    ],
    ...table,
    notes: [
      ...ASSET_NOTES,
      ...ties.map((x) => `${x.account}: books ${centsToDecimal(x.books)}, register ${centsToDecimal(x.register)}, ${x.tone === "good" ? "tied" : `difference ${centsToDecimal(x.books - x.register)}`}.`),
    ],
    statement: document,
  };
}

/**
 * The loan register in layout 2, from the retained register: each loan
 * with its start date and principal balance, the total owed, and the
 * register's ties to the loan accounts (as checks in the PDF and as notes
 * in the CSV).
 */
function loanDocument(d: SupportReportData, snapshot: SupportReportSnapshot): ReportDocument {
  const lines = loanLines(d, null, null);
  const t = loanTotals(lines, d);
  const ties = loanTies(d);
  const columns = ["Loan", "Originated", "Principal balance"];
  const table = {
    columns,
    numeric: [false, false, true],
    rows: [
      ...lines.map((l) => ({ key: l.id, kind: "account" as const, cells: [l.name, l.started, centsToDecimal(l.balance)] })),
      { key: "total", kind: "total" as const, cells: ["Total", "", centsToDecimal(t.owed)] },
    ],
  };
  const off = ties.filter((x) => x.tone === "look");
  const rows: StatementDocument["rows"] = [
    ...lines.map((l) => ({
      key: l.id,
      kind: "account" as const,
      // Marked as the owner's unless its name already says so.
      label: `${l.name}${l.shareholder && !/shareholder|owner|officer/i.test(l.name) ? " (from the owner)" : ""}${l.balance === ZERO_BIG ? ", paid off" : ""}`,
      date: rangeLabel(l.started, l.started),
      indent: true,
      section: false,
      cells: [formatCents(l.balance)],
      tones: [null] as null[],
    })),
    {
      key: "total",
      kind: "total" as const,
      label: `Owed on ${t.open} ${t.open === 1 ? "loan" : "loans"}`,
      date: "",
      indent: false,
      section: false,
      cells: [formatCents(t.owed)],
      tones: [null],
    },
  ];
  const document: StatementDocument = {
    periodLabel: `As of ${rangeLabel(d.filter.to, d.filter.to)}`,
    comparisonLabel: null,
    scopeNote: "Loans recorded in the register, with the principal still owed. Nothing here projects payments ahead.",
    tiles: [
      { label: "Owed now", value: formatCents(t.owed), note: "Principal still owed", change: null, tone: "flat" },
      { label: "Loans", value: String(t.count), note: t.open === t.count ? "All with a balance" : `${t.open} with a balance`, change: null, tone: "flat" },
      { label: "Paid off", value: String(t.count - t.open), note: "Nothing left owed", change: null, tone: "flat" },
      {
        label: "Ties to the books",
        value: off.length ? `${off.length} off` : "Yes",
        note: off.length ? "See below" : "Register equals the accounts",
        change: null,
        tone: off.length ? "bad" : "good",
      },
    ],
    accentTile: 0,
    months: [],
    columns: ["Owed"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [],
    statementTitle: "Loans",
    labelHead: "Loan",
    dateWidth: 72,
    checks: {
      title: "Ties to the books",
      empty: "The register ties to the books: each loan account holds exactly what the register explains.",
      items: off.map((x) => ({ tone: "look" as const, title: x.title, detail: x.detail })),
    },
  };
  return {
    title: supportReportCatalog.find((r) => r.id === d.report_id)!.title,
    company: d.legal_name,
    snapshotId: snapshot.id,
    metadata: [
      ["As of", d.filter.to],
      ["Currency", "USD"],
      ["Data revision", d.revision],
      ["Report definition", String(d.definition_version)],
      ["Retained at", snapshot.created_at],
    ],
    ...table,
    notes: [
      ...LOAN_NOTES,
      ...ties.map(
        (x) =>
          `${x.account}: books ${centsToDecimal(x.books)}, register ${centsToDecimal(x.register)}, ${x.tone === "good" ? "tied" : `difference ${centsToDecimal(x.books - x.register)}`}.`,
      ),
    ],
    statement: document,
  };
}
