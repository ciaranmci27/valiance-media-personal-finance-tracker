import { createClient } from "@/lib/supabase/server";
import { OrganizationEditorContent } from "@/components/features/payroll/organization-editor-content";
import { isDemoMode } from "@/lib/demo";
import type { OrganizationConfig } from "@/types/payroll";

export const metadata = {
  title: "Organization | Payroll Settings",
};

export default async function OrganizationConfigPage() {
  let organization: OrganizationConfig | null = null;

  if (!isDemoMode()) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("organization_config")
      .select("*")
      .is("deleted_at", null)
      .maybeSingle();
    organization = (data as OrganizationConfig | null) ?? null;
  }

  return <OrganizationEditorContent initial={organization} />;
}
