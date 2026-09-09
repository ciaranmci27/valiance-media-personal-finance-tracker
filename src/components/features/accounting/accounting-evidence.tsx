"use client";
import { useEffect, useState, useRef } from "react";
import { ArrowRight, FileText, Paperclip, History, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { SectionHeader } from "@/components/ui/section-header";
import { Tooltip } from "@/components/ui/tooltip";
import type { EntryEvidence, Party } from "@/lib/accounting/workflows";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import { enumLabel, timestampLabel } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { EvidenceUpload } from "./accounting-documents";
export function AccountingEvidence({
  entryId,
  accounts,
  parties,
}: {
  entryId: string;
  accounts: AccountingAccount[];
  parties: Party[];
}) {
  const [data, setData] = useState<EntryEvidence | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const noteId = useRef<string | null>(null);
  async function refresh() {
    setData(
      await accountingGet<EntryEvidence>({ view: "evidence", entry: entryId }),
    );
  }
  const command = useAccountingCommand(refresh);
  useEffect(() => {
    const controller = new AbortController();
    accountingGet<EntryEvidence>(
      { view: "evidence", entry: entryId },
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [entryId]);
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <SectionHeader label="Evidence & history" />
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {data && (
        <>
          {!!data.rules?.length && (
            <div className="space-y-2">
              {data.rules.map((r) => (
                <details
                  key={r.id}
                  className="glass-card rounded-xl p-3 text-xs"
                >
                  <summary className="cursor-pointer">
                    Draft filled by {r.rule_name} · version {r.rule_version}
                  </summary>
                  <p className="mt-2 text-muted-foreground">
                    {timestampLabel(r.created_at)}
                  </p>
                  <div className="mt-3 space-y-2">
                    <p>
                      Category:{" "}
                      {accounts.find(
                        (a) => a.id === r.before_value.category_account_id,
                      )?.name ?? "Previous category"}{" "}
                      <ArrowRight
                        size={12}
                        className="inline align-middle"
                        aria-hidden="true"
                      />{" "}
                      {r.before_value.winner?.category_name ??
                        "Reviewed category"}
                    </p>
                    <p>
                      Payee:{" "}
                      {parties.find((p) => p.id === r.after_value.payee_id)
                        ?.name ?? "Unassigned"}
                    </p>
                    <p className="text-muted-foreground">
                      Matched {r.before_value.winner?.description_mode}:{" "}
                      {r.before_value.winner?.description}
                    </p>
                    <p className="text-muted-foreground">
                      The bank movement and entry date were preserved.
                    </p>
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-muted-foreground">
                      Stored audit record
                    </summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all">
                      <MaskedValue
                        value={JSON.stringify(
                          { before: r.before_value, after: r.after_value },
                          null,
                          2,
                        )}
                      />
                    </pre>
                  </details>
                </details>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {data.documents.map((d) => (
              <p key={d.id} className="flex items-center gap-2 text-sm">
                <Paperclip size={14} aria-hidden="true" />
                <a
                  className="text-teal-light hover:underline"
                  href={`/api/accounting/documents?id=${d.id}`}
                >
                  {d.original_name}
                </a>
              </p>
            ))}
            {!data.documents.length && (
              <p className="text-xs text-muted-foreground">
                No documents linked.
              </p>
            )}
          </div>
          {data.sources.map((s) => (
            <details key={s.id} className="glass-card rounded-xl p-3">
              <summary className="cursor-pointer text-sm">
                <FileText
                  className="mr-2 inline"
                  size={14}
                  aria-hidden="true"
                />
                {s.source_system} · {s.external_id}
              </summary>
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                <MaskedValue value={JSON.stringify(s.raw_payload, null, 2)} />
              </pre>
            </details>
          ))}
          {data.notes.map((n) => (
            <div key={n.id} className="rounded-lg bg-secondary/50 p-3 text-sm">
              <p className="whitespace-pre-wrap">{n.note}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {timestampLabel(n.created_at)}
              </p>
            </div>
          ))}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              <History size={13} className="mr-1 inline" aria-hidden="true" />
              {data.audit.length} recorded changes
            </summary>
            <div className="mt-2 max-h-56 overflow-auto">
              {data.audit.map((a) => (
                <div key={a.id} className="border-b border-border py-2 text-xs">
                  <p>
                    {enumLabel(a.action.toLowerCase())} ·{" "}
                    {enumLabel(a.table_name.replace("acct_", ""))}
                  </p>
                  <time
                    dateTime={a.recorded_at}
                    className="text-muted-foreground"
                  >
                    {timestampLabel(a.recorded_at)}
                  </time>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          noteId.current ??= crypto.randomUUID();
          if (
            await command.execute({
              type: "entry.annotate",
              id: noteId.current,
              entry_id: entryId,
              note,
            })
          ) {
            setNote("");
            noteId.current = null;
          }
        }}
      >
        <TextInput
          aria-label="Add an evidence note"
          placeholder="Add a note without changing the books"
          value={note}
          onChange={(nextValue) => setNote(nextValue)}
          maxLength={3000}
          required
        />
        <Tooltip content="Save note">
          <Button
            type="submit"
            variant="outline"
            aria-label="Save note"
            size="icon"
            disabled={!note.trim() || command.busy}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
        </Tooltip>
      </form>
      <EvidenceUpload entryId={entryId} onSaved={refresh} />
      {command.error && (
        <p role="alert" className="text-xs text-error">
          {command.error}
        </p>
      )}
    </div>
  );
}
