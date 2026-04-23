/**
 * Centralized environment variable access.
 * Import from '@/lib/env' instead of reading process.env directly.
 */

function optional(value: string | undefined, fallback = ''): string {
  return value ?? fallback;
}

export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const isProduction = NODE_ENV === 'production';
export const isDevelopment = NODE_ENV === 'development';

// Deployment environment, independent of Node's build-time NODE_ENV.
// Must be set explicitly for non-production deployments (preview, staging, ci,
// etc.); unset defaults to 'production' so nothing becomes accidentally
// permissive when an env var is forgotten. Only 'local', 'ci', and 'test'
// unlock dev-only behaviour like bypassing admin auth.
const RAW_APP_ENV = (process.env.APP_ENV ?? '').trim().toLowerCase();
export const APP_ENV: string = RAW_APP_ENV === '' ? 'production' : RAW_APP_ENV;
const LOCAL_OR_TEST_ENVS = new Set(['local', 'ci', 'test']);
export const isLocalOrTestEnv = LOCAL_OR_TEST_ENVS.has(APP_ENV);

export const DISABLE_ADMIN_AUTH = process.env.DISABLE_ADMIN_AUTH === 'true';
export const ADMIN_ALLOWED_EMAILS = optional(process.env.ADMIN_ALLOWED_EMAILS);

export const SMTP_ENCRYPTION_KEY = optional(process.env.SMTP_ENCRYPTION_KEY);
