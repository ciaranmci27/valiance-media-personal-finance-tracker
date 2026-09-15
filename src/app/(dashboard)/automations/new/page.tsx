import { AutomationFormContent } from "@/components/features/automations/automation-form-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "New Automation",
};

export default async function NewAutomationPage() {
  if (!(await canAccess("automations.manage"))) return <AccessDenied area="Automations" />;
  return <AutomationFormContent />;
}
