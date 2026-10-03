import { ApiSettingsContent } from "@/components/features/settings/api-settings-content";
import { AccessDenied } from "@/components/features/access-denied";
import { resolveAccess } from "@/lib/team/access";
import { hasPermission } from "@/lib/access-control";
import { API_SCOPE_KEYS } from "@/lib/api/scopes";

export const metadata = {
  title: "API",
};

export default async function ApiSettingsPage() {
  const resolved = await resolveAccess();
  if (resolved.state !== "ok" || !hasPermission(resolved.access, "api.use")) return <AccessDenied area="API" />;
  const { access } = resolved;
  return (
    <ApiSettingsContent
      available={API_SCOPE_KEYS.filter((scope) => hasPermission(access, scope))}
      isOwner={access.member.role === "owner"}
      memberId={access.member.id}
    />
  );
}
