import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/admin/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { teamError } from "@/lib/team/errors";
import { TEAM_ROLES } from "@/lib/access-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.email("Enter a valid email address").max(200),
  password: z.string().min(8, "At least 8 characters").max(200),
  role: z.enum(TEAM_ROLES),
});

/**
 * Adds a person to the team. The auth user is created with the service role
 * (email confirmed, no mail sent) and the team row with the caller's session,
 * so the guard applies its usual rules: admins add members, owners add anyone.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth({ permission: "team.manage" });
  if (!auth.authenticated) return auth.response;
  if (isDemoMode())
    return NextResponse.json(
      { error: "Demo mode is read-only." },
      { status: 403 },
    );

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      {
        error: "Check the highlighted fields.",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  const body = parsed.data;
  const email = body.email.trim().toLowerCase();

  if (body.role !== "member" && auth.access.member.role !== "owner")
    return NextResponse.json(
      { error: "Only an owner can add an owner or an admin." },
      { status: 403 },
    );

  let service: ReturnType<typeof getServiceClient>;
  try {
    service = getServiceClient();
  } catch {
    return NextResponse.json(
      {
        error:
          "SUPABASE_SERVICE_ROLE_KEY is not configured, so accounts cannot be created here.",
      },
      { status: 500 },
    );
  }

  const { data: created, error: createError } =
    await service.auth.admin.createUser({
      email,
      password: body.password,
      email_confirm: true,
      user_metadata: { display_name: body.name },
    });
  if (createError || !created.user) {
    const message = createError?.message ?? "Account creation failed";
    const duplicate = /already|exists|registered/i.test(message);
    return NextResponse.json(
      {
        error: duplicate
          ? "Someone with that email already has an account."
          : message,
      },
      { status: duplicate ? 409 : 500 },
    );
  }

  const supabase = await createClient();
  const { data: member, error } = await supabase
    .from("team_members")
    .insert({
      auth_user_id: created.user.id,
      name: body.name,
      email,
      role: body.role,
    })
    .select("*")
    .single();
  if (error) {
    // The account without a team row would be a stranger; remove it again.
    await service.auth.admin.deleteUser(created.user.id).catch(() => undefined);
    const duplicate = error.code === "23505";
    return NextResponse.json(
      { error: teamError(error) },
      { status: duplicate ? 409 : 400 },
    );
  }

  return NextResponse.json({ member }, { status: 201 });
}
