import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NetWorthDetailContent } from "@/components/features/net-worth/net-worth-detail-content";
import { parseLocalDate } from "@/lib/utils";
import { isDemoMode } from "@/lib/demo";
import { getDemoNetWorthEntry, demoNetWorth } from "@/lib/demo/data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const entry = getDemoNetWorthEntry(id);
    if (!entry) {
      return { title: "Entry Not Found" };
    }
    const date = parseLocalDate(entry.date);
    const monthName = date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    return { title: `Net Worth - ${monthName}` };
  }

  const supabase = await createClient();

  const { data: entry } = await supabase
    .from("net_worth")
    .select("date")
    .eq("id", id)
    .single();

  if (!entry) {
    return { title: "Entry Not Found" };
  }

  const date = parseLocalDate((entry as { date: string }).date);
  const monthName = date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return { title: `Net Worth - ${monthName}` };
}

export default async function NetWorthDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Handle demo mode
  if (isDemoMode()) {
    const entry = getDemoNetWorthEntry(id);
    if (!entry) {
      notFound();
    }
    // Sort entries by date ascending for navigation
    const sortedEntries = [...demoNetWorth].sort((a, b) => a.date.localeCompare(b.date));
    const currentIndex = sortedEntries.findIndex((e) => e.id === id);
    const previousEntry = currentIndex > 0 ? sortedEntries[currentIndex - 1] : null;
    const prevEntryId = currentIndex > 0 ? sortedEntries[currentIndex - 1].id : null;
    const nextEntryId = currentIndex < sortedEntries.length - 1 ? sortedEntries[currentIndex + 1].id : null;

    return (
      <NetWorthDetailContent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        entry={entry as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        previousEntry={previousEntry as any}
        prevEntryId={prevEntryId}
        nextEntryId={nextEntryId}
      />
    );
  }

  const supabase = await createClient();

  const { data: entry } = await supabase
    .from("net_worth")
    .select("*")
    .eq("id", id)
    .single();

  if (!entry) {
    notFound();
  }

  // Get previous entry for comparison (the one before this date)
  const { data: previousEntry } = await supabase
    .from("net_worth")
    .select("*")
    .is("deleted_at", null)
    .lt("date", (entry as any).date)
    .order("date", { ascending: false })
    .limit(1)
    .single();

  // Get next entry ID for navigation (prev is already from previousEntry above)
  const { data: nextNav } = await supabase
    .from("net_worth")
    .select("id")
    .is("deleted_at", null)
    .gt("date", (entry as any).date)
    .order("date", { ascending: true })
    .limit(1)
    .single();

  return (
    <NetWorthDetailContent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entry={entry as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      previousEntry={previousEntry as any}
      prevEntryId={(previousEntry as any)?.id ?? null}
      nextEntryId={nextNav?.id ?? null}
    />
  );
}
