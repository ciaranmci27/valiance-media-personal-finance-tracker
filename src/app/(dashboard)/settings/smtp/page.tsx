import { SmtpSettingsContent } from "@/components/features/settings/smtp-settings-content";

export const metadata = {
  title: "SMTP & Email",
};

export default function SmtpSettingsPage() {
  const encryptionConfigured = !!process.env.SMTP_ENCRYPTION_KEY;
  return <SmtpSettingsContent encryptionConfigured={encryptionConfigured} />;
}
