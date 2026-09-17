/**
 * The SimpleFIN pull, shared by the Next.js worker route (Node) and the
 * sync-feeds edge function (Deno). Both write through accounting.sync_server
 * and its lease, so a manual "Sync now" and the scheduler never overlap.
 */
import {
  parseSimpleFin,
  syncWindow,
  SYNC_WINDOW_SECONDS,
  type FeedAccount,
} from "./data.ts";
import {
  requestSimpleFin,
  SimpleFinError,
  safeProviderMessage,
  type ProviderTransport,
} from "./protocol.ts";

export type FeedRpc = (command: Record<string, unknown>) => Promise<unknown>;
export type Identity = {
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
export type RequestPlan = {
  identities: Identity[];
  window: { start: number; end: number };
};
/** Default run budget in seconds; the routes and the edge function stay under their wall clocks. */
export const SYNC_BUDGET_SECONDS = 150;
/**
 * Mapped accounts share one all-accounts request whenever their windows fit
 * inside the provider's 90-day limit. SimpleFIN budgets requests per day, not
 * accounts per request, so one connection costs one request per run. Every
 * member of a group has the same window end, so the group end is each
 * account's checkpoint.
 */
export function planRequests(
  identities: Identity[],
  now: number,
): RequestPlan[] {
  const items = identities
    .map((identity) => ({
      identity,
      window: syncWindow(
        Number(identity.history_start),
        identity.checkpoint === null ? null : Number(identity.checkpoint),
        now,
        identity.resume_floor == null ? null : Number(identity.resume_floor),
      ),
    }))
    .sort(
      (a, b) => a.window.start - b.window.start || a.window.end - b.window.end,
    );
  const plans: RequestPlan[] = [];
  for (const item of items) {
    const open = plans.at(-1);
    if (
      open &&
      Math.max(open.window.end, item.window.end) - open.window.start <=
        SYNC_WINDOW_SECONDS
    ) {
      open.identities.push(item.identity);
      open.window.end = Math.max(open.window.end, item.window.end);
    } else
      plans.push({
        identities: [item.identity],
        window: { start: item.window.start, end: item.window.end },
      });
  }
  return plans;
}
/** The service lease limits provider ingestion to the selected connection. */
export async function syncSimpleFin(options: {
  connectionId: string;
  actorId: string | null;
  discover?: boolean;
  rpc: FeedRpc;
  decrypt: (cipher: string) => string | Promise<string>;
  transport: ProviderTransport;
  budgetSeconds?: number;
  now?: () => number;
}) {
  const { rpc } = options,
    runId = crypto.randomUUID(),
    clock = options.now ?? (() => Math.floor(Date.now() / 1000)),
    started = clock(),
    budget = options.budgetSeconds ?? SYNC_BUDGET_SECONDS;
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
      access = await options.decrypt(lease.access_url_encrypted);
    } catch {
      throw new SimpleFinError(
        "decryption_failed",
        "The SimpleFIN recovery key is unavailable or changed. Restore the correct key or reconnect.",
      );
    }
    const plans: RequestPlan[] = options.discover
      ? [
          {
            identities: [],
            window: { start: started - 86400, end: started + 1 },
          },
        ]
      : planRequests(lease.identities, started);
    if (!plans.length)
      throw new SimpleFinError(
        "mapping_required",
        "Discover and review the company account mappings before syncing transactions.",
      );
    const save = async (
      account: FeedAccount,
      transactions: FeedAccount["transactions"],
      through: string | null,
    ) => {
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
          // Unmatched movements become drafts in Needs review; matched ones
          // attach to the entry they corroborate.
          create_drafts: !options.discover,
          accounts: [
            {
              ...account,
              raw: undefined,
              transactions: transactions.slice(offset, offset + 100),
              chunk_partial: offset + 100 < transactions.length,
              through,
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
    };
    for (const plan of plans) {
      if (clock() - started > budget) {
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
          ...(options.discover ? { "balances-only": "1" } : { pending: "1" }),
        },
        options.transport,
      );
      const response = parseSimpleFin(
        raw,
        plan.window,
        clock(),
        !!options.discover,
      );
      if (options.discover) {
        for (const account of response.accounts) await save(account, [], null);
        if (response.issues.length) {
          complete = false;
          errors.push(...response.issues.map((i) => i.message));
        }
        continue;
      }
      for (const identity of plan.identities) {
        const account = response.accounts.find(
          (a) =>
            a.provider_connection_id === identity.provider_connection_id &&
            a.provider_account_id === identity.provider_account_id,
        );
        if (!account) {
          complete = false;
          errors.push(
            "A mapped account was missing from the response. Its checkpoint was retained.",
          );
          continue;
        }
        await save(
          account,
          account.currency === "USD" ? account.transactions : [],
          String(plan.window.end),
        );
      }
    }
    const finished = (await rpc({
      action: "complete",
      id: options.connectionId,
      accounts: [],
      discovery: !!options.discover,
      create_drafts: !options.discover,
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
export type DueRun = {
  connection_id: string;
  ok: boolean;
  received?: number;
  complete?: boolean;
  error?: string;
};
/**
 * One scheduler tick: stamp the worker heartbeat, then run every due
 * connection until the time budget is spent. A connection left over is due
 * again on the next tick, so nothing is lost when a run is long.
 */
export async function runDueFeeds(options: {
  rpc: FeedRpc;
  decrypt: (cipher: string) => string | Promise<string>;
  transport: ProviderTransport;
  source: string;
  budgetSeconds?: number;
  now?: () => number;
}) {
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000)),
    started = clock(),
    budget = options.budgetSeconds ?? SYNC_BUDGET_SECONDS;
  const due = (await options.rpc({
    action: "due",
    source: options.source,
  })) as string[];
  const runs: DueRun[] = [];
  for (const connectionId of due) {
    const remaining = budget - (clock() - started);
    if (remaining <= 0) break;
    try {
      const result = await syncSimpleFin({
        connectionId,
        actorId: null,
        rpc: options.rpc,
        decrypt: options.decrypt,
        transport: options.transport,
        budgetSeconds: remaining,
        now: options.now,
      });
      runs.push({
        connection_id: connectionId,
        ok: true,
        received: result.received,
        complete: result.complete,
      });
    } catch (error) {
      runs.push({
        connection_id: connectionId,
        ok: false,
        error:
          error instanceof SimpleFinError
            ? error.message
            : "The feed run failed. Review the retained connection diagnostics.",
      });
    }
  }
  return { due: due.length, processed: runs.length, runs };
}
