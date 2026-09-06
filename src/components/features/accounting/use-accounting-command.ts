"use client";

import { useRef, useState } from "react";
import type { WorkflowCommand } from "@/lib/accounting/workflows";

export function useAccountingCommand(onSaved?: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  async function execute(command: WorkflowCommand) {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const signature = JSON.stringify(command);
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await fetch("/api/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: pending.current.key, command }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Unable to save this change.");
      await onSaved?.();
      pending.current = null;
      return result as { id: string; version?: number };
    } catch (e) {
      setError(
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
  return { execute, busy, error, setError };
}

export async function accountingGet<T>(
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/accounting?${new URLSearchParams(query)}`,
    { cache: "no-store", signal },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Unable to load accounting data.");
  return result as T;
}
