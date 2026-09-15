import { DataSettingsContent } from "@/components/features/settings/data-settings-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Data Settings",
};

export default async function DataSettingsPage() {
  if (!(await canAccess("settings.manage"))) return <AccessDenied area="Export & Storage" />;
  return <DataSettingsContent />;
}
