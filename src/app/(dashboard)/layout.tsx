import { redirect } from "next/navigation";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { AccountTheme } from "@/components/layout/account-theme";
import { AccessUnavailable } from "@/components/layout/access-unavailable";
import { resolveAccess } from "@/lib/team/access";
import { isLocalOrTestEnv } from "@/lib/env";

// Force dynamic rendering so every request resolves the signed-in member.
export const dynamic = "force-dynamic";

export default async function DashboardServerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Who is signed in and what they may touch. Strangers and suspended
  // accounts never see the shell; the sidebar and pages read the rest.
  const resolved = await resolveAccess();
  if (resolved.state === "signed_out") redirect("/login");
  if (resolved.state === "not_member")
    return <AccessUnavailable state="not_member" email={resolved.email} />;
  if (resolved.state === "suspended")
    return <AccessUnavailable state="suspended" />;

  // The account's theme wins over whatever this device last used; the
  // privacy eye is applied the same way by PrivacyProvider inside the shell.
  return (
    <>
      <AccountTheme theme={resolved.access.member.theme_preference} />
      <DashboardLayout
        accountingTestMode={
          isLocalOrTestEnv && Boolean(process.env.ACCOUNTING_TEST_DATABASE_URL)
        }
        initialAccess={resolved.access}
        syntheticAccess={resolved.synthetic}
      >
        {children}
      </DashboardLayout>
    </>
  );
}
