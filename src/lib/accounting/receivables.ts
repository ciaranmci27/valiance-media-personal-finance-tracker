import { z } from "zod";

/**
 * Invoice sources and the deposits linked to their invoices: the read shapes
 * (accounting.receivables, entry_detail's invoice_links and
 * invoice_suggestion) and the owner's commands. The source connection itself
 * is saved through /api/accounting/invoice-sources, which encrypts the key.
 */
const id = z.guid();
const version = z.number().int().min(0).max(2147483646);
const cents = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, "Enter an amount above zero.");

export const invoiceCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("invoice.link"),
      id,
      entry_id: id,
      expected_version: version,
      allocations: z
        .array(z.object({ invoice_id: id, amount_cents: cents }).strict())
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("invoice.unlink"),
      id,
      expected_version: version,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({ type: z.literal("invoice.retry"), id, expected_version: version })
    .strict(),
  z
    .object({
      type: z.literal("invoice.auto_link"),
      id,
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
]);
export type InvoiceCommand = z.infer<typeof invoiceCommandSchema>;

export type LinkSyncState =
  | "pending"
  | "synced"
  | "removing"
  | "removed"
  | "failed";
export type SourceStatus = "active" | "paused" | "auth_failed" | "disconnected";
export type LineType =
  | "hourly"
  | "fixed"
  | "recurring"
  | "reimbursement"
  | "tax";

export interface InvoiceSource {
  id: string;
  version: number;
  name: string;
  base_url: string;
  status: SourceStatus;
  auto_link: boolean;
  account_map: Partial<Record<LineType, string>>;
  party_map: Record<string, string>;
  last_synced_at: string | null;
  last_error: string;
  invoice_count: number;
  pending_pushes: number;
  failed_pushes: number;
  projects: {
    project_ref: string;
    project_name: string;
    customer_name: string;
    party_id: string | null;
  }[];
}
export interface InvoiceLink {
  id: string;
  version: number;
  entry_id: string;
  entry_date: string;
  amount_cents: string;
  matched_by: "rule" | "owner";
  sync_state: LinkSyncState;
  last_error: string;
  live: boolean;
}
export interface SourceInvoice {
  id: string;
  source_id: string;
  number: string;
  project_ref: string;
  project_name: string;
  customer_name: string;
  party_id: string | null;
  party_name: string | null;
  issue_date: string;
  due_date: string | null;
  status: "draft" | "issued" | "paid" | "void";
  removed_at: string | null;
  total_cents: string;
  linked_cents: string;
  outstanding_cents: string;
  source_paid_cents: string;
  links: InvoiceLink[];
}
export interface ReceivablesView {
  revision: string;
  accrual_start: string | null;
  accounts: Partial<
    Record<
      "accounts_receivable" | "unbilled_revenue" | "deferred_revenue",
      string
    >
  >;
  sources: InvoiceSource[];
  total: number;
  invoices: SourceInvoice[];
  /** With matches=true: deposits since the accrual start never linked that look like invoice payments. */
  matches?: InvoiceMatch[] | null;
}
export interface InvoiceMatch {
  entry_id: string;
  version: number;
  entry_date: string;
  memo: string;
  payee_name: string | null;
  amount_cents: string;
  suggestion: InvoiceSuggestion;
}
/** On an entry: an invoice this deposit pays. */
export interface EntryInvoiceLink {
  id: string;
  version: number;
  invoice_id: string;
  number: string;
  project_name: string;
  amount_cents: string;
  matched_by: "rule" | "owner";
  sync_state: LinkSyncState;
  last_error: string;
  live: boolean;
}
/** On a deposit with money still unapplied: the open invoices it looks like it pays, and why. */
export interface InvoiceSuggestion {
  reason: "exact_client" | "sum_client" | "exact_amount";
  auto: boolean;
  ambiguous: boolean;
  remaining_cents: string;
  invoices: {
    invoice_id: string;
    number: string;
    project_name: string;
    issue_date: string;
    amount_cents: string;
  }[];
}

export const LINE_TYPE_LABELS: Record<LineType, string> = {
  hourly: "Hourly work",
  fixed: "Fixed fees",
  recurring: "Retainers",
  reimbursement: "Reimbursements",
  tax: "Sales tax",
};
export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  active: "Connected",
  paused: "Paused",
  auth_failed: "Key refused",
  disconnected: "Disconnected",
};
export const SUGGESTION_REASONS: Record<InvoiceSuggestion["reason"], string> = {
  exact_client: "Same client, exact amount",
  sum_client: "Adds up to this client's open invoices",
  exact_amount: "Only open invoice at this amount",
};
/** Where a link stands with the invoicing system, in a few words. */
export function linkStateLabel(link: {
  sync_state: LinkSyncState;
  live: boolean;
}) {
  if (!link.live) return "No longer counts";
  return {
    pending: "Sending to invoices",
    synced: "Marked paid",
    removing: "Removing",
    removed: "Removed",
    failed: "Not sent",
  }[link.sync_state];
}
/** "INV-1042", or "INV-1042 + INV-1043", or "3 invoices" for a deposit's chip. */
export function invoiceChipLabel(numbers: string[]) {
  const named = numbers.map((n) => n || "Invoice");
  if (named.length <= 2) return named.join(" + ");
  return `${named.length} invoices`;
}
