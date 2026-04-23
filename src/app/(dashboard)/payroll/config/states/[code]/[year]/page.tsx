import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StateYearEditorContent } from "@/components/features/payroll/state-year-editor-content";
import { isDemoMode } from "@/lib/demo";
import type { StateTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "State Tax Year | Payroll Settings",
};

interface PageProps {
  params: Promise<{ code: string; year: string }>;
}

export default async function StateYearEditorPage({ params }: PageProps) {
  const { code, year: yearParam } = await params;
  const normalizedCode = code.toUpperCase();
  const year = Number(yearParam);

  if (
    !/^[A-Z]{2}$/.test(normalizedCode) ||
    !Number.isFinite(year) ||
    year < 2000 ||
    year > 2100
  ) {
    notFound();
  }

  let current: StateTaxConfig | null = null;
  let prefillSource: StateTaxConfig | null = null;

  if (!isDemoMode()) {
    const supabase = await createClient();

    // Load the current (state, year) row and - in case it doesn't exist yet
    // (create mode) - the most recent prior year for the same state. That
    // prior row is used to prefill stable fields like payment portals,
    // calculation method, and config shape, so adding a new year doesn't
    // mean retyping every URL and step from scratch.
    const [currentRes, priorYearsRes] = await Promise.all([
      supabase
        .from("state_tax_configs")
        .select("*")
        .eq("state_code", normalizedCode)
        .eq("tax_year", year)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("state_tax_configs")
        .select("*")
        .eq("state_code", normalizedCode)
        .lt("tax_year", year)
        .is("deleted_at", null)
        .order("tax_year", { ascending: false })
        .limit(1),
    ]);

    current = (currentRes.data as StateTaxConfig | null) ?? null;
    if (!current) {
      const prior = (priorYearsRes.data as StateTaxConfig[] | null) ?? [];
      prefillSource = prior[0] ?? null;
    }
  }

  return (
    <StateYearEditorContent
      stateCode={normalizedCode}
      year={year}
      initial={current}
      prefillSource={prefillSource}
    />
  );
}
