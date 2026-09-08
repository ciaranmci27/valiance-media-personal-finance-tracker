import { createHash, timingSafeEqual } from "node:crypto";
import { verifyWebhookSignature } from "../../webhooks/verify";

type Environment = Record<string, string | undefined>;
export const invoicePrivateHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export function invoiceConfiguration(env: Environment = process.env) {
  const isolated =
    env.NEXT_PUBLIC_DEMO_MODE === "true" ||
    env.DEMO_MODE === "true" ||
    !!env.ACCOUNTING_TEST_DATABASE_URL;
  const secret = (key: string) =>
    !!env[key] && env[key]!.length >= 32 && env[key]!.length <= 512;
  const ready =
    !isolated &&
    env.NEXT_PUBLIC_ACCOUNTING_ENABLED === "true" &&
    env.ACCOUNTING_INVOICE_ENABLED === "true" &&
    !!env.SUPABASE_SERVICE_ROLE_KEY &&
    !!env.NEXT_PUBLIC_SUPABASE_URL &&
    !!env.ACCOUNTING_INVOICE_SOURCE_URL &&
    secret("ACCOUNTING_INVOICE_SOURCE_SECRET") &&
    secret("ACCOUNTING_INVOICE_WEBHOOK_SECRET");
  return {
    ready,
    isolated,
    workerEnabled:
      ready &&
      env.ACCOUNTING_INVOICE_WORKER_ENABLED === "true" &&
      secret("ACCOUNTING_INVOICE_WORKER_SECRET"),
  };
}
export function invoiceWorkerAuthorized(
  header: string | null,
  env: Environment = process.env,
) {
  if (
    !invoiceConfiguration(env).workerEnabled ||
    !header?.startsWith("Bearer ") ||
    header.length > 1024
  )
    return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(
    digest(header.slice(7)),
    digest(env.ACCOUNTING_INVOICE_WORKER_SECRET!),
  );
}
export function invoiceSignatureValid(
  header: string | null,
  body: string,
  env: Environment = process.env,
) {
  return (
    invoiceConfiguration(env).ready &&
    !!header &&
    /^t=[0-9]{10},v1=[a-f0-9]{64}$/.test(header) &&
    verifyWebhookSignature(env.ACCOUNTING_INVOICE_WEBHOOK_SECRET!, header, body)
  );
}
