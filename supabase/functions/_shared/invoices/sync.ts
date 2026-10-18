/**
 * One invoice source run, shared by the Next.js routes (Node) and the
 * sync-invoice-sources edge function (Deno). Every write goes through
 * accounting.invoice_sync_server and its per-source lease, so the hourly job
 * and the owner's Sync now never overlap.
 *
 * Order: take the lease, tell the source about links it has not heard of,
 * pull its invoices and earned work as complete listings, let the books keep
 * what changed and auto-link exact matches, tell the source about those, and
 * release. Authentication failures stop the source until the owner pastes a
 * new key; anything else is recorded on the source and retried next hour.
 */
import {
  InvoiceSourceError,
  sourceClient,
  type PushOutcome,
  type SourceTransport,
} from "./contract.ts";

export type InvoiceRpc = (command: Record<string, unknown>) => Promise<unknown>;
export type Push = {
  link_id: string;
  action: "record" | "remove";
  invoice_external_id: string;
  project_ref: string;
  amount_cents: string;
  paid_date: string;
  external_payment_id: string | null;
  attempts: number;
  recorded_payment_id: string | null;
  source_outstanding_cents: string;
};
type Lease = {
  id: string;
  acquired: boolean;
  base_url: string;
  api_key_encrypted: string;
  history_start: string | null;
  today: string;
  pushes: Push[];
};
export type SourceRun = {
  id: string;
  status: "synced" | "pushed" | "busy" | "error";
  pushed: number;
  changed: number;
  removed: number;
  linked: number;
  error?: string;
};
export type InvoiceRunResult = { started_at: string; sources: SourceRun[] };

/** Default run budget in seconds; the routes and the edge function stay under their wall clocks. */
export const INVOICE_BUDGET_SECONDS = 100;

type Client = ReturnType<typeof sourceClient>;

/** One link's push. A payment the source already holds for the link, or an invoice it already shows paid in full, needs no request. */
export async function pushOne(
  client: Client,
  push: Push,
): Promise<PushOutcome> {
  try {
    if (push.action === "record") {
      if (push.recorded_payment_id)
        return {
          outcome: "recorded",
          external_payment_id: push.recorded_payment_id,
        };
      if (BigInt(push.source_outstanding_cents) === BigInt(0))
        return { outcome: "recorded", external_payment_id: null };
      return await client.record(push);
    }
    if (!push.external_payment_id) return { outcome: "removed" };
    return await client.remove({
      project_ref: push.project_ref,
      invoice_external_id: push.invoice_external_id,
      external_payment_id: push.external_payment_id,
    });
  } catch (error) {
    if (error instanceof InvoiceSourceError && error.code === "auth")
      throw error;
    if (
      error instanceof InvoiceSourceError &&
      error.code === "invalid_response"
    )
      return { outcome: "retry", error: error.message };
    return {
      outcome: "retry",
      error:
        error instanceof InvoiceSourceError
          ? error.message
          : "The invoicing system could not be reached.",
    };
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof InvoiceSourceError) return error.message;
  const message = error instanceof Error ? error.message : "";
  // Books refusals name the rule (ACCT_*); anything else stays generic so nothing internal leaks into the screen.
  const code = message.match(/ACCT_[A-Z_]+/)?.[0];
  return code
    ? `The books refused the source's data (${code}).`
    : "The invoice sync stopped unexpectedly. It runs again within the hour.";
}

export async function runInvoiceSources(options: {
  rpc: InvoiceRpc;
  decrypt: (cipher: string) => Promise<string> | string;
  transport: SourceTransport;
  source: string;
  budgetSeconds?: number;
  /** One source only (Sync now, or a push after the owner links). */
  only?: string;
  /** Ignore the hourly cadence. */
  force?: boolean;
  /** Push waiting links without pulling. */
  pushOnly?: boolean;
  newRunId?: () => string;
}): Promise<InvoiceRunResult> {
  const started = Date.now(),
    budget = (options.budgetSeconds ?? INVOICE_BUDGET_SECONDS) * 1000;
  const runId = options.newRunId ?? (() => crypto.randomUUID());
  const due = options.only
    ? [options.only]
    : ((await options.rpc({
        action: "due",
        force: options.force ?? false,
        source: options.source,
      })) as string[]);
  const sources: SourceRun[] = [];
  for (const id of due) {
    if (Date.now() - started > budget) break;
    const run = runId();
    const lease = (await options.rpc({
      action: "lease",
      id,
      run_id: run,
    })) as Lease;
    const result: SourceRun = {
      id,
      status: "busy",
      pushed: 0,
      changed: 0,
      removed: 0,
      linked: 0,
    };
    sources.push(result);
    if (!lease.acquired) continue;
    try {
      const client = sourceClient(
        lease.base_url,
        await options.decrypt(lease.api_key_encrypted),
        options.transport,
      );
      const push = async (pushes: Push[]) => {
        if (!pushes.length) return;
        const results = [];
        for (const item of pushes)
          results.push({
            link_id: item.link_id,
            ...(await pushOne(client, item)),
          });
        await options.rpc({ action: "push", id, run_id: run, results });
        result.pushed += results.length;
      };
      await push(lease.pushes);
      if (options.pushOnly) result.status = "pushed";
      else {
        const invoices = await client.invoices();
        const from =
          lease.history_start ?? `${Number(lease.today.slice(0, 4)) - 3}-01-01`;
        const earned = await client.earnedWork(from, lease.today);
        const done = (await options.rpc({
          action: "complete",
          id,
          run_id: run,
          invoices,
          earned,
          complete: true,
        })) as {
          changed: number;
          removed: number;
          linked: number;
          pushes: Push[];
        };
        Object.assign(result, {
          changed: done.changed,
          removed: done.removed,
          linked: done.linked,
          status: "synced",
        });
        await push(done.pushes);
      }
      await options.rpc({ action: "release", id, run_id: run });
    } catch (error) {
      result.status = "error";
      result.error = safeMessage(error);
      try {
        await options.rpc({
          action: "fail",
          id,
          run_id: run,
          error: result.error,
          auth_failed:
            error instanceof InvoiceSourceError && error.code === "auth",
        });
      } catch {
        /* A lost lease expires on its own within five minutes. */
      }
    }
  }
  return { started_at: new Date(started).toISOString(), sources };
}
