import { Suspense } from "react";
import { TaxSettingsContent } from "@/components/features/settings/tax-settings-content";

export const metadata = {
  title: "Tax Estimator Settings",
};

export default function TaxSettingsPage() {
  return (
    <Suspense>
      <TaxSettingsContent />
    </Suspense>
  );
}
