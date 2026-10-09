/**
 * A same-site path to return to after login, or null. Only a plain path on
 * this origin passes: never `//host` or `/\host` (both resolve to another
 * origin in browsers), and never the login page itself.
 */
export function safeNextPath(value: string | null): string | null {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  )
    return null;
  if (value.startsWith("/login")) return null;
  return value;
}
