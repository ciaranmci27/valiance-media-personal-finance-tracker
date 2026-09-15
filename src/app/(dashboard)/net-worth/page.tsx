import { createClient } from "@/lib/supabase/server";
import { NetWorthContent } from "@/components/features/net-worth/net-worth-content";
import { isDemoMode } from "@/lib/demo";
import { demoNetWorth } from "@/lib/demo/data";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Net Worth",
};

export default async function NetWorthPage() {
  if (!(await canAccess("net_worth.read"))) return <AccessDenied area="Net Worth" />;
  // Return demo data if in demo mode
  if (isDemoMode()) {
    return <NetWorthContent entries={demoNetWorth} />;
  }

  const supabase = await createClient();

  const { data: entries } = await supabase
    .from("net_worth")
    .select("*")
    .is("deleted_at", null)
    .order("date", { ascending: false });

  return <NetWorthContent entries={entries || []} />;
}
