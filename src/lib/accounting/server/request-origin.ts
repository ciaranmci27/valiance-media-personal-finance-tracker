import type { NextRequest } from "next/server";

/** Next may build req.nextUrl with localhost behind a local/proxy listener.
 * Compare against the HTTP target host, with an exact scheme and port match. */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const protocol =
      req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
      req.nextUrl.protocol.replace(":", "");
    return (
      parsed.host === host &&
      parsed.protocol === `${protocol}:` &&
      ["http:", "https:"].includes(parsed.protocol)
    );
  } catch {
    return false;
  }
}
