import { fixtureAccounts, fixtureEntries } from "./fixtures";
import type { AccountingWorkspace } from "./contracts";

/** Fixed, independently checked fixture report. Never used for live reporting. */
export function getAccountingDemo(): AccountingWorkspace {
  const opening = [
    "1200000",
    "0",
    "0",
    "-1000000",
    "-200000",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];
  const debits = [
    "200000",
    "50000",
    "12000",
    "0",
    "10000",
    "15000",
    "100000",
    "100000",
    "50000",
    "0",
  ];
  const credits = [
    "172000",
    "50000",
    "12000",
    "0",
    "200000",
    "0",
    "0",
    "100000",
    "0",
    "3000",
  ];
  const accounts = fixtureAccounts.map((a) => ({ ...a, is_archived: false }));
  return {
    legal_name: "Synthetic company",
    revision: "0",
    from: "2026-01-01",
    to: "2026-02-28",
    accounts,
    entry_count: 9,
    draft_count: 0,
    entries: fixtureEntries
      .slice(2)
      .map((e, i) => ({
        id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        entry_date: e.date,
        memo: e.memo,
        status: "posted" as const,
        version: 2,
        primary_origin: "manual",
        reverses_entry_id: null,
        reversed_by_entry_id: null,
        created_at: `${e.date}T12:00:00Z`,
        lines: e.lines.map(([n, amount], j) => ({
          id: `${i}-${j}`,
          account_id: fixtureAccounts[Number(n) - 1].id,
          amount_cents: amount,
          memo: "",
        })),
      }))
      .reverse(),
    balances: accounts.map((a, i) => ({
      ...a,
      opening_cents: opening[i],
      debit_cents: debits[i],
      credit_cents: credits[i],
      period_cents: String(BigInt(debits[i]) - BigInt(credits[i])),
      ending_cents: String(
        BigInt(opening[i]) + BigInt(debits[i]) - BigInt(credits[i]),
      ),
    })),
    reports: {
      income_cents: "190000",
      expense_cents: "115000",
      net_income_cents: "75000",
      assets_cents: "1278000",
      liabilities_cents: "3000",
      equity_cents: "1000000",
      retained_cents: "200000",
      year_income_cents: "75000",
      balance_difference_cents: "0",
      trial_balance_cents: "0",
    },
  };
}
