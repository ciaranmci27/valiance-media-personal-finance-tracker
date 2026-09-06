import { cookies } from "next/headers";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import {isLocalOrTestEnv} from "@/lib/env";

// Force dynamic rendering to ensure fresh cookie reads for user preferences
export const dynamic = "force-dynamic";

export default async function DashboardServerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read user preferences from cookies during SSR
  // This allows us to render the correct state server-side, preventing any flash
  const cookieStore = await cookies();

  const privacyCookie = cookieStore.get("data-hidden");
  const initialPrivacyHidden = privacyCookie?.value === "true";

  return (
    <DashboardLayout initialPrivacyHidden={initialPrivacyHidden} accountingTestMode={isLocalOrTestEnv&&Boolean(process.env.ACCOUNTING_TEST_DATABASE_URL)}>
      {children}
    </DashboardLayout>
  );
}
