"use client";
import { useCallback, useRef, useState } from "react";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import { postAccountingCommand } from "./use-accounting-command";

/** Independent row saves, with a stable idempotency key when a request needs retrying. */
export function useAccountingRowCommand() {
  const requests = useRef(
    new Map<string, { signature: string; key: string }>(),
  );
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const failedVersions = useRef(new Map<string, number>());
  const clearResolved = useCallback((entries: { id: string; version: number }[]) => {
    const resolved = entries.filter((entry) => {
      const failed = failedVersions.current.get(entry.id);
      return failed !== undefined && entry.version > failed;
    });
    if (!resolved.length) return;
    setErrors((previous) => {
      const next = { ...previous };
      for (const entry of resolved) {
        delete next[entry.id];
        failedVersions.current.delete(entry.id);
      }
      return next;
    });
  }, []);
  async function execute(id: string, command: WorkflowCommand) {
    if (inFlight.current.has(id)) return null;
    inFlight.current.add(id);
    setPending(new Set(inFlight.current));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    const signature = JSON.stringify(command);
    if (requests.current.get(id)?.signature !== signature)
      requests.current.set(id, { signature, key: crypto.randomUUID() });
    try {
      const result = await postAccountingCommand(
        requests.current.get(id)!.key,
        command,
      );
      requests.current.delete(id);
      failedVersions.current.delete(id);
      return result;
    } catch (error) {
      if ("expected_version" in command)
        failedVersions.current.set(id, command.expected_version);
      setErrors((previous) => ({
        ...previous,
        [id]:
          error instanceof Error
            ? error.message
            : "Unable to save. Retry this change.",
      }));
      return null;
    } finally {
      inFlight.current.delete(id);
      setPending(new Set(inFlight.current));
    }
  }
  return {
    execute,
    pending,
    errors,
    clearResolved,
    isPending: (id: string) => inFlight.current.has(id),
  };
}
