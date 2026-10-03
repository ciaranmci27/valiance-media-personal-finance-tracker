import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/admin/require-auth";
import { getServiceClient } from "@/lib/supabase/service";
import { isDemoMode } from "@/lib/demo";
import { hasPermission } from "@/lib/access-control";
import { membersApiAccess } from "@/lib/api/member-access";
import {
  API_KEY_COLUMNS,
  generateApiKey,
  hashApiKey,
  keyPrefix,
} from "@/lib/api/keys";
import {
  API_KEY_LIFETIMES,
  DEFAULT_API_KEY_DAYS,
  isApiScope,
} from "@/lib/api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name is too long"),
  scopes: z.array(z.string()).min(1, "Choose at least one scope"),
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
  if (isDemoMode())
    return NextResponse.json({ data: { keys: [], members: [], requests: [] } });
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
  if (isDemoMode())
    return NextResponse.json(
      { error: "Demo mode is read-only." },
      { status: 403 },
    );
  const me = auth.access.member;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the form." },
      { status: 422 },
    );
  const scopes = [...new Set(parsed.data.scopes)];
  const service = getServiceClient();

  // Whose key: your own, or (owner only) another member's.
  let ownerId = me.id;
  let holds: (scope: string) => boolean = (scope) =>
    isApiScope(scope) && hasPermission(auth.access, scope);
  if (parsed.data.member_id && parsed.data.member_id !== me.id) {
    if (me.role !== "owner")
      return NextResponse.json(
        { error: "Only the owner can create keys for agents." },
        { status: 403 },
      );
    const [target] = await membersApiAccess(service, [
      parsed.data.member_id,
    ]).catch(() => []);
    if (!target)
      return NextResponse.json(
        { error: "That person is not on the team." },
        { status: 422 },
      );
    // Agents only: a key made for a person would record their name on work
    // they did not do. People create their own keys.
    if (target.role !== "agent")
      return NextResponse.json(
        {
          error: `${target.name} is not an agent. People create their own keys.`,
        },
        { status: 422 },
      );
    if (target.status !== "active" || !target.has_sign_in)
      return NextResponse.json(
        {
          error: `${target.name} needs an active sign-in before a key can act as them.`,
        },
        { status: 422 },
      );
    if (!target.can_use_api)
      return NextResponse.json(
        {
          error: `${target.name} does not hold 'Use the API'. Grant it in Team > Access first.`,
        },
        { status: 422 },
      );
    ownerId = target.id;
    holds = (scope) => isApiScope(scope) && target.api_scopes.includes(scope);
  } else if (!me.auth_user_id)
    return NextResponse.json(
      { error: "Sign in with your own account to create a key." },
      { status: 403 },
    );

  const refused = scopes.filter((scope) => !holds(scope));
  if (refused.length > 0)
    return NextResponse.json(
      {
        error: `Scopes ${ownerId === me.id ? "not available to you" : "this person does not hold"}: ${refused.join(", ")}`,
      },
      { status: 422 },
    );

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
