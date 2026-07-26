import type { SupabaseClient } from "@supabase/supabase-js";
import { monthStartFromDate, todayIso } from "@/lib/income-ledger";

// Turns a CRM invoice webhook into income ledger rows by RECONCILING to the
// invoice's current state: the ledger always mirrors the invoice. Each row is
// stamped with (external_source, external_ref, external_type) so paid, un-pay,
// re-pay, edit, and delete all collapse to "make reality match the invoice".

export const INVOICE_SYNC_SOURCE = "vm_app_invoice";

// hourly + fixed -> Contracts, recurring -> Retainers.
// reimbursement is intentionally omitted (cost recovery, not income).
const TYPE_TO_SOURCE_SLUG: Record<string, string> = {
  hourly: "contracts",
  fixed: "contracts",
  recurring: "retainers",
};

const TYPE_LABEL: Record<string, string> = {
  hourly: "Hourly",
  fixed: "Contract",
  recurring: "Retainer",
};

interface InvoiceEventData {
  invoice: {
    id: string;
    invoice_number?: string | null;
    status?: string;
    paid?: boolean;
    paid_date?: string | null;
    date?: string | null;
    amount?: number | string;
    invoice_type?: string;
  };
  project?: { id?: string; name?: string | null } | null;
  totals_by_type?: Record<string, number | string> | null;
}

export interface InvoiceEvent {
  id: string;
  type: string;
  sequence: number;
  created_at?: string;
  data: InvoiceEventData;
}

export interface ReconcileResult {
  status: "applied" | "removed" | "stale";
  upserted: number;
  removed: number;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

function parseReceivedDate(event: InvoiceEvent): string {
  return isoDate(event.data.invoice.paid_date) ?? isoDate(event.created_at) ?? todayIso();
}

function buildNotes(projectName: string, type: string, invoiceNumber: string): string {
  const label = TYPE_LABEL[type] ?? type;
  const prefix = projectName ? `${projectName} - ` : "";
  const suffix = invoiceNumber ? ` (Inv #${invoiceNumber})` : "";
  return `${prefix}${label} payment${suffix}`;
}

// Server variant of the ledger helper (income-ledger.ts is typed for the
// browser client). Finds, restores, or creates the monthly income entry.
async function ensureIncomeEntryForDate(
  supabase: SupabaseClient,
  receivedDate: string,
): Promise<string> {
  const month = monthStartFromDate(receivedDate);

  const { data: existing, error } = await supabase
    .from("income_entries")
    .select("id, deleted_at")
    .eq("month", month)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    if (existing.deleted_at) {
      const { error: restoreError } = await supabase
        .from("income_entries")
        .update({ deleted_at: null })
        .eq("id", existing.id);
      if (restoreError) throw restoreError;
    }
    return existing.id as string;
  }

  const { data: created, error: createError } = await supabase
    .from("income_entries")
    .insert({ month })
    .select("id")
    .single();
  if (!createError && created) return created.id as string;

  // Lost a create race: re-read and restore if needed.
  const { data: retry, error: retryError } = await supabase
    .from("income_entries")
    .select("id, deleted_at")
    .eq("month", month)
    .single();
  if (retryError || !retry) throw createError ?? retryError;
  if (retry.deleted_at) {
    const { error: restoreError } = await supabase
      .from("income_entries")
      .update({ deleted_at: null })
      .eq("id", retry.id);
    if (restoreError) throw restoreError;
  }
  return retry.id as string;
}

export async function reconcileInvoiceIncome(
  supabase: SupabaseClient,
  event: InvoiceEvent,
): Promise<ReconcileResult> {
  const invoice = event.data.invoice;
  const invoiceId = invoice.id;
  const sequence = Number(event.sequence) || 0;

  // Idempotency + out-of-order guard: never apply an event older than or equal
  // to the last one we processed for this invoice.
  const { data: cursor, error: cursorError } = await supabase
    .from("webhook_receipts")
    .select("last_sequence")
    .eq("source", INVOICE_SYNC_SOURCE)
    .eq("external_ref", invoiceId)
    .maybeSingle();
  if (cursorError) throw cursorError;
  if (cursor && Number(cursor.last_sequence) >= sequence) {
    return { status: "stale", upserted: 0, removed: 0 };
  }

  const isPaid = event.type !== "invoice.deleted" && invoice.paid === true;

  // Defensive: a "paid" event with no totals_by_type at all is malformed — don't
  // let it wipe previously-synced income. A legitimately reimbursement-only or
  // zero invoice still carries a totals_by_type object (possibly empty) and is
  // allowed through so its (absent) rows reconcile normally.
  if (isPaid && event.data.totals_by_type == null) {
    return { status: "stale", upserted: 0, removed: 0 };
  }

  // Desired rows: line-item type -> { source slug, amount }.
  const desired = new Map<string, { slug: string; amount: number }>();
  if (isPaid) {
    const totals = event.data.totals_by_type ?? {};
    for (const [type, slug] of Object.entries(TYPE_TO_SOURCE_SLUG)) {
      const amount = round2(Number(totals[type] ?? 0));
      if (amount !== 0) desired.set(type, { slug, amount });
    }
  }

  // Resolve the source slugs we need to ids. Fail loudly (=> retry) rather than
  // silently dropping money if a category was renamed/removed.
  const neededSlugs = Array.from(new Set(Array.from(desired.values()).map((d) => d.slug)));
  const slugToId = new Map<string, string>();
  if (neededSlugs.length > 0) {
    const { data: sources, error: sourcesError } = await supabase
      .from("income_sources")
      .select("id, slug")
      .in("slug", neededSlugs)
      .is("deleted_at", null);
    if (sourcesError) throw sourcesError;
    for (const s of sources ?? []) slugToId.set(s.slug as string, s.id as string);
    for (const slug of neededSlugs) {
      if (!slugToId.has(slug)) {
        throw new Error(`Income source "${slug}" not found; cannot map invoice ${invoiceId}`);
      }
    }
  }

  // Existing synced rows for this invoice, including soft-deleted so we can
  // revive rather than duplicate. Prefer an active row if duplicates exist.
  const { data: existingRows, error: existingError } = await supabase
    .from("income_line_items")
    .select("id, external_type, deleted_at")
    .eq("external_source", INVOICE_SYNC_SOURCE)
    .eq("external_ref", invoiceId);
  if (existingError) throw existingError;

  const existingByType = new Map<string, { id: string; deleted_at: string | null }>();
  for (const r of existingRows ?? []) {
    const type = r.external_type as string;
    const prev = existingByType.get(type);
    if (!prev || (prev.deleted_at && !r.deleted_at)) {
      existingByType.set(type, { id: r.id as string, deleted_at: (r.deleted_at as string | null) ?? null });
    }
  }

  const receivedDate = parseReceivedDate(event);
  const projectName = event.data.project?.name?.trim() || "";
  const invoiceNumber = (invoice.invoice_number ?? "").toString();

  let upserted = 0;
  let removed = 0;

  // One monthly entry for all desired rows (same received_date).
  const entryId = desired.size > 0 ? await ensureIncomeEntryForDate(supabase, receivedDate) : null;

  for (const [type, { slug, amount }] of desired) {
    const sourceId = slugToId.get(slug)!;
    const notes = buildNotes(projectName, type, invoiceNumber);
    const existing = existingByType.get(type);
    if (existing) {
      const { error } = await supabase
        .from("income_line_items")
        .update({
          entry_id: entryId,
          source_id: sourceId,
          received_date: receivedDate,
          amount,
          notes,
          deleted_at: null,
        })
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("income_line_items").insert({
        entry_id: entryId,
        source_id: sourceId,
        received_date: receivedDate,
        amount,
        notes,
        external_source: INVOICE_SYNC_SOURCE,
        external_ref: invoiceId,
        external_type: type,
      });
      if (error) throw error;
    }
    upserted++;
  }

  // Soft-delete rows whose type is no longer present (un-pay, delete, or a type
  // dropped from the invoice).
  for (const [type, existing] of existingByType) {
    if (desired.has(type) || existing.deleted_at) continue;
    const { error } = await supabase
      .from("income_line_items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw error;
    removed++;
  }

  const status: ReconcileResult["status"] = isPaid ? "applied" : "removed";
  const { error: cursorUpsertError } = await supabase.from("webhook_receipts").upsert(
    {
      source: INVOICE_SYNC_SOURCE,
      external_ref: invoiceId,
      last_sequence: sequence,
      last_event_id: event.id,
      last_status: status,
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "source,external_ref" },
  );
  if (cursorUpsertError) throw cursorUpsertError;

  return { status, upserted, removed };
}
