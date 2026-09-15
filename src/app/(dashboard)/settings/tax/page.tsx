import { Suspense } from "react";
import { TaxSettingsContent } from "@/components/features/settings/tax-settings-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Tax Estimator Settings",
};

export default async function TaxSettingsPage() {
  if (!(await canAccess("settings.manage"))) return <AccessDenied area="Tax years" />;
  return (
    <Suspense>
      <TaxSettingsContent />
    </Suspense>
  );
}
