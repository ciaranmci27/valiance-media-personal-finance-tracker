"use client";

import { useRef, useState } from "react";
import type { EntryContext } from "@/lib/accounting/contracts";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { accountingReadJson } from "@/lib/accounting/read-json";
import { AccountingRetryKeys } from "@/lib/accounting/retry-keys";

/** The context a transaction command accepts: the kind and the payee. */
export type CommandContext = NonNullable<
  Extract<
    WorkflowCommand,
    { type: "transaction.save" | "transaction.review" }
  >["context"]
>;

/**
 * A context read back from the books may carry keys a command rejects.
 * Send a context through this. Receipts against the retired invoice
 * module are plain income once they are edited again.
 */
export function commandContext(context: EntryContext): CommandContext {
  return {
    kind: context.kind === "invoice_receipt" ? "income" : context.kind,
    payee_id: context.payee_id ?? null,
  };
}

export async function postAccountingCommand(
  key: string,
  command: WorkflowCommand,
) {
  const response = await fetch("/api/accounting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, command }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Unable to save this change.");
  return result as { id: string; version?: number };
}

const REFRESH_FAILED =
  "Saved, but the books could not be reloaded. Refresh the page to see the change.";

export function useAccountingCommand(
  onSaved?: (command?: WorkflowCommand) => Promise<void> | void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const inFlight = useRef(false);
  const retryKeys = useRef(new AccountingRetryKeys());
  /** The latest error, readable right after `execute` without waiting for a render. */
  const lastError = useRef("");

  function fail(message: string) {
    lastError.current = message;
    setError(message);
  }

  /** A save landed; a failed reload afterwards is reported but does not undo it. */
  async function reload(command?: WorkflowCommand) {
    try {
      await onSaved?.(command);
    } catch {
      fail(REFRESH_FAILED);
    }
  }

  /** One command with an idempotency key that survives a retry of the same payload. */
  async function execute(command: WorkflowCommand) {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    fail("");
    try {
      const result = await postAccountingCommand(
        retryKeys.current.keyFor(command),
        command,
      );
      retryKeys.current.complete(command);
      await reload(command);
      return result;
    } catch (e) {
      fail(
        e instanceof Error
          ? e.message
          : "Connection interrupted. Retry to check the same request.",
      );
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /**
   * Several commands in order, one refresh at the end. Stops at the first
   * failure and reports which ids landed so the caller can retry the rest.
   */
  async function executeMany(commands: WorkflowCommand[]) {
    const saved: string[] = [];
    if (inFlight.current || commands.length === 0)
      return { done: 0, failed: false, saved };
    inFlight.current = true;
    setBusy(true);
    fail("");
    setProgress({ done: 0, total: commands.length });
    let failed = false;
    try {
      for (const command of commands) {
        const key = retryKeys.current.keyFor(command);
        try {
          const result = await postAccountingCommand(key, command);
          retryKeys.current.complete(command);
          saved.push(result.id ?? ("id" in command ? String(command.id) : ""));
          setProgress({ done: saved.length, total: commands.length });
        } catch (e) {
          failed = true;
          fail(
            e instanceof Error
              ? `${e.message} (${saved.length} of ${commands.length} saved)`
              : "Connection interrupted. Reload to see what was saved.",
          );
          break;
        }
      }
      if (saved.length > 0) await reload();
      return { done: saved.length, failed, saved };
    } finally {
      inFlight.current = false;
      setBusy(false);
      setProgress(null);
    }
  }

  return { execute, executeMany, busy, error, setError, progress, lastError };
}

/**
 * Read one accounting view. Cancellation settles with AbortError so callers
 * can finish cleanup; effects ignore it when their signal has been aborted.
 */
export function accountingGet<T>(
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  return accountingReadJson<T>(
    `/api/accounting?${new URLSearchParams(query)}`,
    signal,
  );
}
