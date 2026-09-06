/** Synthetic data only. Source labels do not imply a Wave adapter is implemented. */
export const fixtureOwner = "10000000-0000-4000-8000-000000000001";
export const fixtureAccountId = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const fixtureAccounts = [
  {
    id: fixtureAccountId(1),
    code: "1000",
    name: "Checking",
    account_type: "asset",
    normal_side: "debit",
  },
  {
    id: fixtureAccountId(2),
    code: "1200",
    name: "Transfers in transit",
    account_type: "asset",
    normal_side: "debit",
  },
  {
    id: fixtureAccountId(3),
    code: "2000",
    name: "Business card",
    account_type: "liability",
    normal_side: "credit",
  },
  {
    id: fixtureAccountId(4),
    code: "3000",
    name: "Shareholder capital",
    account_type: "equity",
    normal_side: "credit",
  },
  {
    id: fixtureAccountId(5),
    code: "4000",
    name: "Consulting revenue",
    account_type: "income",
    normal_side: "credit",
  },
  {
    id: fixtureAccountId(6),
    code: "5100",
    name: "Software",
    account_type: "expense",
    normal_side: "debit",
  },
  {
    id: fixtureAccountId(7),
    code: "6000",
    name: "Officer compensation",
    account_type: "expense",
    normal_side: "debit",
  },
  {
    id: fixtureAccountId(8),
    code: "2300",
    name: "Net salary payable",
    account_type: "liability",
    normal_side: "credit",
  },
  {
    id: fixtureAccountId(9),
    code: "1010",
    name: "Savings",
    account_type: "asset",
    normal_side: "debit",
  },
  {
    id: fixtureAccountId(10),
    code: "2950",
    name: "Due to shareholder",
    account_type: "liability",
    normal_side: "credit",
  },
] as const;
export const fixtureEntries = [
  {
    date: "2025-12-01",
    memo: "Initial shareholder capital",
    lines: [
      [1, "1000000"],
      [4, "-1000000"],
    ],
  },
  {
    date: "2025-12-15",
    memo: "Prior year consulting receipt",
    lines: [
      [1, "200000"],
      [5, "-200000"],
    ],
  },
  {
    date: "2026-01-05",
    memo: "Partial receipt against a $5,000 invoice",
    lines: [
      [1, "200000"],
      [5, "-200000"],
    ],
  },
  {
    date: "2026-01-10",
    memo: "Card software purchase",
    lines: [
      [6, "12000"],
      [3, "-12000"],
    ],
  },
  {
    date: "2026-01-20",
    memo: "Pay business card",
    lines: [
      [3, "12000"],
      [1, "-12000"],
    ],
  },
  {
    date: "2026-01-25",
    memo: "Salary journal",
    lines: [
      [7, "100000"],
      [8, "-100000"],
    ],
  },
  {
    date: "2026-01-26",
    memo: "Net pay clears liability",
    lines: [
      [8, "100000"],
      [1, "-100000"],
    ],
  },
  {
    date: "2026-01-28",
    memo: "Client refund",
    lines: [
      [5, "10000"],
      [1, "-10000"],
    ],
  },
  {
    date: "2026-01-29",
    memo: "Software paid personally",
    lines: [
      [6, "3000"],
      [10, "-3000"],
    ],
  },
  {
    date: "2026-01-31",
    memo: "Transfer leaves checking",
    lines: [
      [2, "50000"],
      [1, "-50000"],
    ],
  },
  {
    date: "2026-02-02",
    memo: "Transfer reaches savings",
    lines: [
      [9, "50000"],
      [2, "-50000"],
    ],
  },
] as const;
