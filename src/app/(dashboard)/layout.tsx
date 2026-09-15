import { redirect } from "next/navigation";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
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

  // The account's theme and privacy eye win over whatever this device last
  // used. The root layout's blocking script only knows localStorage, so on a
  // fresh device this inline script sets both before the dashboard paints.
  const { theme_preference: theme, privacy_hidden: hidden } =
    resolved.access.member;
  const initScript = [
    "(function(){try{",
    theme
      ? `document.documentElement.setAttribute('data-theme','${theme}');localStorage.setItem('theme','${theme}');`
      : "",
    `document.documentElement.setAttribute('data-hidden','${hidden}');localStorage.setItem('data-hidden','${hidden}');document.cookie='data-hidden=${hidden}; path=/; max-age=31536000; SameSite=Lax';`,
    "}catch(e){}})();",
  ].join("");

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: initScript }} />
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
