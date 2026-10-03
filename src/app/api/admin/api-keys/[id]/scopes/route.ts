import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/admin/require-auth";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { demoEditedKey } from "@/lib/demo/api-keys";
import { editKeyAccess, keyAccessSchema } from "@/lib/api/key-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Replaces a key's scopes (Settings > API > Edit access). The secret stays
 * the same, so whatever uses the key keeps working and gets the new access
 * from its next request. Same people and the same scope rules as creating a
 * key; see editKeyAccess for the checks.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth({ permission: "api.use" });
  if (!auth.authenticated) return auth.response;
  const { id } = await params;
  const input = await request.json().catch(() => null);

  // Demo stays read-only: a valid edit of a demo key answers with the key as
  // it would be, and nothing is written.
  if (isDemoMode()) {
    const parsed = keyAccessSchema.safeParse(input);
    const key = parsed.success ? demoEditedKey(id, parsed.data.scopes) : null;
    return key
      ? NextResponse.json({ data: key })
      : NextResponse.json({ error: "Demo mode is read-only." }, { status: 403 });
  }

  const result = await editKeyAccess(getServiceClient(), auth.access, id, input);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
