"use client";
import { FileInput } from "@/components/ui/inputs/FileInput";
import { useRef, useState } from "react";
import {
  Archive,
  Paperclip,
  Download,
  Link2,
  Camera,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountingEntryPicker } from "./accounting-entry-picker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type {
  AccountingDocument,
  DocumentList,
} from "@/lib/accounting/documents";
import { countLabel, dateLabel, enumLabel } from "./format";
import { useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";

export async function uploadEvidence(
  file: File,
  id: string,
): Promise<AccountingDocument> {
  const form = new FormData();
  form.set("file", file);
  form.set("id", id);
  const response = await fetch("/api/accounting/documents", {
    method: "POST",
    body: form,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? "Evidence upload paused. Retry the same file.",
    );
  return result;
}
export function EvidenceUpload({
  entryId,
  onSaved,
}: {
  entryId?: string;
  onSaved: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const uploadId = useRef<string | null>(null),
    inFlight = useRef(false),
    input = useRef<HTMLInputElement>(null),
    camera = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  function choose(next: File | null) {
    if (busy) return;
    setError("");
    if (next && next.size > 20 * 1024 * 1024) {
      setError("Choose a file smaller than 20 MB.");
      return;
    }
    setFile(next);
    uploadId.current = crypto.randomUUID();
  }
  const command = useAccountingCommand();
  async function save() {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    uploadId.current ??= crypto.randomUUID();
    try {
      const doc = await uploadEvidence(file, uploadId.current);
      if (entryId && !doc.entries.some((e) => e.id === entryId)) {
        const result = await command.execute({
          type: "document.link",
          id: doc.id,
          expected_version: doc.version,
          entry_id: entryId,
        });
        if (!result) return;
      }
      await onSaved();
      setFile(null);
      uploadId.current = null;
      if (input.current) input.current.value = "";
      if (camera.current) camera.current.value = "";
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Upload paused. Retry this file.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <div
        className={`rounded-xl border border-dashed p-4 transition-colors ${dragging ? "border-primary bg-primary/10" : "border-border bg-secondary/15"}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length !== 1) {
            setError("Drop one file at a time.");
            return;
          }
          choose(e.dataTransfer.files[0]);
        }}
      >
        <FileInput
          ref={input}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose evidence file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.csv"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
        <FileInput
          ref={camera}
          className="sr-only"
          tabIndex={-1}
          aria-label="Take a receipt photo"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <div className="mb-3 flex items-center gap-2 text-sm">
            <Paperclip size={15} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <Tooltip content="Remove selected file">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove selected file"
                disabled={busy}
                onClick={() => {
                  choose(null);
                  if (input.current) input.current.value = "";
                  if (camera.current) camera.current.value = "";
                }}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        ) : (
          <p className="mb-3 text-sm text-muted-foreground">
            Drop a receipt here, or choose a file.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={14} aria-hidden="true" />
            Choose file
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => camera.current?.click()}
          >
            <Camera size={14} aria-hidden="true" />
            Take photo
          </Button>
          {file && (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Uploading..." : "Attach file"}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Private PDF, image, or CSV · Up to 20 MB · Original files are retained
      </p>
      {(error || command.error) && (
        <p role="alert" className="text-sm text-error">
          {error || command.error}
        </p>
      )}
    </div>
  );
}
function documentStatus(d: AccountingDocument) {
  if (d.state !== "available") return enumLabel(d.state);
  return d.entries.length
    ? countLabel(d.entries.length, "linked entry", "linked entries")
    : "In inbox";
}
export function AccountingDocuments({
  demo,
  onEntry,
}: {
  demo: boolean;
  onEntry: (id: string) => void;
}) {
  // The read returns every document at once; there is no server paging.
  const library = useAccountingRead<DocumentList>(
    { view: "documents" },
    { enabled: !demo },
  );
  const data: DocumentList = {
    documents: library.data?.documents ?? [],
    total: (library.data?.documents ?? []).length,
  };
  const error = library.error;
  const [link, setLink] = useState<AccountingDocument | null>(null),
    [entryId, setEntryId] = useState(""),
    // Archiving a document or detaching one transaction both ask why.
    [reasoned, setReasoned] = useState<{
      kind: "archive" | "unlink";
      document: AccountingDocument;
      entry?: AccountingDocument["entries"][number];
    } | null>(null),
    [reason, setReason] = useState("");
  const refresh = library.reload;
  const command = useAccountingCommand(async () => {
    await refresh();
    setLink(null);
    setReasoned(null);
    setReason("");
  });
  const meta = (d: AccountingDocument) =>
    `${Math.ceil(Number(d.size_bytes) / 1024)} KB · ${documentStatus(d)}`;
  const entryLinks = (d: AccountingDocument) =>
    d.entries.length ? (
      <div className="flex flex-wrap gap-2">
        {d.entries.map((e) => (
          <span key={e.id} className="inline-flex items-center gap-1">
            <button
              type="button"
              className="text-xs text-teal-light hover:underline"
              onClick={() => onEntry(e.id)}
            >
              {dateLabel(e.entry_date)} · {e.memo}
            </button>
            {!demo && d.state !== "archived" && (
              <Tooltip content="Unlink from this transaction">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Unlink ${d.original_name} from ${e.memo}`}
                  onClick={() => {
                    setReasoned({ kind: "unlink", document: d, entry: e });
                    setReason("");
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </Tooltip>
            )}
          </span>
        ))}
      </div>
    ) : null;
  const actions = (d: AccountingDocument) =>
    d.state === "available" ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Tooltip content={`Download ${d.original_name}`}>
          <Button asChild variant="ghost" size="icon-sm">
            <a
              href={`/api/accounting/documents?id=${d.id}`}
              aria-label={`Download ${d.original_name}`}
            >
              <Download size={16} aria-hidden="true" />
            </a>
          </Button>
        </Tooltip>
        {!demo && (
          <Tooltip content="Archive">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Archive ${d.original_name}`}
              onClick={() => {
                setReasoned({ kind: "archive", document: d });
                setReason("");
              }}
            >
              <Archive size={16} aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setLink(d);
            setEntryId("");
          }}
        >
          <Link2 size={14} aria-hidden="true" />
          Attach to transaction
        </Button>
      </div>
    ) : null;
  const columns: DataTableColumn<AccountingDocument>[] = [
    {
      key: "document",
      header: "Document",
      render: (d) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{d.original_name}</p>
          <p className="mt-1 text-xs text-muted-foreground">{meta(d)}</p>
        </div>
      ),
    },
    { key: "entries", header: "Linked transactions", render: entryLinks },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: actions,
    },
  ];
  return (
    <section className="space-y-4">
      <div className="glass-card space-y-4 rounded-xl p-5">
        <div>
          <h2 className="font-semibold">Document inbox</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Receipts, statements, source exports, and supporting records.
          </p>
        </div>
        {!demo && <EvidenceUpload onSaved={refresh} />}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <DataTable
        columns={columns}
        data={data.documents}
        skeletonRows={library.loading ? 5 : 0}
        keyExtractor={(d) => d.id}
        emptyState="Upload a receipt or source document to start your evidence library."
        mobileCard={(d) => (
          <div className="glass-card flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{d.original_name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{meta(d)}</p>
              {d.entries.length > 0 && (
                <div className="mt-2">{entryLinks(d)}</div>
              )}
            </div>
            {actions(d)}
          </div>
        )}
      />
      <Dialog
        open={!!reasoned}
        onOpenChange={(open) => {
          if (!open && !command.busy) setReasoned(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reasoned?.kind === "archive"
                ? "Archive receipt"
                : "Unlink receipt"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {reasoned?.kind === "archive"
                ? "The file stays on record but leaves the inbox and the pickers."
                : "The transaction keeps its ledger lines; only the attachment goes."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reasoned || !reason.trim()) return;
              void command.execute(
                reasoned.kind === "archive"
                  ? {
                      type: "document.archive",
                      id: reasoned.document.id,
                      expected_version: reasoned.document.version,
                      reason: reason.trim(),
                    }
                  : {
                      type: "document.unlink",
                      id: reasoned.document.id,
                      expected_version: reasoned.document.version,
                      entry_id: reasoned.entry!.id,
                      reason: reason.trim(),
                    },
              );
            }}
          >
            <p className="text-sm text-muted-foreground">
              {reasoned?.kind === "unlink" && reasoned.entry
                ? `${reasoned.document.original_name} from ${dateLabel(reasoned.entry.entry_date)} · ${reasoned.entry.memo}`
                : reasoned?.document.original_name}
            </p>
            <TextInput
              label="Reason"
              value={reason}
              onChange={setReason}
              required
              maxLength={1000}
            />
            {command.error && (
              <p role="alert" className="text-sm text-error">
                {command.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={command.busy}
                onClick={() => setReasoned(null)}
              >
                Cancel
              </Button>
              <Button
                variant={
                  reasoned?.kind === "archive" ? "destructive" : "default"
                }
                disabled={command.busy || !reason.trim()}
                loading={command.busy}
              >
                {reasoned?.kind === "archive" ? "Archive" : "Unlink"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!link}
        onOpenChange={(open) => {
          if (!open) setLink(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Attach to transaction</DialogTitle>
            <DialogDescription>{link?.original_name}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (link)
                void command.execute({
                  type: "document.link",
                  id: link.id,
                  expected_version: link.version,
                  entry_id: entryId,
                });
            }}
          >
            <AccountingEntryPicker
              value={entryId}
              onChange={setEntryId}
              disabled={command.busy}
            />
            {command.error && (
              <p role="alert" className="text-sm text-error">
                {command.error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={command.busy}
                onClick={() => setLink(null)}
              >
                Cancel
              </Button>
              <Button disabled={command.busy || !entryId}>Attach</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
