# Wave export findings

Read-only inspection, 2026-09-07. This document contains structural findings and aggregate checks only. Real exports remain under ignored `admin/.local/wave/`. No transaction identifiers, account numbers, customer details or transaction text are reproduced here. The four receivable/payable account names below are included at the owner's explicit request on 2026-09-07.

## Inventory and layout

13 CSV files were inspected:

| Export | Data rows / layout |
| --- | --- |
| Accounting ledger | 4,637 data rows, 23 columns |
| Customers | 1 data row, 27 columns |
| Vendors | 0 data rows, 17 columns |
| Bill items | 0 data rows, 12 columns |
| Profit and loss | Four reports: 2023, 2024, 2025, 2026, each through December 31 |
| Balance sheet | Five reports: December 31 of 2022, 2023, 2024, 2025, 2026 |

Report periods were read from `Date Range:` and `As of` metadata, not filenames. All nine reports declare `Report Type: Accrual (Paid & Unpaid)`. Report rows use three columns with labels in the second and amounts in the third; metadata precedes the report table. Total CSV row counts, including metadata, are 43, 37, 30 and 35 for the respective P&Ls, and 34, 33, 34, 35 and 34 for the respective balance sheets. The import reconciliation reference date is 2026-12-31, as directed by the brief.

### Exact ledger headers, in order

1. `Transaction ID`
2. `Transaction Date`
3. `Account Name`
4. `Transaction Description`
5. `Transaction Line Description`
6. `Amount (One column)`
7. A literal single-space header: ` `
8. `Debit Amount (Two Column Approach)`
9. `Credit Amount (Two Column Approach)`
10. `Other Accounts for this Transaction`
11. `Customer`
12. `Vendor`
13. `Invoice Number`
14. `Bill Number`
15. `Notes / Memo`
16. `Amount Before Sales Tax`
17. `Sales Tax Amount`
18. `Sales Tax Name`
19. `Transaction Date Added`
20. `Transaction Date Last Modified`
21. `Account Group`
22. `Account Type`
23. `Account ID`

### Exact auxiliary headers

Customers: `customer_name`, `email`, `contact_first_name`, `contact_last_name`, `customer_currency`, `account_number`, `phone`, `fax`, `mobile`, `toll_free`, `website`, `country`, `province/state`, `address_line_1`, `address_line_2`, `city`, `postal_code/zip_code`, `shipping_address`, `ship-to_contact`, `ship-to_country`, `ship-to_province/state`, `ship-to_address_line_1`, `ship-to_address_line_2`, `ship-to_city`, `ship-to_postal_code/zip_code`, `ship-to_phone`, `delivery_instructions`.

Vendors: `vendor_name`, `email`, `contact_first_name`, `contact_last_name`, `vendor_currency`, `account_number`, `phone`, `fax`, `mobile`, `toll_free`, `website`, `country`, `province/state`, `address_line_1`, `address_line_2`, `city`, `postal_code/zip_code`.

Bill items: `vendor`, `description`, `invoice_num`, `po_so`, `account`, `product`, `amount`, `quantity`, `bill_date`, `currency`, `due_date`, `taxes`.

## Journal grouping and identifiers

- The 4,637 rows form 2,269 distinct, nonblank `Transaction ID` groups. Every group balances exactly using explicit debit minus credit, and every group has one financial date and one transaction description.
- Group sizes: 2,239 groups of two lines, one of three, 18 of four, one of five, seven of seven, two of nine and one of twelve. These are journal lines, not independent bank transactions.
- Only one ledger export is supplied. IDs are internally consistent in that file; stability across separate exports cannot be verified from these files. No cross-export stability claim is made. The owner confirmed this is a known limit, not a blocker; verify it on the next export during the parallel run.
- All 4,637 `Account ID` fields are blank. There are 49 distinct account names, each consistently associated with one group/type combination. The brief already specifies name mapping through `accounts.external_names.wave`; retain the original blank ID in raw import data rather than inventing a provider ID. Mapping must reject ambiguity.
- No row has simultaneous debit and credit amounts or negative debit/credit values. Two rows contain zero on both sides.
- The single amount column has account-dependent signs: 2,676 rows match debit minus credit and 1,963 match its opposite, counting the two zero rows in both. The adapter must use the explicit debit and credit columns.
- Ledger row counts by year: 2022: 35; 2023: 1,644; 2024: 1,462; 2025: 862; 2026: 634.

## Cash basis and receivable/payable activity

**The brief's required absence-of-activity check does not pass.** There are 83 nonzero lines across four accounts typed Receivable or Payable: six Receivable lines and 77 Payable lines. Receivable activity occurs in 2022 and 2023; Payable activity occurs in 2023 through 2026. Yearly aggregate amounts and the resolved owner decision are in the phase log, Q1.

Every `Invoice Number` and `Bill Number` is blank. Bill items and vendors contain headers only, and no invoices export is supplied. There is no evidence here of Wave-issued invoices or bills, but that does not prove the receivable/payable balances represent no accrual activity. Their business meaning cannot be determined safely from type labels alone.

The owner stated cash and accrual reports are numerically identical. The supplied files themselves are labeled accrual, so an independent cash-versus-accrual comparison is unavailable. Preserve them as the designated parity targets, but do not silently remove or convert receivable/payable entries. The owner answered the required question on 2026-09-07: preserve every entry exactly, with no conversion.

| Wave account name | Wave group/type | Target type/subtype |
| --- | --- | --- |
| Amazon Unavailable Balance | Asset / Receivable | asset / receivable |
| Amazon Unavailable Balance - CAD | Asset / Receivable | asset / receivable |
| Amazon Unavailable Balance - MX | Asset / Receivable | asset / receivable |
| Taxes Payable | Liability / Payable | liability / payroll_liability |

There are three receivable accounts, not one. Per the owner, receivables are opening carryovers from Bench, booked on 2022-12-31 and collected in 2023. Revenue was recognized before these books begin, so the 2023 collection credits receivables and never creates income. Across the receivable accounts, opening debits of $9,748.36 and subsequent credits of $9,757.83 leave a **-$9.47 residual balance**. Preserve that residual without a write-off or conversion.

The owner identifies Taxes Payable as payroll-adjustment clearing, not unpaid bills; it nets to zero in each affected year. Preserve the original liability classification and map it to `payroll_liability`. Preserve the original Wave type labels in import provenance while using the target schema's natural subtypes.

## Opening balances and annual closing

- No ledger rows predate 2022-12-31. That date contains 35 rows in ten transaction groups, consistent with the specified history boundary.
- Opening types comprise nine Credit Card rows, thirteen Retained Earnings: Profit rows, seven Cash and Bank rows, two Operating Expense rows, three Receivable rows and one Inventory row.
- Both opening expense lines are nonzero, but their aggregate net is zero. They must not be assumed to be disposable merely because they offset.
- Two zero lines form one entirely zero-valued opening group. The target forbids zero journal lines; the owner approved raw-only treatment in log Q2: retain the group with an explicit exclusion reason and create no journal. Every other group has at least two nonzero lines.
- No Retained Earnings: Profit rows occur after the opening date. A description scan found no closing/year-end candidate groups. This is evidence against an annual closing adjustment being necessary, not proof that descriptions identify every possible closing entry.
- No opening or closing normalization was performed. The unchanged ledger's aggregate parity below provides no reason to invent one.

## Independent aggregate parity

The inspector calculates reports from explicit debit/credit amounts and transaction dates. P&L uses Income and Expense groups, separating Cost of Goods Sold. Balance sheet uses cumulative Asset, Liability and Equity amounts, with cumulative income less expenses included in equity.

| Target | Checks | Difference |
| --- | --- | --- |
| 2023, 2024, 2025, 2026 P&Ls | Income, cost of goods sold, gross profit, operating expenses, net profit | Zero cents for all 20 comparisons |
| 2022, 2023, 2024, 2025, 2026 balance sheets | Assets, liabilities, equity | Zero cents for all 15 comparisons |

All nine reports match these aggregate checks exactly. This does not claim account-by-account parity, application report-engine parity, successful import, or independent verification of cash-basis treatment. No additional source file is currently needed for these aggregate checks.

The future history checks remain the specified 2022-12-31 opening balance sheet and annual P&L totals for 2023 through 2026. There is no 2022 annual P&L check. No adapter, history check records or real-data import has been created during this inspection.

## Reproduction

From the repository root, run `python admin/scripts/inspect-accounting-wave.py` with Python 3 and the ignored exports in place. The script uses only the standard library and performs no database/network calls or file writes. It emits headers, structural counts and aggregate comparisons, never individual transaction values or source identifiers.

Verified summary:

> Wave structure inspection: 13 files read; 4637 ledger rows; 2269 balanced groups; 83 receivable/payable-type rows; 9/9 report aggregate totals match.

Step status and pending decisions are maintained only in `accounting-phase1-log.md`.
