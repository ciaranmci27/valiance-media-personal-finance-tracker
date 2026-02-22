/**
 * Demo mode utilities
 *
 * When NEXT_PUBLIC_DEMO_MODE=true, the app will:
 * - Use static demo data instead of Supabase queries
 * - Show a demo banner at the top of the page
 * - Disable/mock write operations
 */

export function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
