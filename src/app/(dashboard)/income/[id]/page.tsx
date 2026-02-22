import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { IncomeDetailContent } from "@/components/features/income/income-detail-content";
import { parseLocalDate } from "@/lib/utils";
import { isDemoMode } from "@/lib/demo";
import {
  getDemoIncomeEntry,
  getDemoAdjacentIncomeEntries,
  demoIncomeSources,
} from "@/lib/demo/data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const entry = getDemoIncomeEntry(id);
    if (!entry) {
      return { title: "Entry Not Found" };
    }
    const date = parseLocalDate(entry.month);
    const monthName = date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    return { title: `Income - ${monthName}` };
  }

  const supabase = await createClient();

  const { data: entry } = await supabase
    .from("income_entries")
    .select("month")
    .eq("id", id)
    .single();

  if (!entry) {
    return { title: "Entry Not Found" };
  }

  const date = parseLocalDate((entry as { month: string }).month);
  const monthName = date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return { title: `Income - ${monthName}` };
}

export default async function IncomeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const entry = getDemoIncomeEntry(id);
    if (!entry) {
      notFound();
    }
    const { prevEntryId, nextEntryId } = getDemoAdjacentIncomeEntries(entry.month);
    return (
      <IncomeDetailContent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        entry={entry as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sources={demoIncomeSources as any}
        prevEntryId={prevEntryId}
        nextEntryId={nextEntryId}
      />
    );
  }

  const supabase = await createClient();

  // Fetch the entry with its amounts
  const { data: entry } = await supabase
    .from("income_entries")
    .select(
      `
      *,
      income_amounts (
        id,
        source_id,
        amount,
        income_sources (
          id,
          name,
          color
        )
      )
    `
    )
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!entry) {
    notFound();
  }

  // Fetch all income sources for the form
  const { data: sources } = await supabase
    .from("income_sources")
    .select("*")
    .is("deleted_at", null)
    .order("sort_order");

  // Fetch adjacent entries for navigation
  const [{ data: prevEntry }, { data: nextEntry }] = await Promise.all([
    supabase
      .from("income_entries")
      .select("id")
      .is("deleted_at", null)
      .lt("month", entry.month)
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("income_entries")
      .select("id")
      .is("deleted_at", null)
      .gt("month", entry.month)
      .order("month", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  return (
    <IncomeDetailContent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entry={entry as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sources={(sources || []) as any}
      prevEntryId={prevEntry?.id || null}
      nextEntryId={nextEntry?.id || null}
    />
  );
}
