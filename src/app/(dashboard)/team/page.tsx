import { TeamContent } from "@/components/features/team/team-content";
import { AccessDenied } from "@/components/features/access-denied";
import { canAccess } from "@/lib/team/access";

export const metadata = {
  title: "Team",
};

export default async function TeamPage() {
  if (!(await canAccess("team.read"))) return <AccessDenied area="Team" />;
  return <TeamContent />;
}
