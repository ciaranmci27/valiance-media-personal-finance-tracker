import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/admin/require-auth";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { API_KEY_COLUMNS } from "@/lib/api/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revokes a key. Allowed for its member, its creator and the owner: the same
 * people who can see it. A revoke is final (public.api_keys_guard refuses to
 * clear it); revoking again answers with the key as it is.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  if (isDemoMode())
    return NextResponse.json(
      { error: "Demo mode is read-only." },
      { status: 403 },
    );
  const me = auth.access.member;
  const { id } = await params;
  const service = getServiceClient();

  const { data: key } = await service
    .from("api_keys")
    .select("id, team_member_id, created_by, revoked_at")
    .eq("id", id)
    .maybeSingle();
  const allowed =
    key &&
    (key.team_member_id === me.id ||
      key.created_by === me.id ||
      me.role === "owner");
  if (!allowed)
    return NextResponse.json({ error: "API key not found." }, { status: 404 });

  if (!key.revoked_at) {
    const { error } = await service
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null);
    if (error)
      return NextResponse.json(
        { error: "Could not revoke the key." },
        { status: 500 },
      );
  }
  const { data, error } = await service
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("id", id)
    .single();
  if (error || !data)
    return NextResponse.json(
      { error: "Could not revoke the key." },
      { status: 500 },
    );
  return NextResponse.json({ data });
}
