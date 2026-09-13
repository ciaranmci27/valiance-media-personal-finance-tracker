# Patriot payroll import

Entry point: Accounting > Records > Payroll > Import payroll.

1. Choose Patriot.
2. Follow the download instructions: Reports > Payroll Reports > Payroll Details, choose the pay-date range and employees, retain all sources/locations, group by Check, and click Download Spreadsheet. The screen links to Patriot's official report guide.
3. Upload the original CSV. Confirm expense/liability accounts and officer classifications on the first import. Choices are retained in the imported payroll's source metadata.
4. Review each payroll, link matching journals, and confirm the selected records.

The CSV's pay date controls the journal date. Neither the upload date nor a monthly scheduling assumption changes it. Groups use company, pay date, and pay period; employee checks are combined within each group. Weekly, biweekly, monthly, multi-year, and overlapping exports use the same flow. Reviews show 20 payrolls per page. Limits: 2 MB, 10,000 paycheck rows, 500 payroll groups, and 50 employees per payroll.

Repeated groups with identical source facts are skipped. Changed amounts, voided records, changed employee scope, reused periods, locked periods, and nearby unlinked payroll journals are flagged. A matching posted journal requires the same date and account totals, has no reversal, and cannot already belong to another payroll. Linking preserves the original journal, including Wave's consolidated tax liability line.

Selected payrolls commit in one database transaction under the shared accounting write lock. A failure rolls back the selected batch. Concurrent or retried uploads reuse the existing records. The server reparses the stored, hash-verified original CSV at confirmation; it never accepts amounts or journal bodies from the browser. The original evidence is attached to each imported payroll. Owner authentication and same-origin checks apply.

Import creates an accrual entry for wages, employer payroll taxes, net salary payable, and taxes payable. Bank withdrawals must subsequently clear those liabilities through the existing transaction workflow. The importer neither processes payroll nor pays employees or tax agencies.

## Explicit limits

- Employee names must appear in the single-employee report header or an Employee/Employee Name column. An all-employees summary without individual names is rejected.
- Gross/net reconciliation must be exact. Nonzero unsupported deductions, reimbursements, benefits, and custom tax columns stop the upload with a named-column error. Zero-valued unknown columns do not affect accounting.
- Voids, negative amounts, ambiguous duplicate checks, and separate off-cycle payrolls that reuse an existing period require manual review. They are never silently combined with previously imported records.
- The importer does not infer taxable wages or verified YTD facts from tax amounts. Existing payroll reporting retains its evidence requirements.

## Verification

- `verify-accounting-patriot.ts`: annual/overlapping reports, 52 weekly payrolls, named employees, unsupported inputs, duplicate retries, changed facts, company mismatch, historical journal linking, closed periods, permissions, evidence integrity, and all-or-nothing rollback. Runs against either canonical schema or migrations.
- `verify-accounting-patriot-http.ts`: actual local HTTP uploads, preview, confirmation, retries, invalid origin/file/selections, and simultaneous PostgreSQL imports. Requires an explicitly marked disposable fixture database/app.
- Existing payroll accounting/reporting suites and canonical migration parity passed.
- TypeScript and accounting lint checked. Bundled browser tested desktop 1920x1080 and mobile 390x844 with synthetic data, including first-time mapping, successful import, remembered mapping, duplicate results, and console inspection.
- Both user-supplied CSVs were parsed and balanced read-only. No live payrolls or journals were created.

Deployment requires the updated `20260911210826_accounting_review_state.sql` migration (or its Patriot function delta if the earlier migration was already applied).
