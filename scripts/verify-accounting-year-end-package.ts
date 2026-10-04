import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import {
  PACKAGE_CONTENTS,
  PACKAGE_GROUPS,
  itemReady,
  packageChecks,
  packageScope,
  packageSummary,
  packageYears,
} from "../src/lib/accounting/year-end-package";
import {
  demoPayrollYear,
  demoReportData,
  demoReportDetail,
  demoSupportReport,
} from "../src/lib/accounting/demo-reports";
import { booksPackageDocuments } from "../src/lib/accounting/books-package-document";
import { booksPackageFiles, booksPackageZip } from "../src/lib/accounting/server/books-package-zip";
import { supportReportCatalog, type SupportReportData } from "../src/lib/accounting/support-reports";
import { reportCatalog } from "../src/lib/accounting/report-model";
import type { BooksPackageSnapshot } from "../src/lib/accounting/books-package";
import type { ReportDetail } from "../src/lib/accounting/reports";

/**
 * The year-end package: the calendar-year scope, the readiness checks (the
 * reports' own, reused), the contents and their ready state, and the
 * package in the branded layout (a cover with the readiness and contents,
 * then every report in order, each as a PDF and a CSV). Set
 * ACCOUNTING_REPORT_ARTIFACT_DIR to also write the cover and the package.
 */
async function main() {
  let checks = 0;
  const check = (a: unknown, b: unknown, message?: string) => {
    assert.deepEqual(a, b, message);
    checks++;
  };
  const today = "2026-10-03";

  // Calendar years: January 1 through today, or the year's end.
  check(packageYears(today), [2026, 2025, 2024, 2023]);
  check(packageScope(2026, today), { year: 2026, through: today });
  check(packageScope(2025, today), { year: 2025, through: "2025-12-31" });

  // The contents: every report and support report, the removed payroll
  // payable nowhere, each in one group.
  const ids = PACKAGE_CONTENTS.map((c) => c.id);
  check(ids.length, 16);
  for (const r of reportCatalog) check(ids.includes(r.id), true, `${r.id} is in the package`);
  for (const r of supportReportCatalog) check(ids.includes(r.id), true, `${r.id} is in the package`);
  check(ids.includes("payroll-liabilities"), false);
  check(PACKAGE_CONTENTS.every((c) => PACKAGE_GROUPS.includes(c.group)), true);
  check(PACKAGE_CONTENTS.filter((c) => !c.pdf).map((c) => c.id), ["source-document-index"]);

  // The demo year's checks, from the reports' own data.
  const scope = packageScope(2026, today);
  const support = (report_id: SupportReportData["report_id"]) =>
    demoSupportReport({ report_id, from: "2026-01-01", to: scope.through, offset: 0 });
  const core = demoReportData({ from: "2026-01-01", to: scope.through, mode: "posted", offset: 0 });
  const inputs = {
    core,
    tax: support("tax-workpapers"),
    contractor: support("contractor-worksheet"),
    payroll: support("payroll-register"),
    asset: support("asset-register"),
    loan: support("loan-register"),
  };
  const found = packageChecks(inputs);
  const byKey = (key: string) => found.find((c) => c.key === key)!;
  check(found.map((c) => c.key), ["balanced", "drafts", "categories", "tax", "months", "contractors", "assets", "loans", "payroll"]);
  check(byKey("balanced").status, "ready");
  check(byKey("drafts").title, "2 transactions are awaiting review", "the package counts reviewed transactions only");
  check(byKey("drafts").review, true);
  check(byKey("categories").status, "look", "the uncategorized card charges");
  check(byKey("categories").review, true);
  check(byKey("tax").status, "look");
  check(byKey("tax").title, "3 things are open in the tax workpapers");
  check(byKey("months").status, "info");
  check(byKey("contractors").title, "3 contractors need a W-9 or a decision");
  check(byKey("assets").title, "Equipment holds $380.00 more than the register");
  check(byKey("loans").status, "ready");
  check(byKey("payroll").status, "ready");
  const summary = packageSummary(found);
  check(summary, { ready: false, look: 5, text: "5 things need a look before you hand the year over." });
  check(itemReady(PACKAGE_CONTENTS.find((c) => c.id === "loan-register")!, found), true);
  check(itemReady(PACKAGE_CONTENTS.find((c) => c.id === "tax-workpapers")!, found), false);
  // While a report is still reading, its check waits and the year is not called ready.
  const partial = packageChecks({ ...inputs, tax: null });
  check(partial.find((c) => c.key === "tax")?.status, "waiting");
  check(packageSummary(partial).text, "Checking the year.");
  // The provider's year-to-date figures, from the books' own review items.
  check(packageChecks({ ...inputs, reviewItems: [{ kind: "payroll", message: "x" }] }).find((c) => c.key === "payroll")?.status, "info");
  // A year with nothing open is ready.
  const prior = packageChecks({
    core: demoReportData({ from: "2024-01-01", to: "2024-12-31", mode: "posted", offset: 0 }),
    tax: null,
    contractor: null,
    payroll: null,
    asset: null,
    loan: null,
  });
  check(prior.find((c) => c.key === "balanced")?.status, "ready");

  // A retained package from the demo books, in the branded layout.
  const ledger: ReportDetail["rows"] = [];
  for (;;) {
    const page = await demoReportDetail({ from: "2026-01-01", to: scope.through, mode: "posted", offset: ledger.length });
    ledger.push(...page.rows);
    if (ledger.length >= page.total) break;
  }
  const snapshot: BooksPackageSnapshot = {
    id: "00000000-0000-4000-8000-00000000b0c1",
    revision: core.revision,
    created_at: "2026-10-03T16:30:00Z",
    payload: {
      type: "books_package",
      export_definition: 1,
      year: 2026,
      through: scope.through,
      core,
      ledger,
      ledger_count: ledger.length,
      support: [inputs.payroll, inputs.contractor, inputs.asset, inputs.loan, inputs.tax],
      payroll: demoPayrollYear(2026, scope.through),
      review_items: [],
      notes: ["Financial statements, ledger, payroll, contractor, register and tax support share one captured revision."],
      account_mappings: [],
      document_index: [],
    },
  };
  const docs = booksPackageDocuments(snapshot, 2);
  check(docs.map((d) => d.id), ["cover", ...ids]);
  const cover = docs[0].document;
  check(cover.title, "Year-end package");
  check(cover.statement?.tiles.map((t) => t.label), ["Profit", "Journal lines", "Reports", "Readiness"]);
  check(cover.statement?.tiles[3].value, "5 open");
  check(cover.statement?.checks?.items.length, found.filter((c) => c.status === "look" || c.status === "info").length);
  check(cover.statement?.rows.filter((r) => r.kind === "heading").map((r) => r.label), PACKAGE_GROUPS);
  check(cover.statement?.rows.filter((r) => r.kind === "account").length, 16);
  // Every report in the branded layout: statements carry their statement.
  for (const d of docs.filter((x) => !["cover", "account-mappings", "officer-payroll-reconciliation", "source-document-index"].includes(x.id)))
    check(!!d.document.statement, true, `${d.id} is in layout 2`);
  // The original layout stays for packages kept earlier.
  check(booksPackageDocuments(snapshot).map((d) => d.id).includes("cover"), false);
  check(booksPackageDocuments(snapshot).length, 14);
  // The ZIP: a numbered PDF per report with the cover first, a CSV per report.
  const names: string[] = [];
  for await (const file of booksPackageFiles(snapshot, false, 2)) names.push(file.name);
  check(names.filter((n) => n.startsWith("csv/")).length, 16, "no CSV for the cover");
  check(names.includes("manifest.json") && names.includes("README.txt") && names.includes("retained-package.json"), true);
  const chunks: Uint8Array[] = [];
  for await (const chunk of booksPackageZip(snapshot, true, 2)) chunks.push(chunk);
  const zip = unzipSync(Buffer.concat(chunks));
  const pdfs = Object.keys(zip).filter((n) => n.startsWith("pdf/")).sort();
  check(pdfs[0], "pdf/00-cover.pdf");
  check(pdfs[1], "pdf/01-profit-loss.pdf");
  check(pdfs.length, 16, "every report but the document index has a PDF, plus the cover");
  check(Buffer.from(zip["pdf/00-cover.pdf"]).subarray(0, 5).toString(), "%PDF-");

  const dir = process.env.ACCOUNTING_REPORT_ARTIFACT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "year-end-package.zip"), Buffer.concat(chunks));
    for (const name of pdfs) await writeFile(join(dir, name.replace("pdf/", "")), zip[name]);
  }
  console.log(`Year-end package scope, readiness, contents and branded package: ${checks} assertions passed.`);
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
