"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  AccountingDocument,
  DocumentList,
} from "@/lib/accounting/documents";
import { accountingGet } from "./use-accounting-command";
import { EvidenceUpload } from "./accounting-documents";

export function AccountingDocumentPicker({
  value,
  onChange,
  label = "Supporting document",
  required = true,
}: {
  value: string;
  onChange: (id: string) => void;
  label?: string;
  required?: boolean;
}) {
  const [docs, setDocs] = useState<AccountingDocument[]>([]),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    accountingGet<DocumentList>(
      { view: "documents", offset: String(offset) },
      abort.signal,
    )
      .then((r) => {
        setDocs((d) =>
          offset === 0
            ? r.documents
            : [
                ...d,
                ...r.documents.filter((x) => !d.some((old) => old.id === x.id)),
              ],
        );
        setTotal(r.total);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [offset, tick]);
  return (
    <div className="space-y-3">
      <SearchableSelect
        label={label}
        visibleLabel={label}
        required={required}
        value={value}
        onChange={onChange}
        placeholder="Select an uploaded document"
        options={docs
          .filter((d) => d.state === "available")
          .map((d) => ({ value: d.id, label: d.original_name }))}
      />
      {docs.length < total && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOffset(docs.length)}
        >
          Load more documents
        </Button>
      )}
      <details className="rounded-lg border border-border p-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Upload a new document
        </summary>
        <div className="mt-3">
          <EvidenceUpload
            onSaved={async () => {
              setOffset(0);
              setTick((v) => v + 1);
            }}
          />
        </div>
      </details>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
