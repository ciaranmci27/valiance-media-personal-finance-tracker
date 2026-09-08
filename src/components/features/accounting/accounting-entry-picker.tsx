"use client";
import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import type { JournalEntry } from "@/lib/accounting/contracts";
import { dateLabel, enumLabel } from "./format";
import { accountingGet } from "./use-accounting-command";

/** Select a transaction by its recognizable details, without copying database IDs. */
export function AccountingEntryPicker({
  value,
  onChange,
  disabled,
  postedOnly = false,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  postedOnly?: boolean;
}) {
  const radioName = useId();
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    entries: JournalEntry[];
    total: number;
  } | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      accountingGet<{ entries: JournalEntry[]; total: number }>(
        {
          view: "register",
          filter: JSON.stringify({
            query: query || undefined,
            offset,
            limit: 20,
            ...(postedOnly ? { status: "posted" } : {}),
          }),
        },
        controller.signal,
      )
        .then(setResult)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, offset, postedOnly]);
  return (
    <div className="space-y-3">
      <Input
        label="Find a transaction"
        placeholder="Search description, payee or account"
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOffset(0);
          onChange("");
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div
        className="max-h-64 overflow-auto rounded-lg border border-border"
        aria-busy={loading}
      >
        {result?.entries.map((entry) => (
          <label
            key={entry.id}
            className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 last:border-0 hover:bg-secondary/40"
          >
            <input
              type="radio"
              name={radioName}
              checked={entry.id === value}
              disabled={disabled || loading}
              onChange={() => onChange(entry.id)}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{entry.memo}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {dateLabel(entry.entry_date)} |{" "}
                {entry.status === "posted" ? "Reviewed" : "Needs review"} |{" "}
                {enumLabel(entry.primary_origin)}
                {entry.reversed_by_entry_id ? " | Corrected or reversed" : ""}
              </span>
            </span>
          </label>
        ))}
        {!result?.entries.length && (
          <p className="p-5 text-sm text-muted-foreground">
            {loading ? "Finding transactions..." : "No matching transactions."}
          </p>
        )}
      </div>
      <Pagination
        offset={offset}
        limit={20}
        total={result?.total ?? 0}
        onChange={setOffset}
        noun="matches"
        busy={loading || disabled}
      />
    </div>
  );
}
