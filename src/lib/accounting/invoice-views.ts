export interface InvoiceSummary {
  id: string;
  version: number;
  source_id: string;
  number: string;
  customer_name: string;
  project_name: string;
  customer_id: string | null;
  project_id: string | null;
  status: string;
  deleted: boolean;
  payment_claimed: boolean;
  issue_date: string | null;
  due_date: string | null;
  total_cents: string;
  collected_cents: string;
  adjusted_cents: string;
  outstanding_cents: string;
  needs_review: boolean;
  overdue: boolean;
  history_unavailable: boolean;
  issues: string[];
  head_revision: string;
  accepted_revision: string | null;
  first_observed_at: string;
  history_origin: string;
}
export interface InvoiceSource {
  id: string;
  version: number;
  name: string;
  kind: "crm" | "manual" | "wave";
  enabled: boolean;
  last_complete_at: string | null;
  last_snapshot_id: string | null;
}
export interface InvoiceList {
  as_of: string;
  revision: string;
  count: number;
  offset: number;
  totals: {
    outstanding_cents: string;
    overdue_cents: string;
    review_count: number;
    history_unavailable: number;
  };
  invoices: InvoiceSummary[];
  sources: InvoiceSource[];
  runs: {
    id: string;
    source_id: string;
    status: string;
    cursor: number;
    item_count: number | null;
    started_at: string;
    completed_at: string | null;
    error: string;
  }[];
  quarantined: number;
}
export interface InvoiceRevision {
  invoice_id: string;
  revision: string;
  body: unknown;
  body_hash: string;
  body_text: string;
  observed_at: string;
  received_at: string;
  issues: string[];
  customer_id: string | null;
  project_id: string | null;
  effective_date?: string;
}
export interface InvoiceHistoryRevision {
  revision: string;
  body_hash: string;
  observed_at: string;
  received_at: string;
  issues: string[];
  effective_date: string | null;
  reason: string | null;
  automatic: boolean | null;
}
export interface InvoiceHistoryPage<T> {
  count: number;
  offset: number;
  rows: T[];
}
export interface InvoiceInboxRow {
  id: string;
  source_id: string;
  source_name: string;
  event_id: string;
  received_at: string;
  error: string;
  invoice_id: string | null;
  review_id: string | null;
  snapshot_id: string | null;
  reason: string | null;
  reviewed_at: string | null;
}
export interface InvoiceInbox extends InvoiceHistoryPage<InvoiceInboxRow> {
  snapshots: {
    snapshot_id: string;
    source_id: string;
    source_name: string;
    snapshot_at: string;
    completed_at: string;
    item_count: number;
  }[];
}
export function invoiceObservedAt(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Phoenix",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : "Unavailable";
}
export interface InvoicePaymentLine {
  key: string;
  type: string;
  description: string;
  amount_cents: string;
  collected_cents: string;
  adjusted_cents: string;
  available_cents: string;
  last_account_id: string | null;
}
export interface InvoiceAllocation {
  id: string;
  invoice_id: string;
  invoice_revision: string;
  invoice_number: string;
  line_key: string;
  amount_cents: string;
  account_id: string;
  account_name: string;
  entry_id: string;
  original_allocation_id: string | null;
  remaining_refundable_cents: string;
}
export interface InvoiceSettlement {
  id: string;
  kind:
    | "receipt"
    | "historical"
    | "refund"
    | "reversal"
    | "unlink"
    | "credit_application";
  settled_on: string;
  bank_account_id: string | null;
  fee_account_id: string | null;
  gross_cents: string;
  cash_cents: string;
  fee_cents: string;
  reason: string;
  document_id: string | null;
  original_settlement_id: string | null;
  reversed_by_id: string | null;
  entries: string[];
  invoice_versions: { id: string; version: number }[];
  allocations: InvoiceAllocation[];
}
export interface InvoiceAdjustment {
  id: string;
  kind: "discount" | "write_off" | "reversal";
  line_key: string;
  amount_cents: string;
  adjusted_on: string;
  reason: string;
  document_id: string | null;
  reverses_id: string | null;
  reversed_by_id: string | null;
}
export interface InvoicePayments {
  invoice_id: string;
  invoice_version: number;
  accepted_revision: string | null;
  customer_id: string | null;
  project_id: string | null;
  totals: {
    billed_cents: string;
    collected_cents: string;
    adjusted_cents: string;
    outstanding_cents: string;
  };
  lines: InvoicePaymentLine[];
  count: number;
  offset: number;
  settlements: InvoiceSettlement[];
  adjustment_count: number;
  adjustments: InvoiceAdjustment[];
}
export interface InvoiceDetail {
  id: string;
  version: number;
  source_id: string;
  external_id: string;
  head_revision: string;
  history_origin: string;
  first_observed_at: string;
  current: InvoiceRevision;
  accepted: InvoiceRevision | null;
  payments: InvoicePayments;
  history: {
    revision: string;
    body_hash: string;
    observed_at: string;
    received_at: string;
    issues: string[];
    effective_date: string | null;
    reason: string | null;
    automatic: boolean | null;
  }[];
}
export interface CustomerFund {
  id: string;
  version: number;
  customer_id: string | null;
  customer_name: string;
  liability_account_id: string;
  account_name: string;
  bank_account_id: string;
  entry_id: string;
  mode: "new" | "historical";
  received_on: string;
  amount_cents: string;
  cash_cents: string;
  fee_cents: string;
  remaining_cents: string;
  review_state: "unreviewed" | "holding" | "refundable";
  policy_reason: string;
  reason: string;
  document_id: string | null;
  voided_on: string | null;
}
export interface CustomerFundList {
  as_of: string;
  offset: number;
  count: number;
  totals: { remaining_cents: string; unreviewed_cents: string };
  funds: CustomerFund[];
}
export interface CustomerFundDetail extends CustomerFund {
  movement_count: number;
  movements: {
    id: string;
    kind:
      | "application"
      | "refund"
      | "recognition"
      | "reversal"
      | "deposit_reversal";
    effective_date: string;
    amount_cents: string;
    entry_id: string | null;
    settlement_id: string | null;
    reverses_id: string | null;
    reversed_by_id: string | null;
    reason: string;
    document_id: string | null;
  }[];
}
/** Safely render retained source fields, including records quarantined for bad types. */
export function invoiceText(body: unknown, ...path: string[]): string {
  let value = body;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : "";
}
/** An editable proposal; exact integers and stable remainders preserve every cent. */
export function proposeInvoiceAllocation(
  lines: Pick<InvoicePaymentLine, "key" | "available_cents">[],
  amount: string,
): Record<string, string> {
  if (
    !/^(0|[1-9][0-9]*)$/.test(amount) ||
    new Set(lines.map((l) => l.key)).size !== lines.length
  )
    throw new Error("Enter a valid amount and unique invoice lines.");
  const requested = BigInt(amount);
  const available = lines.map((line) => {
    if (!/^(0|[1-9][0-9]*)$/.test(line.available_cents))
      throw new Error("An invoice line has an invalid remaining amount.");
    return { key: line.key, amount: BigInt(line.available_cents) };
  });
  const total = available.reduce((n, l) => n + l.amount, BigInt(0));
  if (requested > total)
    throw new Error(
      "The payment exceeds the remaining invoice lines. Record excess money as a customer deposit.",
    );
  if (total === BigInt(0))
    return Object.fromEntries(available.map((l) => [l.key, "0"]));
  const parts = available.map((l) => ({
    key: l.key,
    amount: (requested * l.amount) / total,
    remainder: (requested * l.amount) % total,
  }));
  let remainder = requested - parts.reduce((n, l) => n + l.amount, BigInt(0));
  for (const part of [...parts].sort((a, b) =>
    a.remainder === b.remainder
      ? a.key.localeCompare(b.key)
      : a.remainder > b.remainder
        ? -1
        : 1,
  )) {
    if (remainder === BigInt(0)) break;
    part.amount++;
    remainder--;
  }
  return Object.fromEntries(parts.map((l) => [l.key, l.amount.toString()]));
}
