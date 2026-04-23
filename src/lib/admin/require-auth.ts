import { NextResponse } from 'next/server';
import {
  ADMIN_ALLOWED_EMAILS,
  APP_ENV,
  DISABLE_ADMIN_AUTH,
  isLocalOrTestEnv,
} from '@/lib/env';

interface AuthSuccess {
  authenticated: true;
  user: { email?: string; username?: string };
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
 * const auth = await requireAuth();
 * if (!auth.authenticated) return auth.response;
 * ```
 *
 * Safety model
 * ------------
 * 1. `DISABLE_ADMIN_AUTH=true` only bypasses auth when `APP_ENV` is in the
 *    explicit local/test allow-list. Preview, staging, and production deploys
 *    ignore the flag even if it slips into their env.
 * 2. When the user is authenticated but `ADMIN_ALLOWED_EMAILS` is unset,
 *    access is granted only in local/test envs. Production/preview/staging
 *    fail closed to prevent any Supabase-authenticated user from reaching
 *    admin routes just because the allow-list wasn't configured.
 */
export async function requireAuth(): Promise<RequireAuthResult> {
  if (DISABLE_ADMIN_AUTH && isLocalOrTestEnv) {
    return { authenticated: true, user: { username: 'dev' } };
  }

  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return deny();
  }

  if (ADMIN_ALLOWED_EMAILS) {
    const emailList = ADMIN_ALLOWED_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (!emailList.includes(user.email?.toLowerCase() ?? '')) {
      return deny();
    }
    return { authenticated: true, user: { email: user.email } };
  }

  if (!isLocalOrTestEnv) {
    console.error(
      `[require-auth] ADMIN_ALLOWED_EMAILS is unset in APP_ENV="${APP_ENV}"; denying admin access. Configure the allow-list or set APP_ENV to local/ci/test.`,
    );
    return deny();
  }

  return { authenticated: true, user: { email: user.email } };
}

function deny(): AuthFailure {
  return {
    authenticated: false,
    response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  };
}
