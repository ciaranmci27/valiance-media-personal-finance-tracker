import { createClient } from "@/lib/supabase/server";
import { AccountSettingsContent } from "@/components/features/settings/account-settings-content";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Account Settings",
};

export default async function AccountSettingsPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return <AccountSettingsContent user={user} />;
}
