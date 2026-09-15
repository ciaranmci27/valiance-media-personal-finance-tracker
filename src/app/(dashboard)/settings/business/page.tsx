import { BusinessSettingsContent } from "@/components/features/settings/business-settings-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Business Settings",
};

export default async function BusinessSettingsPage() {
  if (!(await canAccess("settings.manage"))) return <AccessDenied area="Business settings" />;
  return <BusinessSettingsContent />;
}
