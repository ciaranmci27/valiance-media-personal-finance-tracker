import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/admin/require-auth";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { demoApiKeysPayload, demoCreatedKey } from "@/lib/demo/api-keys";
import { membersApiAccess } from "@/lib/api/member-access";
import { keyHolder, keyNameField, keyScopesField, refusedScopes } from "@/lib/api/key-access";
import {
  API_KEY_COLUMNS,
  generateApiKey,
  hashApiKey,
  keyPrefix,
} from "@/lib/api/keys";
import { API_KEY_LIFETIMES, DEFAULT_API_KEY_DAYS } from "@/lib/api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: keyNameField,
  scopes: keyScopesField,
  days: z
    .number()
    .int()
    .refine(
      (days) => API_KEY_LIFETIMES.some((option) => option.days === days),
      "Choose a listed lifetime",
    )
    .default(DEFAULT_API_KEY_DAYS),
  /** Owner only: create the key for this member (an agent, say) instead. */
  member_id: z.guid().optional(),
});

/**
 * The keys this person may see: their own and the ones they created. The
 * owner sees every key, the latest requests, and every member with what a
 * key for them could carry.
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  if (isDemoMode()) return NextResponse.json({ data: demoApiKeysPayload() });
  const me = auth.access.member;
  const isOwner = me.role === "owner";
  const service = getServiceClient();

  let query = service
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .order("created_at", { ascending: false });
  if (!isOwner)
    query = query.or(`team_member_id.eq.${me.id},created_by.eq.${me.id}`);
  const [keys, members, requests] = await Promise.all([
    query,
    // Names label the owner's view of everyone's keys; anyone else sees only their own.
    isOwner
      ? membersApiAccess(service).then(
          (data) => ({ data, error: null }),
          () => ({ data: null, error: true }),
        )
      : Promise.resolve({
          data: [
            { id: me.id, name: me.name, role: me.role, status: me.status },
          ],
          error: null,
        }),
    isOwner
      ? service
          .from("api_requests")
          .select(
            "id, at, api_key_id, team_member_id, method, path, operation, status, error_code, duration_ms, via",
          )
          .order("at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (keys.error || members.error || requests.error)
    return NextResponse.json(
      { error: "Could not load API keys." },
      { status: 500 },
    );

  return NextResponse.json({
    data: {
      keys: keys.data ?? [],
      members: members.data ?? [],
      requests: requests.data ?? [],
    },
  });
}

/**
 * Creates a key for the signed-in person, or, for the owner, for an agent
 * (who then never has to sign in to make one). The
 * key is generated and hashed here; each scope must be one the API offers
 * and one the key's member holds. The full key is returned once and never
 * stored.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth({ permission: "api.use" });
  if (!auth.authenticated) return auth.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  // Demo stays read-only: a valid request gets a fake, unstored key so the
  // show-once step can be seen, and nothing is written.
  if (isDemoMode())
    return parsed.success
      ? NextResponse.json({ data: demoCreatedKey(parsed.data) }, { status: 201 })
      : NextResponse.json({ error: "Demo mode is read-only." }, { status: 403 });
  const me = auth.access.member;

  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the form." },
      { status: 422 },
    );
  const scopes = [...new Set(parsed.data.scopes)];
  const service = getServiceClient();

  // Whose key: your own, or (owner only) an agent's. Editing a key's access
  // decides it the same way (lib/api/key-access.ts).
  const holder = await keyHolder(service, auth.access, parsed.data.member_id, "create");
  if (!holder.ok)
    return NextResponse.json({ error: holder.error }, { status: holder.status });
  const refusal = refusedScopes(scopes, holder);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 422 });
  const ownerId = holder.memberId;

  const secret = generateApiKey();
  const expiresAt = new Date(
    Date.now() + parsed.data.days * 86_400_000,
  ).toISOString();
  const { data, error } = await service
    .from("api_keys")
    .insert({
      name: parsed.data.name,
      key_prefix: keyPrefix(secret),
      key_hash: hashApiKey(secret),
      team_member_id: ownerId,
      created_by: me.id,
      scopes,
      expires_at: expiresAt,
    })
    .select(API_KEY_COLUMNS)
    .single();
  if (error || !data)
    return NextResponse.json(
      { error: "Could not create the key." },
      { status: 500 },
    );

  return NextResponse.json(
    { data: { key: data, secret } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
