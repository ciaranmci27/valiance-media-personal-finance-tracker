import { cookies } from "next/headers";
import { DashboardLayout } from "@/components/layout/dashboard-layout";

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

  const sidebarCookie = cookieStore.get("sidebar-collapsed");
  const initialSidebarCollapsed = sidebarCookie?.value === "true";

  return (
    <DashboardLayout
      initialPrivacyHidden={initialPrivacyHidden}
      initialSidebarCollapsed={initialSidebarCollapsed}
    >
      {children}
    </DashboardLayout>
  );
}
