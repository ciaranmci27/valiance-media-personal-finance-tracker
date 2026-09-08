import { buildReportModel } from "./report-model";
import { centsToDecimal } from "./money";
import type { DetailedReportSnapshot } from "./reports";

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
}
/** CSV and PDF consume the same retained values and presentation options. */
export function reportDocument(
  snapshot: DetailedReportSnapshot,
): ReportDocument {
  const { data, options, ledger } = snapshot.payload;
  const model = buildReportModel(options.report_id, data, options.show_zero);
  const metadata: [string, string][] = [
    ["Period", `${data.filter.from} through ${data.filter.to}`],
    ["Basis", data.basis],
    [
      "Mode",
      data.filter.mode === "working"
        ? "Working preview, includes balanced drafts"
        : "Posted books",
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
        kind.replaceAll("_", " ") + " filter",
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
    `${data.quality.draft_count} drafts in this period. ${data.quality.unbalanced_drafts} incomplete drafts excluded. ${data.quality.incomplete_imports} incomplete imports.`,
    `${data.quality.uncategorized_lines} posted lines need categorization. ${data.quality.unclassified_cash_lines} bank cash lines need classification.`,
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
