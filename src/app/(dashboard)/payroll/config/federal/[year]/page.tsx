import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FederalYearEditorContent } from "@/components/features/payroll/federal-year-editor-content";
import { isDemoMode } from "@/lib/demo";
import type { FederalTaxConfig } from "@/types/payroll";

export const metadata = {
  title: "Federal Tax Year | Payroll Settings",
};

interface PageProps {
  params: Promise<{ year: string }>;
}

export default async function FederalYearEditorPage({ params }: PageProps) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    notFound();
  }

  let current: FederalTaxConfig | null = null;
  let priorYear: FederalTaxConfig | null = null;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data: currentRow } = await supabase
      .from("federal_tax_configs")
      .select("*")
      .eq("tax_year", year)
      .is("deleted_at", null)
      .maybeSingle();
    current = (currentRow as FederalTaxConfig | null) ?? null;

    if (!current) {
      const { data: priorRow } = await supabase
        .from("federal_tax_configs")
        .select("*")
        .lt("tax_year", year)
        .is("deleted_at", null)
        .order("tax_year", { ascending: false })
        .limit(1)
        .maybeSingle();
      priorYear = (priorRow as FederalTaxConfig | null) ?? null;
    }
  }

  return (
    <FederalYearEditorContent
      year={year}
      initial={current}
      priorYear={priorYear}
    />
  );
}
