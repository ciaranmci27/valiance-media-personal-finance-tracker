"use client";
import { Radio } from "@/components/ui/inputs/RadioGroup";
import { useEffect, useId, useState } from "react";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Pagination } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
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
      <TextInput
        label="Find a transaction"
        placeholder="Search description, payee or account"
        value={query}
        disabled={disabled}
        onChange={(nextValue) => {
          setQuery(nextValue);
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
        className="max-h-64 overflow-auto glass-card rounded-xl"
        aria-busy={loading}
      >
        {result?.entries.map((entry) => (
          <label
            key={entry.id}
            className="flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 last:border-0 hover:bg-secondary/40"
          >
            <Radio
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
        {!result?.entries.length &&
          (loading ? (
            <div
              role="status"
              aria-label="Finding transactions..."
              className="space-y-3 px-3 py-3"
            >
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : (
            <p className="p-5 text-sm text-muted-foreground">
              No matching transactions.
            </p>
          ))}
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
