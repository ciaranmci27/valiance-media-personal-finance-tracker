import { reportDocument, type ReportDocument, type StatementDocument } from "./report-document";
import { supportReportDocument } from "./support-reports";
import { supportStatementDocument } from "./support-report-document";
import { formatCents } from "./money";
import { rangeLabel } from "./profit-loss";
import {
  PACKAGE_CONTENTS,
  PACKAGE_GROUPS,
  PACKAGE_NOTES,
  packageChecks,
  packageSummary,
} from "./year-end-package";
import { payrollFactLabels } from "./payroll";
import { centsToDecimal } from "./money";
import type { BooksPackageSnapshot } from "./books-package";
import type { TaxSource } from "./tax-workpapers";

/**
 * The package's documents. Layout 1 is the original tables, kept for
 * downloads of earlier packages; layout 2 is the branded statements the
 * redesigned reports export, with a cover page first.
 */
export function booksPackageDocuments(
  snapshot: BooksPackageSnapshot,
  layout: 1 | 2 = 1,
): { id: string; document: ReportDocument }[] {
  const p = snapshot.payload;
  if (
    p.type !== "books_package" ||
    p.export_definition !== 1 ||
    snapshot.revision !== p.core.revision ||
    p.ledger.length !== p.ledger_count ||
    p.payroll.revision !== snapshot.revision ||
    p.support.some(
      (s) =>
        s.revision !== snapshot.revision ||
        s.filter.from !== p.core.filter.from ||
        s.filter.to !== p.through ||
        s.rows.length !== s.count,
    )
  )
    throw new Error(
      "The retained package is incomplete or contains inconsistent report revisions.",
    );
  const documents = (
    layout === 2
      ? ([
          "profit-loss",
          "balance-sheet",
          "cash-flow",
          "trial-balance",
          "general-ledger",
          "owner-activity",
          "customer-income",
          "vendor-expenses",
        ] as const)
      : ([
          "profit-loss",
          "balance-sheet",
          "cash-flow",
          "trial-balance",
          "general-ledger",
          "owner-activity",
        ] as const)
  ).map((id) => ({
    id,
    document: reportDocument({
      id: snapshot.id,
      revision: snapshot.revision,
      created_at: snapshot.created_at,
      payload: {
        type: "detailed_report",
        export_definition: 1,
        data: p.core,
        ledger: id === "general-ledger" ? p.ledger : undefined,
        options:
          layout === 2
            ? { report_id: id, show_zero: false, details: true, layout: 2 }
            : { report_id: id, show_zero: true, details: true },
      },
    }),
  }));
  const base = {
    company: p.core.legal_name,
    snapshotId: snapshot.id,
    metadata: [
      ["Period", `${p.core.filter.from} through ${p.through}`],
      ["Currency", "USD"],
      ["Data revision", snapshot.revision],
      ["Retained at", snapshot.created_at],
    ] as [string, string][],
  };
  const tax = p.support.find((s) => s.report_id === "tax-workpapers") as
    | ((typeof p.support)[number] & { tax_workpaper?: TaxSource })
    | undefined;
  const accountMapping: ReportDocument = {
    ...base,
    title: "Account mappings",
    columns: [
      "Code / account",
      "Book type",
      "Purpose",
      "Cash classification",
      "Tax concept",
      "Deductible percentage",
      "State",
    ],
    numeric: [false, false, false, false, false, false, false],
    rows: p.account_mappings.map((account) => {
      const mapping = tax?.tax_workpaper?.accounts.find(
        (a) => a.account_id === account.id,
      )?.mapping;
      return {
        key: account.id,
        kind: "account",
        cells: [
          `${account.code} ${account.name}`.trim(),
          `${account.account_type} / ${account.normal_side}`,
          account.profile?.purpose?.replaceAll("_", " ") ?? "General account",
          account.profile?.cash_kind ?? "none",
          mapping?.concept?.replaceAll("_", " ") ?? "Not mapped",
          mapping
            ? `${(mapping.deductible_bps / 100).toFixed(2)}%`
            : "Not supplied",
          account.is_archived ? "Archived" : "Active",
        ],
      };
    }),
    notes: [
      "Book classifications and tax mappings are the versions known at capture. Tax percentages are explicitly reviewed inputs, not automatic deductibility advice.",
    ],
  };
  const officer: ReportDocument = {
    ...base,
    title: "Officer and payroll reconciliation",
    columns: [
      "Employee",
      "Measure",
      "Recorded registers",
      "Provider worksheet",
      "Difference",
      "Coverage",
    ],
    numeric: [false, false, true, true, true, false],
    rows: p.payroll.employees.flatMap((employee) => {
      const verified = p.payroll.coverage?.employees.find(
        (e) => e.key === employee.key,
      );
      return (
        [
          ["gross_cash_cents", "Cash wages"],
          ...Object.entries(payrollFactLabels),
        ] as [keyof typeof employee, string][]
      ).map(([key, label]) => {
        const actual = employee[key],
          external = verified?.[key],
          a =
            typeof actual === "string" && /^\d+$/.test(actual) ? actual : null,
          b =
            typeof external === "string" && /^\d+$/.test(external)
              ? external
              : null;
        return {
          key: `${employee.key}-${key}`,
          kind: "account" as const,
          cells: [
            `${employee.name}${employee.is_officer ? " (officer)" : ""}`,
            label,
            a === null ? "Not supplied" : centsToDecimal(a),
            b === null ? "Not supplied" : centsToDecimal(b),
            a === null || b === null
              ? "Not established"
              : centsToDecimal(BigInt(a) - BigInt(b)),
            p.payroll.coverage?.current
              ? "Current source support"
              : p.payroll.coverage
                ? "Stale source support"
                : "Not verified",
          ],
        };
      });
    }),
    notes: [
      `${p.payroll.run_count} posted payroll registers and ${p.payroll.drafts} draft runs at capture. Missing wage measures are not zero.`,
      p.payroll.coverage
        ? `Provider worksheet version ${p.payroll.coverage.version}, through ${p.payroll.coverage.through_date}. Source document ${p.payroll.coverage.document_id}. ${p.payroll.coverage.reason}`
        : "No provider year-to-date coverage worksheet has been retained.",
      "Cash wages, federal taxable wages, Social Security wages and Medicare wages are separate measures. The payroll provider remains responsible for payroll execution, remittances and filing.",
    ],
  };
  const evidence: ReportDocument = {
    ...base,
    title: "Source document index",
    columns: ["Document", "Document ID", "State", "Type", "Bytes", "SHA-256"],
    numeric: [false, false, false, false, false, false],
    rows: p.document_index.map((document) => ({
      key: document.id,
      kind: "account",
      cells: [
        document.original_name,
        document.id,
        document.state ?? "Unknown",
        document.mime_type,
        document.size_bytes,
        document.content_hash,
      ],
    })),
    notes: [
      "Index of all accounting evidence known at package capture. This index contains metadata, not the actual receipt files. Open source documents in the authenticated app using their retained IDs.",
    ],
  };
  const support = p.support.map((data) => {
    const retained = { id: snapshot.id, created_at: snapshot.created_at, payload: { type: "support_report" as const, export_definition: 1 as const, data } };
    return { id: data.report_id, document: layout === 2 ? supportStatementDocument(retained) : supportReportDocument(retained) };
  });
  if (layout === 2) {
    const all = [...documents, ...support, { id: "account-mappings", document: accountMapping }, { id: "officer-payroll-reconciliation", document: officer }, { id: "source-document-index", document: evidence }];
    // In the order the cover lists them.
    const ordered = PACKAGE_CONTENTS.map((item) => all.find((d) => d.id === item.id)).filter(
      (d): d is { id: string; document: ReportDocument } => !!d,
    );
    return [{ id: "cover", document: packageCover(snapshot, ordered.map((d) => d.id)) }, ...ordered];
  }
  return [
    ...documents,
    ...support,
    { id: "account-mappings", document: accountMapping },
    { id: "officer-payroll-reconciliation", document: officer },
    { id: "source-document-index", document: evidence },
  ];
}

/**
 * The package's cover in the branded layout: the business, the year, the
 * readiness of the year (the same checks the page shows) and the contents.
 */
export function packageCover(snapshot: BooksPackageSnapshot, included: string[]): ReportDocument {
  const p = snapshot.payload;
  const support = (id: string) => p.support.find((s) => s.report_id === id) ?? null;
  const checks = packageChecks({
    core: p.core,
    tax: support("tax-workpapers"),
    contractor: support("contractor-worksheet"),
    payroll: support("payroll-register"),
    asset: support("asset-register"),
    loan: support("loan-register"),
    reviewItems: p.review_items,
  });
  const summary = packageSummary(checks);
  const contents = PACKAGE_CONTENTS.filter((item) => included.includes(item.id));
  const rows: StatementDocument["rows"] = [];
  for (const group of PACKAGE_GROUPS) {
    const list = contents.filter((c) => c.group === group);
    if (!list.length) continue;
    rows.push({ key: `h-${group}`, kind: "heading", label: group, indent: false, section: true, cells: [], tones: [] });
    for (const item of list)
      rows.push({
        key: item.id,
        kind: "account",
        label: `${item.title}: ${item.answers}`,
        indent: true,
        section: false,
        cells: [item.pdf ? "PDF, CSV" : "CSV"],
        tones: [null],
      });
  }
  const statement: StatementDocument = {
    periodLabel: rangeLabel(p.core.filter.from, p.through),
    comparisonLabel: null,
    scopeNote: `${summary.text} Reviewed transactions only, at book revision ${snapshot.revision}.`,
    tiles: [
      { label: "Profit", value: formatCents(BigInt(p.core.totals.net_cents)), note: "Book profit for the year", change: null, tone: "flat" },
      { label: "Journal lines", value: p.ledger_count.toLocaleString("en-US"), note: "In the general ledger", change: null, tone: "flat" },
      { label: "Reports", value: String(contents.length), note: "In this package", change: null, tone: "flat" },
      {
        label: "Readiness",
        value: summary.ready ? "Ready" : `${summary.look} open`,
        note: summary.ready ? "Nothing needs a look" : "See the checks below",
        change: null,
        tone: summary.ready ? "good" : "bad",
      },
    ],
    accentTile: 3,
    months: [],
    columns: ["Files"],
    shareColumn: false,
    rows,
    hiddenNote: null,
    panels: [],
    statementTitle: "Contents",
    labelHead: "Report",
    checks: {
      title: "Readiness",
      empty: "Every check passes: the books balance, every transaction is reviewed, and the support reports tie out.",
      items: checks
        .filter((c) => c.status === "look" || c.status === "info")
        .map((c) => ({ tone: c.status === "look" ? ("look" as const) : ("info" as const), title: c.title, detail: c.detail })),
    },
  };
  return {
    title: "Year-end package",
    company: p.core.legal_name,
    snapshotId: snapshot.id,
    metadata: [
      ["Period", `${p.core.filter.from} through ${p.through}`],
      ["Currency", "USD"],
      ["Data revision", snapshot.revision],
      ["Retained at", snapshot.created_at],
    ],
    columns: ["Report", "Answers", "Files"],
    numeric: [false, false, false],
    rows: contents.map((c) => ({ key: c.id, kind: "account" as const, cells: [c.title, c.answers, c.pdf ? "PDF, CSV" : "CSV"] })),
    // The readiness is on the cover itself; the notes say what the package is.
    notes: PACKAGE_NOTES,
    statement,
  };
}
