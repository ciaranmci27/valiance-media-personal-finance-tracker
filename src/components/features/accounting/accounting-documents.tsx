"use client";
import { useEffect, useRef, useState } from "react";
import { Paperclip, Download, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    input = useRef<HTMLInputElement>(null);
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
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          className="min-w-0 flex-1 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-foreground"
          aria-label="Choose evidence file"
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.csv"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            uploadId.current = crypto.randomUUID();
            setError("");
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!file || busy}
          onClick={() => void save()}
        >
          <Paperclip size={14} />
          {busy ? "Uploading…" : "Upload evidence"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Private PDF, image, or CSV · Up to 20 MB · Original files are retained
      </p>
      {(error || command.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || command.error}
        </p>
      )}
    </div>
  );
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
  return (
    <section className="glass-card overflow-hidden">
      <div className="space-y-4 border-b border-border p-5">
        <div>
          <h2 className="font-semibold">Document inbox</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Receipts, statements, source exports, and supporting records.
          </p>
        </div>
        {!demo && <EvidenceUpload onSaved={refresh} />}
      </div>
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="divide-y divide-border">
        {data.documents.map((d) => (
          <div
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-3 p-5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{d.original_name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {Math.ceil(Number(d.size_bytes) / 1024)} KB ·{" "}
                {d.state === "available"
                  ? d.entries.length
                    ? `${d.entries.length} linked entries`
                    : "In inbox"
                  : d.state}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {d.entries.map((e) => (
                  <button
                    className="text-xs text-primary hover:underline"
                    key={e.id}
                    onClick={() => onEntry(e.id)}
                  >
                    {e.entry_date} · {e.memo}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {d.state === "available" && (
                <>
                  <a
                    className="rounded-md p-2 text-muted-foreground hover:text-foreground"
                    href={`/api/accounting/documents?id=${d.id}`}
                    aria-label={`Download ${d.original_name}`}
                  >
                    <Download size={16} />
                  </a>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLink(d);
                      setEntryId("");
                    }}
                  >
                    <Link2 size={14} />
                    Link entry
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
        {!data.documents.length && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Upload a receipt or source document to start your evidence library.
          </p>
        )}
      </div>
      <div className="flex justify-between border-t border-border p-4 text-xs text-muted-foreground">
        <span>{data.total} documents</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!offset}
            onClick={() => setOffset(offset - 100)}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={offset + 100 >= data.total}
            onClick={() => setOffset(offset + 100)}
          >
            Next
          </Button>
        </div>
      </div>
      <Dialog
        open={!!link}
        onOpenChange={(open) => {
          if (!open) setLink(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link evidence to an entry</DialogTitle>
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
            <Input
              label="Entry ID"
              placeholder="Copy from the transaction detail"
              value={entryId}
              onChange={(e) => setEntryId(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Evidence can be added after a period is locked. Financial amounts
              remain unchanged.
            </p>
            {command.error && (
              <p role="alert" className="text-sm text-destructive">
                {command.error}
              </p>
            )}
            <Button disabled={command.busy}>Link document</Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
