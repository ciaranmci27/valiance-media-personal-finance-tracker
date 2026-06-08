import type { createClient } from "@/lib/supabase/client";

type AdminSupabaseClient = ReturnType<typeof createClient>;

export function monthStartFromDate(date: string): string {
  const [year, month] = date.split("-");
  return `${year}-${month}-01`;
}

export function todayIso(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultDateForMonth(month: string): string {
  const today = todayIso();
  return monthStartFromDate(today) === month ? today : month;
}

export async function ensureIncomeEntryForDate(
  supabase: AdminSupabaseClient,
  receivedDate: string,
): Promise<string> {
  const month = monthStartFromDate(receivedDate);

  const { data: existing, error: existingError } = await supabase
    .from("income_entries")
    .select("id, deleted_at")
    .eq("month", month)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing) {
    if (existing.deleted_at) {
      const { error: restoreError } = await supabase
        .from("income_entries")
        .update({ deleted_at: null })
        .eq("id", existing.id);

      if (restoreError) throw restoreError;
    }

    return existing.id;
  }

  const { data: created, error: createError } = await supabase
    .from("income_entries")
    .insert({ month })
    .select("id")
    .single();

  if (!createError && created) return created.id;

  const { data: retry, error: retryError } = await supabase
    .from("income_entries")
    .select("id, deleted_at")
    .eq("month", month)
    .single();

  if (retryError || !retry) throw createError || retryError;

  if (retry.deleted_at) {
    const { error: restoreError } = await supabase
      .from("income_entries")
      .update({ deleted_at: null })
      .eq("id", retry.id);

    if (restoreError) throw restoreError;
  }

  return retry.id;
}
