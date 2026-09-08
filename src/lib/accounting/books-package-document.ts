import { reportDocument, type ReportDocument } from "./report-document";
import { supportReportDocument } from "./support-reports";
import { payrollFactLabels } from "./payroll";
import { centsToDecimal } from "./money";
import type { BooksPackageSnapshot } from "./books-package";
import type { TaxSource } from "./tax-workpapers";

export function booksPackageDocuments(
  snapshot: BooksPackageSnapshot,
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
    [
      "profit-loss",
      "balance-sheet",
      "cash-flow",
      "trial-balance",
      "general-ledger",
      "owner-activity",
    ] as const
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
        options: { report_id: id, show_zero: true, details: true },
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
      "Cash wages, federal taxable wages, Social Security wages and Medicare wages are separate measures. Patriot remains responsible for payroll execution, remittances and filing.",
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
  return [
    ...documents,
    ...p.support.map((data) => ({
      id: data.report_id,
      document: supportReportDocument({
        id: snapshot.id,
        created_at: snapshot.created_at,
        payload: { type: "support_report", export_definition: 1, data },
      }),
    })),
    { id: "account-mappings", document: accountMapping },
    { id: "officer-payroll-reconciliation", document: officer },
    { id: "source-document-index", document: evidence },
  ];
}
