import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/admin/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { teamError } from "@/lib/team/errors";
import type { TeamMember } from "@/lib/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.email("Enter a valid email address").max(200),
});

/**
 * Changes a member's sign-in email. The auth account and the team row must
 * move together, so this runs server-side: owners for anyone, people for
 * themselves.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  if (isDemoMode())
    return NextResponse.json(
      { error: "Demo mode is read-only." },
      { status: 403 },
    );
  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      {
        error: "Enter a valid email address.",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  const email = parsed.data.email.trim().toLowerCase();

  const supabase = await createClient();
  const { data: target, error: loadError } = await supabase
    .from("team_members")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadError)
    return NextResponse.json({ error: teamError(loadError) }, { status: 400 });
  const member = target as TeamMember | null;
  if (!member)
    return NextResponse.json({ error: "Member not found." }, { status: 404 });

  const isOwner = auth.access.member.role === "owner";
  const isSelf = member.id === auth.access.member.id;
  if (!isOwner && !isSelf)
    return NextResponse.json(
      { error: "Only an owner can change someone else's email." },
      { status: 403 },
    );
  if (!member.auth_user_id)
    return NextResponse.json(
      { error: "This member has no sign-in account to update." },
      { status: 400 },
    );

  let service: ReturnType<typeof getServiceClient>;
  try {
    service = getServiceClient();
  } catch {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 500 },
    );
  }
  const { error: authError } = await service.auth.admin.updateUserById(
    member.auth_user_id,
    { email, email_confirm: true },
  );
  if (authError) {
    const duplicate = /already|exists|registered/i.test(authError.message);
    return NextResponse.json(
      {
        error: duplicate
          ? "Someone with that email already has an account."
          : authError.message,
      },
      { status: duplicate ? 409 : 500 },
    );
  }

  // The row follows the account; the service role skips the actor rules.
  const { data: updated, error } = await service
    .from("team_members")
    .update({ email })
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    await service.auth.admin
      .updateUserById(member.auth_user_id, { email: member.email })
      .catch(() => undefined);
    return NextResponse.json({ error: teamError(error) }, { status: 400 });
  }
  return NextResponse.json({ member: updated });
}
