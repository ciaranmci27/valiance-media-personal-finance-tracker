import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountingRpc } from "@/lib/accounting/server/read";
import type { JournalEntry, JournalLine } from "@/lib/accounting/contracts";
import type { ReportAccount, ReportData } from "@/lib/accounting/reports";
import type { AccountProfile } from "@/lib/accounting/workflows";
import {
  presentTransaction,
  isTransactionReviewed,
} from "@/lib/accounting/transactions";
import { readCents } from "@/lib/accounting/money";
import { ApiError, databaseError } from "./http";

/**
 * The books as the key's member: each call goes through
 * public.api_accounting, which re-checks the key in SQL and acts as its member
 * for that one transaction, so the books' own reader check decides.
 */
export function booksClient(
  service: SupabaseClient,
  keyHash: string,
): AccountingRpc {
  return {
    rpc: (name, args = {}) =>
      service.rpc("api_accounting", {
        p_key_hash: keyHash,
        p_name: name,
        p_args: args,
      }),
  };
}

export async function booksRead<T>(
  client: AccountingRpc,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw databaseError(error.message, "accounting.read");
  return data as T;
}

function dateIn(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Today in the books' time zone (business_profile.books_timezone), as YYYY-MM-DD. */
export async function booksToday(service: SupabaseClient): Promise<string> {
  const { data } = await service
    .from("business_profile")
    .select("books_timezone")
    .eq("id", 1)
    .maybeSingle();
  const zone =
    (data?.books_timezone as string | undefined) || "America/Phoenix";
  try {
    return dateIn(zone);
  } catch {
    return dateIn("America/Phoenix");
  }
}

export function yearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

/** A date range with the API's defaults: January 1 of `to`'s year through today, books time zone. */
export async function booksRange(
  service: SupabaseClient,
  from?: string,
  to?: string,
) {
  const end = to ?? (await booksToday(service));
  const start = from ?? yearStart(end);
  if (start > end)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "from must be on or before to.",
      { reason: "invalid_range" },
    );
  return { from: start, to: end };
}

/** The account facts presentTransaction needs, from a report's account rows. */
export function profilesFrom(accounts: ReportAccount[]): AccountProfile[] {
  return accounts.map((a) => {
    const row = a as ReportAccount & {
      system_purpose?: string | null;
      version?: number;
    };
    return {
      account_id: a.id,
      version: row.version ?? 0,
      purpose: a.purpose ?? row.system_purpose ?? null,
      cash_kind: a.cash_kind as AccountProfile["cash_kind"],
      parent_account_id: a.parent_account_id,
      subtype: a.subtype,
      type: a.account_type,
    };
  });
}

/** Fields the SQL row carries beyond the screens' JournalEntry contract. */
type EntryRow = Omit<JournalEntry, "lines"> & {
  kind?: string;
  origin?: string;
  payee_id?: string | null;
  /** The contact's name (accounting.entry_detail). */
  payee_name?: string | null;
  posted_at?: string | null;
  lines: (JournalLine & { cash_class?: string | null })[];
};

/** One transaction as the Transactions screen reads it, without audit history or internal links. */
export type { EntryRow };
export function presentEntry(
  entry: EntryRow,
  accounts: Map<string, string>,
  profiles: AccountProfile[],
) {
  const view = presentTransaction(entry, profiles);
  const name = (id: string) => accounts.get(id) ?? "Unknown account";
  return {
    id: entry.id,
    date: entry.entry_date,
    memo: entry.memo ?? "",
    description: entry.source_description ?? null,
    status: entry.status,
    // Every write to a draft takes the version it was read at.
    version: entry.version,
    reviewed: isTransactionReviewed(entry),
    kind: entry.context?.kind ?? entry.kind ?? "manual",
    origin: entry.primary_origin ?? entry.origin ?? "manual",
    amount_cents: view.amount.toString(),
    bank_account: view.bankLine
      ? { id: view.bankLine.account_id, name: name(view.bankLine.account_id) }
      : null,
    categories: view.categoryLines.map((line) => ({
      account_id: line.account_id,
      account_name: name(line.account_id),
      // Shown from the bank's side: money in is positive, as on the screen.
      amount_cents: (-readCents(line.amount_cents)).toString(),
    })),
    transfer: view.transfer,
    categorized: view.categorized,
    // The books call a contact a payee; the API says contact.
    contact_id: entry.payee_id ?? null,
    contact_name: entry.payee_name ?? null,
    // What categorization rules match on, and how this description was
    // categorized before: the basis for proposing a rule or a category.
    descriptor_key: entry.descriptor_key ?? null,
    prior_treatment: entry.prior_treatment
      ? {
          last_category: entry.prior_treatment.last_category,
          contact_id: entry.prior_treatment.payee_id ?? null,
          count: entry.prior_treatment.count,
          last_category_name: entry.prior_treatment.last_category
            ? (accounts.get(entry.prior_treatment.last_category) ?? null)
            : null,
        }
      : null,
    lines: entry.lines.map((line) => ({
      id: line.id,
      account_id: line.account_id,
      account_name: name(line.account_id),
      amount_cents: readCents(line.amount_cents).toString(),
      memo: line.memo ?? "",
      cash_class: line.cash_class ?? null,
    })),
    reverses_entry_id: entry.reverses_entry_id ?? null,
    reversed_by_entry_id: entry.reversed_by_entry_id ?? null,
    created_at: entry.created_at,
    posted_at: entry.posted_at ?? null,
  };
}

/** A register row cut to what a list needs, so 100 fit in one agent answer. */
export function compactEntry(row: ReturnType<typeof presentEntry>) {
  const memo = row.memo || row.description || "";
  return {
    id: row.id,
    date: row.date,
    amount_cents: row.amount_cents,
    description: memo.length > 80 ? `${memo.slice(0, 77)}...` : memo,
    contact_name: row.contact_name,
    categories: row.categories.map((category) => category.account_name),
    bank_account: row.bank_account?.name ?? null,
    status: row.status,
    reviewed: row.reviewed,
    transfer: row.transfer,
  };
}

/** Account names and presentation profiles, read once for a page of transactions. */
export async function accountIndex(client: AccountingRpc, today: string) {
  const report = await booksRead<ReportData>(client, "report", {
    kind: "summary",
    params: { from: yearStart(today), to: today },
  });
  return {
    names: new Map(report.accounts.map((a) => [a.id, a.name])),
    profiles: profilesFrom(report.accounts),
  };
}

export function quality(data: ReportData) {
  const q = data.quality;
  return {
    draft_count: q.draft_count,
    unbalanced_drafts: q.unbalanced_drafts,
    uncategorized_lines: q.uncategorized_lines,
    unclassified_cash_lines: q.unclassified_cash_lines,
  };
}

/** Runs one books write as the key's member: drafts only, checked in SQL (public.api_books_command). */
export async function booksCommand(
  service: SupabaseClient,
  keyHash: string,
  operation:
    | "draft.create"
    | "draft.update"
    | "categorize"
    | "split"
    | "categorize.bulk"
    | "rule.create"
    | "contact.create"
    | "contact.update"
    | "contact.assign"
    | "missed.create",
  key: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await service.rpc("api_books_command", {
    p_key_hash: keyHash,
    p_operation: operation,
    p_key: key,
    p_args: args,
  });
  if (error) throw databaseError(error.message, "accounting.draft");
  return (data ?? {}) as Record<string, unknown>;
}

/**
 * The API says contact where the books say payee: a body's contact_id goes to
 * the books as payee_id, and only when it was sent (null clears it).
 */
export function payeeFields<T extends { contact_id?: string | null }>(
  body: T,
): Omit<T, "contact_id"> & { payee_id?: string | null } {
  const { contact_id, ...rest } = body;
  return contact_id === undefined ? rest : { ...rest, payee_id: contact_id };
}

/** A rule's conditions or actions, with payee_id said as contact_id for the API. */
export function contactRuleFields(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const { payee_id, ...rest } = value ?? {};
  return payee_id === undefined ? rest : { ...rest, contact_id: payee_id };
}

/** A full link into the app, so it works wherever the agent sends it (Telegram, email). */
export function appUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

/** What a books write answers: the draft, its new version, and where the owner reviews it. */
export function writtenDraft(
  result: Record<string, unknown>,
  fallbackId: string,
  origin: string,
) {
  const id = typeof result.id === "string" ? result.id : fallbackId;
  return {
    id,
    version: typeof result.version === "number" ? result.version : null,
    status: "draft" as const,
    review_url: appUrl(origin, `/accounting?view=journal&entry=${id}`),
  };
}

/** Where the owner sees one contact: Manage > Contacts, opened on it. */
export function contactUrl(origin: string, id: string): string {
  return appUrl(origin, `/accounting?view=manage&section=payees&contact=${id}`);
}

/** Case-insensitive name search and a page, for the books lists an agent reads. */
export function pageOf<T>(
  rows: T[],
  query: { offset: number; limit: number },
): {
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  rows: T[];
} {
  const rowsOut = rows.slice(query.offset, query.offset + query.limit);
  const reached = query.offset + rowsOut.length;
  return {
    total: rows.length,
    offset: query.offset,
    limit: query.limit,
    next_offset: rowsOut.length > 0 && reached < rows.length ? reached : null,
    rows: rowsOut,
  };
}

export function nameMatches(name: unknown, q: string | undefined): boolean {
  return (
    !q ||
    String(name ?? "")
      .toLowerCase()
      .includes(q.toLowerCase())
  );
}
