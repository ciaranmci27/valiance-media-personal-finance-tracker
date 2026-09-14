"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Paperclip } from "lucide-react";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import type { EntryEvidence, Party } from "@/lib/accounting/workflows";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import { dateLabel, enumLabel, originLabel, timestampLabel } from "./format";
import { useAccountingRead } from "./use-accounting-read";
import { EvidenceSkeleton } from "./accounting-skeletons";
import { EvidenceUpload } from "./accounting-documents";
import { EntryNotes } from "./accounting-entry-notes";

/** What the books recorded, in the owner's words. Anything unlisted falls back to its own name. */
const ACTIONS: Record<string, string> = {
  sync: "Synced from the bank",
  "transaction.save": "Saved",
  "transaction.review": "Saved and reviewed",
  "entry.review": "Reviewed",
  "entry.post": "Posted",
  "entry.reverse": "Reversed",
  "entry.restore": "Restored",
  "entry.correct": "Corrected",
  "entry.categorize": "Categorized",
  "entry.split": "Split",
  "entry.context": "Details changed",
  "entry.annotate": "Note added",
  "draft.discard": "Discarded",
  "document.link": "Receipt attached",
  "document.unlink": "Receipt detached",
  "transfer.create": "Recorded as a transfer",
  "transfer.link": "Linked as a transfer",
  "rule.applied": "Filled by a rule",
  insert: "Created",
  update: "Updated",
};
const actionLabel = (action: string) =>
  ACTIONS[action.toLowerCase()] ?? enumLabel(action.toLowerCase());

/** A context save can change the description, the contact or the type; say which. */
type ContextSnapshot = {
  memo?: string;
  payee_id?: string | null;
  kind?: string;
};

/** What a context save changed, with the old and new values in the owner's words. */
function contextChanges(
  before: unknown,
  after: unknown,
  parties: Party[],
): { label: string; from: string; to: string }[] {
  const b = (before ?? {}) as ContextSnapshot;
  const a = (after ?? {}) as ContextSnapshot;
  const payeeName = (id?: string | null) =>
    id ? (parties.find((p) => p.id === id)?.name ?? "Contact") : "No contact";
  const changes: { label: string; from: string; to: string }[] = [];
  if (b.memo !== a.memo)
    changes.push({
      label: "Description",
      from: b.memo ?? "",
      to: a.memo ?? "",
    });
  if ((b.payee_id ?? null) !== (a.payee_id ?? null))
    changes.push({
      label: "Contact",
      from: payeeName(b.payee_id),
      to: payeeName(a.payee_id),
    });
  if (b.kind !== a.kind)
    changes.push({
      label: "Type",
      from: enumLabel(b.kind ?? ""),
      to: enumLabel(a.kind ?? ""),
    });
  return changes;
}
function contextLabel(changes: { label: string }[]): string {
  return changes.length
    ? changes.map((c) => c.label).join(" and ") + " changed"
    : "Details saved";
}

/** One quiet block: a small caption, an optional right-hand note, then the content. */
function Section({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </h4>
        {meta}
      </div>
      {children}
    </section>
  );
}

/** The stored record, behind a plain text toggle rather than a card inside a card. */
function RawData({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? "Hide raw data" : "Raw data"}
      </button>
      {open && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-secondary/40 p-3 text-xs text-muted-foreground">
          <MaskedValue value={JSON.stringify(value, null, 2)} />
        </pre>
      )}
    </div>
  );
}

/**
 * Everything the books hold about one entry besides its lines: receipts,
 * where it came from, what rules did to it, what happened to it since, and
 * notes. Four or five short sections with one caption each, no nesting.
 */
export function AccountingEvidence({
  entryId,
  accounts,
  parties,
}: {
  entryId: string;
  accounts: AccountingAccount[];
  parties: Party[];
}) {
  // One cached read for this panel and the notes thread, warmed the moment
  // the transaction opened.
  const {
    data,
    loading,
    error,
    reload: refresh,
  } = useAccountingRead<EntryEvidence>({ view: "evidence", entry: entryId });
  const chain = data?.history?.entries ?? [];
  return (
    <div className="space-y-6">
      {loading && <EvidenceSkeleton />}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <Section
            label="Receipts"
            meta={
              data.documents.length > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {data.documents.length}
                </span>
              ) : null
            }
          >
            {data.documents.length > 0 ? (
              <ul className="space-y-1.5">
                {data.documents.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm">
                    <Paperclip
                      size={14}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                    <a
                      className="min-w-0 truncate text-teal-light hover:underline"
                      href={`/api/accounting/documents?id=${d.id}`}
                    >
                      {d.original_name}
                    </a>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {Math.ceil(Number(d.size_bytes) / 1024)} KB
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No receipts attached.
              </p>
            )}
            <EvidenceUpload entryId={entryId} onSaved={refresh} />
          </Section>

          {data.sources.length > 0 && (
            <Section label="Source">
              <ul className="space-y-3">
                {data.sources.map((s) => (
                  <li key={s.id} className="space-y-1 text-sm">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span>{originLabel(s.source_system)}</span>
                      <span className="text-xs text-muted-foreground">
                        {timestampLabel(s.observed_at)}
                      </span>
                    </p>
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={s.external_id}
                    >
                      {s.external_id}
                    </p>
                    <RawData value={s.raw_payload} />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {!!data.rules?.length && (
            <Section label="Rules">
              <ul className="space-y-3">
                {data.rules.map((r) => (
                  <li key={r.id} className="space-y-1 text-sm">
                    <p>
                      Filled by {r.rule_name}{" "}
                      <span className="text-xs text-muted-foreground">
                        version {r.rule_version} ·{" "}
                        {timestampLabel(r.created_at)}
                      </span>
                    </p>
                    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {accounts.find(
                        (a) => a.id === r.before_value.category_account_id,
                      )?.name ?? "Previous category"}
                      <ArrowRight size={12} aria-hidden="true" />
                      {r.before_value.winner?.category_name ??
                        "Reviewed category"}
                      {r.after_value.payee_id && (
                        <>
                          {" · "}
                          {parties.find((p) => p.id === r.after_value.payee_id)
                            ?.name ?? "Contact"}
                        </>
                      )}
                    </p>
                    <RawData
                      value={{ before: r.before_value, after: r.after_value }}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            label="History"
            meta={
              data.history ? (
                <Link
                  href={`/accounting?view=journal&entry=${data.history.reference}`}
                  title={data.history.reference}
                  className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  TX-{data.history.reference.slice(0, 8).toUpperCase()}
                </Link>
              ) : null
            }
          >
            {chain.length > 1 && (
              <ol className="space-y-1.5">
                {chain.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-baseline gap-x-2 text-sm"
                  >
                    {event.id === entryId ? (
                      <span className="font-medium">{event.action}</span>
                    ) : (
                      <Link
                        className="font-medium underline-offset-4 hover:underline"
                        href={`/accounting?view=journal&entry=${event.id}`}
                      >
                        {event.action}
                      </Link>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {dateLabel(event.entry_date)}
                      {event.reason ? ` · ${event.reason}` : ""}
                    </span>
                    {event.payroll_run_id && (
                      <Link
                        className="text-xs text-primary underline"
                        href="/accounting?view=payroll"
                      >
                        Payroll record
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <ol
              className={cn(
                "divide-y divide-border",
                data.audit.length > 6 && "max-h-56 overflow-auto pr-1",
              )}
            >
              {data.audit.map((a) => {
                const changes =
                  a.action.toLowerCase() === "entry.context"
                    ? contextChanges(a.before_value, a.after_value, parties)
                    : [];
                return (
                  <li key={a.id} className="py-1.5 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span>
                        {a.action.toLowerCase() === "entry.context"
                          ? contextLabel(changes)
                          : a.action.toLowerCase() === "entry.review" &&
                              (
                                a.after_value as {
                                  review_pending?: boolean;
                                } | null
                              )?.review_pending
                            ? "Marked unreviewed"
                            : actionLabel(a.action)}
                      </span>
                      <time
                        dateTime={a.recorded_at}
                        className="text-xs text-muted-foreground"
                      >
                        {timestampLabel(a.recorded_at)}
                      </time>
                    </div>
                    {changes.map((c) => (
                      <p
                        key={c.label}
                        className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
                      >
                        <span className="break-words">{c.from || "None"}</span>
                        <ArrowRight
                          size={12}
                          aria-hidden="true"
                          className="shrink-0"
                        />
                        <span className="break-words text-foreground">
                          {c.to || "None"}
                        </span>
                      </p>
                    ))}
                  </li>
                );
              })}
              {data.audit.length === 0 && (
                <li className="py-1.5 text-sm text-muted-foreground">
                  Nothing recorded yet.
                </li>
              )}
            </ol>
          </Section>

          <Section label="Notes">
            <EntryNotes entryId={entryId} pending="" onPending={() => {}} />
          </Section>
        </>
      )}
    </div>
  );
}
