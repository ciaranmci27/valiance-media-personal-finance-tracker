/**
 * What "Download your data" can export, shared by the Data Management screen
 * and the export route so the two never disagree. Personal finance datasets
 * come from the public tables the app already reads; the books come from
 * the accounting reads the accounting screens use.
 */
export type ExportDataset =
  | "income"
  | "expenses"
  | "net_worth"
  | "tax_estimates"
  | "accounts"
  | "transactions"
  | "payees"
  | "documents"
  | "bank_connections"
  | "payroll"
  | "statements";

export type ExportFormat = "json" | "csv";

export interface ExportDatasetOption {
  id: ExportDataset;
  label: string;
  description: string;
  /** The date range applies to this dataset. */
  ranged?: boolean;
}

export interface ExportGroup {
  id: "personal" | "books";
  title: string;
  description: string;
  datasets: ExportDatasetOption[];
}

export const EXPORT_GROUPS: ExportGroup[] = [
  {
    id: "personal",
    title: "Personal finance",
    description: "The income, expense and net worth pages.",
    datasets: [
      {
        id: "income",
        label: "Income",
        description: "Sources, monthly entries, amounts and line items.",
      },
      {
        id: "expenses",
        label: "Expenses",
        description: "Recurring expenses and their change history.",
      },
      {
        id: "net_worth",
        label: "Net worth",
        description: "Every net worth snapshot.",
      },
      {
        id: "tax_estimates",
        label: "Tax estimates",
        description: "Estimator inputs and payment plans.",
      },
    ],
  },
  {
    id: "books",
    title: "Accounting books",
    description: "The company ledger behind the Accounting pages.",
    datasets: [
      {
        id: "transactions",
        label: "Transactions",
        description: "Every entry with its lines, category and status.",
        ranged: true,
      },
      {
        id: "accounts",
        label: "Chart of accounts",
        description: "Accounts with their balances for the range.",
        ranged: true,
      },
      {
        id: "statements",
        label: "Profit and loss",
        description: "Totals by month and by account for the range.",
        ranged: true,
      },
      {
        id: "payees",
        label: "Payees",
        description: "Vendors, customers and contractor status.",
      },
      {
        id: "documents",
        label: "Receipts index",
        description: "Uploaded receipts and what they are linked to.",
      },
      {
        id: "bank_connections",
        label: "Bank connections",
        description: "Feeds, mapped accounts and discovered identities.",
      },
      {
        id: "payroll",
        label: "Payroll runs",
        description: "Each recorded run and what it debited.",
        ranged: true,
      },
    ],
  },
];

export const ALL_EXPORT_DATASETS: ExportDataset[] = EXPORT_GROUPS.flatMap((g) =>
  g.datasets.map((d) => d.id),
);

export const BOOKS_DATASETS = new Set<ExportDataset>(
  EXPORT_GROUPS.find((g) => g.id === "books")!.datasets.map((d) => d.id),
);

export function isExportDataset(value: string): value is ExportDataset {
  return (ALL_EXPORT_DATASETS as string[]).includes(value);
}

/** Query string for the export route. */
export function exportUrl(options: {
  datasets: ExportDataset[];
  format: ExportFormat;
  from?: string;
  to?: string;
}) {
  const params = new URLSearchParams();
  params.set("datasets", options.datasets.join(","));
  params.set("format", options.format);
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  return `/api/export?${params.toString()}`;
}
