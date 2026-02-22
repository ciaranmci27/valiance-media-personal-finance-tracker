import { createBrowserClient } from "@supabase/ssr";

/**
 * Create a Supabase client for use in the browser
 * This client is used for client-side data fetching and auth
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
