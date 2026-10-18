import "server-only";
import { getServiceClient } from "@/lib/supabase/service";
import { ACCOUNTING_ENABLED } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import { encryptWith, decryptWith } from "@/lib/crypto/aes";
import { localAccountingFeedService } from "./local-test-client";
import { InvoiceSourceError } from "@invoices/contract.ts";
import type { InvoiceRpc } from "@invoices/sync.ts";

/**
 * Invoice source keys are encrypted with their own env key, so rotating it
 * never touches bank feed or SMTP secrets: INVOICE_SOURCE_ENCRYPTION_KEY
 * (plus _V<N> once rotated, selected by INVOICE_SOURCE_KEY_VERSION).
 */
const KEY_ENV = "INVOICE_SOURCE_ENCRYPTION_KEY";
const keyVersion = () => Number(process.env.INVOICE_SOURCE_KEY_VERSION ?? "1");

export function invoiceSourceConfiguration() {
  const version = keyVersion();
  const key =
    Number.isSafeInteger(version) && version >= 1
      ? process.env[version === 1 ? KEY_ENV : `${KEY_ENV}_V${version}`]
      : undefined;
  const isolated = isDemoMode() || !!process.env.ACCOUNTING_TEST_DATABASE_URL;
  return {
    ready:
      ACCOUNTING_ENABLED &&
      !isolated &&
      !!key &&
      key.length >= 32 &&
      !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    isolated,
  };
}
function requireReady() {
  if (!invoiceSourceConfiguration().ready)
    throw new InvoiceSourceError(
      "not_configured",
      "Invoice sources need INVOICE_SOURCE_ENCRYPTION_KEY and the service connection. They are off in demo and test environments.",
    );
}
export function encryptSourceKey(apiKey: string) {
  requireReady();
  return {
    ciphertext: encryptWith(KEY_ENV, apiKey, keyVersion()),
    version: keyVersion(),
  };
}
export function decryptSourceKey(ciphertext: string) {
  requireReady();
  return decryptWith(KEY_ENV, ciphertext);
}
export const invoiceServer: InvoiceRpc = async (command) => {
  const client =
    localAccountingFeedService() ?? getServiceClient().schema("accounting");
  const { data, error } = await client.rpc("invoice_sync_server", { command });
  if (error) throw new Error(error.message);
  return data;
};
