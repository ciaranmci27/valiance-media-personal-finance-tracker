import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/service";
import { localAccountingFeedService } from "./local-test-client";
import type { TaxRefreshRpc } from "../tax-refresh";
export const taxServer: TaxRefreshRpc = async (command) => {
  const client =
    localAccountingFeedService() ?? getServiceClient().schema("accounting");
  const { data, error } = await client.rpc("tax_refresh_server", {
    command,
  });
  if (error)
    throw new Error(
      "The tax refresh could not capture or retain its verified inputs. Review the link and retry.",
    );
  return data;
};
export function taxWorkerEnabled() {
  return (
    process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED === "true" &&
    process.env.ACCOUNTING_TAX_WORKER_ENABLED === "true" &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.ACCOUNTING_TAX_WORKER_SECRET &&
    process.env.ACCOUNTING_TAX_WORKER_SECRET.length >= 32 &&
    process.env.ACCOUNTING_TAX_WORKER_SECRET.length <= 512 &&
    !process.env.ACCOUNTING_TEST_DATABASE_URL &&
    process.env.NEXT_PUBLIC_DEMO_MODE !== "true" &&
    process.env.DEMO_MODE !== "true"
  );
}
export function taxWorkerAuthorized(header: string | null) {
  if (
    !taxWorkerEnabled() ||
    !header?.startsWith("Bearer ") ||
    header.length > 1024
  )
    return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(
    hash(header.slice(7)),
    hash(process.env.ACCOUNTING_TAX_WORKER_SECRET!),
  );
}
