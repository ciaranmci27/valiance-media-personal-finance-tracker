import { randomUUID } from "node:crypto";
import { parseSimpleFin, syncWindow, type FeedAccount } from "./simplefin-data";
import {
  requestSimpleFin,
  SimpleFinError,
  safeProviderMessage,
  type ProviderTransport,
} from "./simplefin-transport";

export type FeedRpc = (command: Record<string, unknown>) => Promise<unknown>;
type Identity = {
  id: string;
  provider_connection_id: string;
  provider_account_id: string;
  history_start: string;
  checkpoint: string | null;
  resume_floor: string | null;
};
type Lease = {
  id: string;
  acquired: boolean;
  access_url_encrypted: string;
  identities: Identity[];
};
/** The service lease limits provider ingestion to the selected connection. */
export async function syncSimpleFin(options: {
  connectionId: string;
  actorId: string | null;
  discover?: boolean;
  rpc: FeedRpc;
  decrypt: (cipher: string) => string;
  transport?: ProviderTransport;
  now?: () => number;
}) {
  const { rpc } = options,
    runId = randomUUID(),
    clock = options.now ?? (() => Math.floor(Date.now() / 1000)),
    started = clock();
  const lease = (await rpc({
    action: "lease",
    id: options.connectionId,
    run_id: runId,
    actor_id: options.actorId,
  })) as Lease;
  if (!lease.acquired)
    throw new SimpleFinError(
      "sync_busy",
      "A sync is already running or the connection needs attention.",
    );
  let received = 0,
    complete = true;
  const errors: string[] = [];
  try {
    let access: string;
    try {
      access = options.decrypt(lease.access_url_encrypted);
    } catch {
      throw new SimpleFinError(
        "decryption_failed",
        "The SimpleFIN recovery key is unavailable or changed. Restore the correct key or reconnect.",
      );
    }
    const plans: {
      identity: Identity | null;
      window: { start: number; end: number };
    }[] = options.discover
      ? [
          {
            identity: null,
            window: { start: started - 86400, end: started + 1 },
          },
        ]
      : lease.identities.map((identity) => ({
          identity,
          window: syncWindow(
            Number(identity.history_start),
            identity.checkpoint === null ? null : Number(identity.checkpoint),
            started,
            identity.resume_floor == null
              ? null
              : Number(identity.resume_floor),
          ),
        }));
    if (!plans.length)
      throw new SimpleFinError(
        "mapping_required",
        "Discover and review the company account mappings before syncing transactions.",
      );
    for (const plan of plans) {
      if (clock() - started > 150) {
        complete = false;
        errors.push(
          "This run reached its time budget. Saved progress will resume on the next sync.",
        );
        break;
      }
      const raw = await requestSimpleFin(
        access,
        {
          "start-date": String(plan.window.start),
          "end-date": String(plan.window.end),
          ...(plan.identity
            ? { account: plan.identity.provider_account_id, pending: "1" }
            : { "balances-only": "1" }),
        },
        options.transport,
      );
      const response = parseSimpleFin(
        raw,
        plan.window,
        clock(),
        !plan.identity,
      );
      const accounts = plan.identity
        ? response.accounts.filter(
            (a) =>
              a.provider_connection_id ===
                plan.identity!.provider_connection_id &&
              a.provider_account_id === plan.identity!.provider_account_id,
          )
        : response.accounts;
      if (plan.identity && !accounts.length) {
        complete = false;
        errors.push(
          "A mapped account was missing from the response. Its checkpoint was retained.",
        );
        continue;
      }
      for (const account of accounts) {
        const transactions =
          plan.identity && account.currency === "USD"
            ? account.transactions
            : [];
        // Each bounded chunk is durable. Only the final, complete chunk advances coverage.
        for (
          let offset = 0;
          offset < Math.max(1, transactions.length);
          offset += 100
        ) {
          const saved = (await rpc({
            action: "complete",
            id: options.connectionId,
            run_id: runId,
            partial: true,
            discovery: !!options.discover,
            accounts: [
              {
                ...account,
                raw: undefined,
                transactions: transactions.slice(offset, offset + 100),
                chunk_partial: offset + 100 < transactions.length,
                through: plan.identity ? String(plan.window.end) : null,
              },
            ],
          })) as { complete: boolean };
          if (!saved.complete) complete = false;
        }
        received += transactions.length;
        if (!account.complete) {
          complete = false;
          errors.push(accountIssue(account));
        }
      }
      if (!plan.identity && response.issues.length) {
        complete = false;
        errors.push(...response.issues.map((i) => i.message));
      }
    }
    const finished = (await rpc({
      action: "complete",
      id: options.connectionId,
      accounts: [],
      discovery: !!options.discover,
      run_id: runId,
      complete,
      error: safeProviderMessage([...new Set(errors)].join(" ")),
    })) as { complete: boolean };
    return {
      run_id: runId,
      received,
      complete: finished.complete,
      message: options.discover
        ? "Account discovery finished. Review ownership and mapping before syncing transactions."
        : finished.complete
          ? "Bank observations saved for review."
          : "Progress saved. Review the connection issues before relying on its coverage.",
    };
  } catch (error) {
    const issue =
      error instanceof SimpleFinError
        ? error
        : new SimpleFinError(
            "sync_failed",
            "The sync stopped before completion. Saved observations and checkpoints were retained.",
          );
    try {
      await rpc({
        action: "fail",
        id: options.connectionId,
        reconnect_required: ["access_revoked", "decryption_failed"].includes(
          issue.code,
        ),
        run_id: runId,
        code: issue.code,
        error: issue.message,
        retry_seconds: issue.retryAfterSeconds,
      });
    } catch {
      /* A replaced/expired lease cannot write after a newer run. */
    }
    throw issue;
  }
}
function accountIssue(account: FeedAccount) {
  return `${account.name}: ${account.issues.map((i) => i.message).join(" ")}`;
}
