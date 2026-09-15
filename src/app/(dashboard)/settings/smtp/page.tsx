import { SmtpSettingsContent } from "@/components/features/settings/smtp-settings-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "SMTP & Email",
};

export default async function SmtpSettingsPage() {
  if (!(await canAccess("settings.manage"))) return <AccessDenied area="SMTP & Email" />;
  const encryptionConfigured = !!process.env.SMTP_ENCRYPTION_KEY;
  return <SmtpSettingsContent encryptionConfigured={encryptionConfigured} />;
}
