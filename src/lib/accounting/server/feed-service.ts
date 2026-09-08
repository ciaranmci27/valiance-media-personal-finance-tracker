import "server-only";
import { getServiceClient } from "@/lib/supabase/service";
import { ACCOUNTING_ENABLED } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import { encryptWith, decryptWith } from "@/lib/crypto/aes";
import { localAccountingFeedService } from "./local-test-client";
import { SimpleFinError, bridgeUrl } from "./simplefin-transport";
import type { FeedRpc } from "./simplefin-sync";

export function feedConfiguration() {
  const version = Number(process.env.SIMPLEFIN_KEY_VERSION ?? "1");
  const key =
    Number.isSafeInteger(version) && version >= 1
      ? process.env[
          version === 1
            ? "SIMPLEFIN_ENCRYPTION_KEY"
            : `SIMPLEFIN_ENCRYPTION_KEY_V${version}`
        ]
      : null;
  const isolated = isDemoMode() || !!process.env.ACCOUNTING_TEST_DATABASE_URL;
  const ready =
    ACCOUNTING_ENABLED &&
    !isolated &&
    !!key &&
    key.length >= 32 &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    ready,
    isolated,
    workerEnabled:
      ready &&
      process.env.ACCOUNTING_FEED_WORKER_ENABLED === "true" &&
      !!process.env.ACCOUNTING_WORKER_SECRET &&
      process.env.ACCOUNTING_WORKER_SECRET.length >= 32,
  };
}
export function requireLiveFeed() {
  if (!feedConfiguration().ready)
    throw new SimpleFinError(
      "not_configured",
      "Live bank access requires a configured SimpleFIN encryption key and service connection. It is disabled in demo and synthetic test environments.",
    );
}
export function encryptFeed(access: string) {
  requireLiveFeed();
  return encryptWith(
    "SIMPLEFIN_ENCRYPTION_KEY",
    bridgeUrl(access, "access").href,
    Number(process.env.SIMPLEFIN_KEY_VERSION ?? "1"),
  );
}
export function decryptFeed(cipher: string) {
  requireLiveFeed();
  return bridgeUrl(decryptWith("SIMPLEFIN_ENCRYPTION_KEY", cipher), "access")
    .href;
}
export const feedServer: FeedRpc = async (command) => {
  const client =
    localAccountingFeedService() ?? getServiceClient().schema("accounting");
  const { data, error } = await client.rpc("sync_server", {
    command,
  });
  if (error) {
    const errors: Record<string, string> = {
      ACCT_FEED_BUSY: "A sync is already running for this connection.",
      ACCT_FEED_LEASE:
        "This sync lease expired or the connection changed. Refresh to see the latest run.",
      ACCT_FEED_BACKOFF:
        "The connection is waiting before another request. Check its retry time.",
      ACCT_FEED_QUOTA:
        "This connection reached its request budget. Try again after the daily requests expire.",
      ACCT_FEED_CLAIM:
        "This setup attempt was already sent or changed. Reconnect with a new SimpleFIN token.",
      ACCT_FORBIDDEN:
        "This connection is unavailable for the requested operation.",
    };
    for (const [code, message] of Object.entries(errors))
      if (error.message.includes(code))
        throw new SimpleFinError(code.toLowerCase(), message);
    throw new SimpleFinError(
      "storage_failed",
      "The bank observation could not be saved. The ledger was not changed.",
    );
  }
  return data;
};
