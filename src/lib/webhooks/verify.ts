import crypto from "node:crypto";

// Verifies the CRM webhook signature: HMAC-SHA256(secret, "<t>.<rawBody>") as
// lowercase hex, from an `X-VM-Signature: t=<unix>,v1=<hex>` header. Rejects
// stale timestamps to block replay and compares in constant time.
export function verifyWebhookSignature(
  secret: string,
  header: string | null | undefined,
  rawBody: string,
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;

  const parts: Record<string, string> = {};
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i === -1) continue;
    parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }

  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
