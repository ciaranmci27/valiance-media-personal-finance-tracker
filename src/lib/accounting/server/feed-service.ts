import "server-only";
import { getServiceClient } from "@/lib/supabase/service";
import { ACCOUNTING_ENABLED } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import { encryptWith, decryptWith } from "@/lib/crypto/aes";
import { localAccountingFeedService } from "./local-test-client";
import {
  SimpleFinError,
  bridgeUrl,
  feedStorageError,
} from "./simplefin-transport";
import type { FeedRpc } from "@feeds/sync.ts";

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
  if (error) throw feedStorageError(error.message);
  return data;
};
