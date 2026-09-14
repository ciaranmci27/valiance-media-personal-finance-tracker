"use client";
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/inputs/Textarea";
import { Tooltip } from "@/components/ui/tooltip";
import type { EntryEvidence } from "@/lib/accounting/workflows";
import { timestampLabel } from "./format";
import { useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";

const NOTE_LIMIT = 3000;

/**
 * Notes on a journal entry, as one thread: what has been written, then a
 * place to write the next one. Plain words kept beside the books, never a
 * change to them. A saved entry adds each note at once; an entry that only
 * exists in the editor keeps one pending note, which the save sends as soon
 * as the entry has an id.
 */
export function EntryNotes({
  entryId,
  pending,
  onPending,
}: {
  /** Null while the entry has not been saved yet. */
  entryId: string | null;
  pending: string;
  onPending: (note: string) => void;
}) {
  // The same cached read as the Receipts and history panel: one request per entry.
  const evidence = useAccountingRead<EntryEvidence>(
    entryId ? { view: "evidence", entry: entryId } : null,
  );
  const notes = evidence.data?.notes ?? null;
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const noteId = useRef<string | null>(null);
  const command = useAccountingCommand(evidence.reload);

  if (!entryId)
    return (
      <div className="space-y-1.5">
        <Textarea
          aria-label="Note"
          rows={4}
          placeholder="Add a note..."
          value={pending}
          onChange={(value) => onPending(value.slice(0, NOTE_LIMIT))}
        />
        <p className="text-xs text-muted-foreground">Saved with the entry.</p>
      </div>
    );

  // Not a form: the editor around this thread is already one, and this
  // button must never submit the entry.
  async function add() {
    const text = note.trim();
    if (!text) return;
    if (text.length > NOTE_LIMIT) {
      setError(`Keep a note under ${NOTE_LIMIT} characters.`);
      return;
    }
    setError("");
    noteId.current ??= crypto.randomUUID();
    if (
      await command.execute({
        type: "entry.annotate",
        id: noteId.current,
        entry_id: entryId!,
        note: text,
      })
    ) {
      setNote("");
      noteId.current = null;
    }
  }
  const busy = command.busy;
  return (
    <div className="space-y-4">
      {notes && notes.length > 0 && (
        <ol className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="text-sm">
              <p className="whitespace-pre-wrap">{n.note}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <time dateTime={n.created_at}>
                  {timestampLabel(n.created_at)}
                </time>
              </p>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Add a note"
          className="min-w-0 flex-1"
          // A textarea is inline by default and leaves descender space under its box, which pushed the button down.
          inputClassName="block"
          rows={2}
          placeholder="Add a note..."
          value={note}
          disabled={busy}
          onChange={setNote}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void add();
          }}
        />
        <Tooltip content="Add note">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Add note"
            disabled={!note.trim() || busy}
            loading={busy}
            onClick={() => void add()}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {(error || evidence.error || command.error) && (
        <p role="alert" className="text-sm text-error">
          {error || evidence.error || command.error}
        </p>
      )}
    </div>
  );
}
