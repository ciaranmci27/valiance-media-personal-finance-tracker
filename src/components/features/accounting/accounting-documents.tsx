"use client";
import { useEffect, useRef, useState } from "react";
import { Paperclip, Download, Link2, Camera, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
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
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

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
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose evidence file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.csv"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
        <input
          ref={camera}
          type="file"
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
  const [data, setData] = useState<DocumentList>({ documents: [], total: 0 }),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(""),
    [link, setLink] = useState<AccountingDocument | null>(null),
    [entryId, setEntryId] = useState("");
  async function refresh() {
    setData(
      await accountingGet<DocumentList>({
        view: "documents",
        offset: String(offset),
      }),
    );
  }
  const command = useAccountingCommand(async () => {
    await refresh();
    setLink(null);
  });
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    accountingGet<DocumentList>(
      { view: "documents", offset: String(offset) },
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [demo, offset]);
  const meta = (d: AccountingDocument) =>
    `${Math.ceil(Number(d.size_bytes) / 1024)} KB · ${documentStatus(d)}`;
  const entryLinks = (d: AccountingDocument) =>
    d.entries.length ? (
      <div className="flex flex-wrap gap-2">
        {d.entries.map((e) => (
          <button
            key={e.id}
            type="button"
            className="text-xs text-teal-light hover:underline"
            onClick={() => onEntry(e.id)}
          >
            {dateLabel(e.entry_date)} · {e.memo}
          </button>
        ))}
      </div>
    ) : null;
  const actions = (d: AccountingDocument) =>
    d.state === "available" ? (
      <div className="flex items-center justify-end gap-2">
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
        after={
          <Pagination
            offset={offset}
            limit={100}
            total={data.total}
            onChange={setOffset}
            noun="documents"
          />
        }
      />
      <Dialog
        open={!!link}
        onOpenChange={(open) => {
          if (!open) setLink(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach a document to a transaction</DialogTitle>
            <DialogDescription>{link?.original_name}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
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
            <p className="text-xs text-muted-foreground">
              Evidence can be added after a period is locked. Financial amounts
              remain unchanged.
            </p>
            {command.error && (
              <p role="alert" className="text-sm text-error">
                {command.error}
              </p>
            )}
            <Button disabled={command.busy || !entryId}>Link document</Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
