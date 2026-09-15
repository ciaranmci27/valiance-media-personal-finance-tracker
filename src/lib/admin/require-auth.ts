import { NextResponse } from 'next/server';
import { resolveAccess } from '@/lib/team/access';
import {
  hasPermission,
  type AccessContext,
  type PermissionKey,
} from '@/lib/access-control';

interface AuthSuccess {
  authenticated: true;
  user: { id: string | null; email: string | null };
  access: AccessContext;
}

interface AuthFailure {
  authenticated: false;
  response: NextResponse;
}

type RequireAuthResult = AuthSuccess | AuthFailure;

/**
 * Defense-in-depth auth check for admin API routes.
 *
 * Call at the top of every admin API handler:
 * ```ts
 * const auth = await requireAuth({ permission: 'settings.manage' });
 * if (!auth.authenticated) return auth.response;
 * ```
 *
 * Safety model
 * ------------
 * 1. The signed-in user must be an active team member (`team_members`).
 *    Strangers and suspended accounts get 403. The first person to sign in
 *    becomes the owner (see `resolveAccess`).
 * 2. `ADMIN_ALLOWED_EMAILS`, when set, still applies on top of membership.
 * 3. `DISABLE_ADMIN_AUTH=true` and demo mode act as a synthetic owner, and
 *    only when `APP_ENV` is in the explicit local/test allow-list.
 * 4. An optional `permission` is checked against the member's resolved keys.
 */
export async function requireAuth(
  options: { permission?: PermissionKey } = {},
): Promise<RequireAuthResult> {
  const resolved = await resolveAccess();
  if (resolved.state === 'signed_out') return deny(401, 'Unauthorized');
  if (resolved.state === 'not_member')
    return deny(403, 'Your account is not part of this workspace.');
  if (resolved.state === 'suspended')
    return deny(403, 'Your access is suspended.');
  if (options.permission && !hasPermission(resolved.access, options.permission))
    return deny(403, 'You do not have permission for this.');
  return {
    authenticated: true,
    user: { id: resolved.userId, email: resolved.access.member.email },
    access: resolved.access,
  };
}

function deny(status: number, error: string): AuthFailure {
  return {
    authenticated: false,
    response: NextResponse.json({ error }, { status }),
  };
}
