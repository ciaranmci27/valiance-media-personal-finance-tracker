"use client";
import { useRef, useState } from "react";
import { Upload, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import type { Statement, ReconciliationView } from "@/lib/accounting/close";
import type {
  CsvOptions,
  BankMapping,
  ParsedImportGroup,
} from "@/lib/accounting/imports/csv";
import { formatCents } from "@/lib/accounting/money";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { uploadEvidence } from "./accounting-documents";

const selectStyle =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
type Preview = {
  fileHash: string;
  mappingHash: string;
  groups: ParsedImportGroup[];
  errorCount: number;
};
export function StatementCsvImport({
  statement,
  onClose,
  onSaved,
}: {
  statement: Statement;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [attached, setAttached] = useState(false);
  const [options, setOptions] = useState<CsvOptions>({
    delimiter: ",",
    headerRow: 0,
    dateFormat: "yyyy-mm-dd",
    decimal: ".",
    thousands: ",",
  });
  const [mapping, setMapping] = useState<BankMapping>({
    date: "",
    description: "",
    sign: "deposits_positive",
    accountId: statement.account_id,
  });
  const [shape, setShape] = useState("signed");
  const [headers, setHeaders] = useState<string[]>([]),
    [samples, setSamples] = useState<string[][]>([]);
  const [preview, setPreview] = useState<Preview | null>(null),
    [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState("");
  const [done, setDone] = useState(false);
  const uploadId = useRef<string | null>(null),
    inFlight = useRef(false);
  const cmd = useAccountingCommand();
  function changeOptions(next: CsvOptions) {
    setOptions(next);
    setHeaders([]);
    setPreview(null);
    setError("");
  }
  function changeMapping(key: keyof BankMapping, value: string) {
    setMapping((m) => ({ ...m, [key]: value || undefined }));
    setPreview(null);
  }
  async function parse(phase: "inspect" | "preview") {
    if (!file || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setProgress("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("options", JSON.stringify(options));
      form.set("phase", phase);
      form.set("mode", "bank");
      form.set("mapping", JSON.stringify(mapping));
      const response = await fetch("/api/accounting/imports", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Unable to read this CSV.");
      if (phase === "inspect") {
        setHeaders(result.headers);
        setSamples(result.samples);
      } else setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to read this CSV.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const totals = preview?.groups.reduce(
    (sum, g) => {
      const n = BigInt(g.bank_amount_cents ?? "0");
      if (n > BigInt(0)) sum.increase += n;
      else sum.decrease -= n;
      return sum;
    },
    { increase: BigInt(0), decrease: BigInt(0) },
  );
  const invalid =
    preview?.groups.flatMap((g, i) =>
      [
        ...g.errors,
        ...(g.entry_date < statement.from_date ||
        g.entry_date > statement.to_date
          ? ["Date is outside this statement."]
          : []),
        ...(!g.memo.trim() || g.memo.length > 1000
          ? ["Description must contain 1 to 1,000 characters."]
          : []),
      ].map((message) => `Row ${i + options.headerRow + 2}: ${message}`),
    ) ?? [];
  const exact =
    !!preview &&
    !!totals &&
    !invalid.length &&
    preview.groups.length === statement.declared_count &&
    totals.increase.toString() === statement.declared_debits_cents &&
    totals.decrease.toString() === statement.declared_credits_cents;
  async function save() {
    if (!file || !preview || !exact || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    cmd.setError("");
    try {
      setProgress("Saving the original CSV…");
      uploadId.current ??= crypto.randomUUID();
      const document = attached
        ? { id: statement.document_id }
        : await uploadEvidence(file, uploadId.current);
      const current = await accountingGet<ReconciliationView>({
        view: "reconciliation",
        account: statement.account_id,
        id: statement.id,
      });
      if (!current.statement || current.statement.version !== statement.version)
        throw new Error(
          "This statement changed. Close this preview and reopen Import CSV to review its current totals.",
        );
      let version = current.statement.version;
      for (let offset = 0; offset < preview.groups.length; ) {
        const items = [];
        let bytes = 0;
        for (
          let i = offset;
          i < preview.groups.length && items.length < 100;
          i++
        ) {
          const g = preview.groups[i];
          const item = {
            external_id: g.external_id,
            fingerprint: g.fingerprint,
            source_row: i + options.headerRow + 2,
            entry_date: g.entry_date,
            description: g.memo,
            amount_cents: g.bank_amount_cents!,
            raw: g.raw[0],
          };
          const size = new TextEncoder().encode(JSON.stringify(item)).length;
          if (size > 700000)
            throw new Error(
              `CSV row ${item.source_row} is too large. Remove unrelated columns and preview again.`,
            );
          if (bytes + size > 700000) break;
          items.push(item);
          bytes += size;
        }
        setProgress(
          `Saving items ${offset + 1} to ${offset + items.length} of ${preview.groups.length}…`,
        );
        const result = await cmd.execute({
          type: "statement.import",
          id: statement.id,
          expected_version: version,
          document_id: document.id,
          file_hash: preview.fileHash,
          mapping_hash: preview.mappingHash,
          mapping: { options, columns: mapping },
          restore_removed: restore,
          items,
        });
        if (!result) {
          setProgress(
            "Import paused. Saved items are retained. Close and reopen this import to retry the same file safely.",
          );
          return;
        }
        version = result.version!;
        offset += items.length;
      }
      setDone(true);
      setProgress(
        `${preview.groups.length} source ${preview.groups.length === 1 ? "item" : "items"} checked. Existing imported items were kept once.`,
      );
      await onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Import paused. Saved items are retained.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function column(label: string, key: keyof BankMapping, optional = false) {
    return (
      <label className="block text-sm">
        {label}
        <select
          className={selectStyle}
          value={mapping[key] ?? ""}
          onChange={(e) => changeMapping(key, e.target.value)}
        >
          <option value="">
            {optional ? "Not supplied" : "Choose a column"}
          </option>
          {headers.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import statement movements</DialogTitle>
          <DialogDescription>
            {statement.from_date} to {statement.to_date}. Map the complete
            statement CSV, check its totals, then match the movements to your
            books.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-4 py-4">
            <CheckCircle2 className="text-teal-light" size={28} />
            <p className="font-medium">
              Statement movements are ready to match
            </p>
            <p className="text-sm text-muted-foreground">{progress}</p>
            <Button onClick={onClose}>Return to reconciliation</Button>
          </div>
        ) : (
          <>
            <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
              <Input
                label="Statement CSV"
                type="file"
                accept=".csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setAttached(false);
                  uploadId.current = null;
                  setHeaders([]);
                  setPreview(null);
                  setError("");
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    if (inFlight.current) return;
                    inFlight.current = true;
                    setBusy(true);
                    setError("");
                    try {
                      const response = await fetch(
                        `/api/accounting/documents?id=${statement.document_id}`,
                        { cache: "no-store" },
                      );
                      if (!response.ok)
                        throw new Error(
                          "Unable to retrieve the attached statement.",
                        );
                      if (
                        !response.headers
                          .get("content-type")
                          ?.includes("text/csv")
                      )
                        throw new Error(
                          "The attached statement is not a CSV. Choose its transaction CSV above.",
                        );
                      setFile(
                        new File(
                          [await response.blob()],
                          "attached-statement.csv",
                          { type: "text/csv" },
                        ),
                      );
                      setAttached(true);
                      setHeaders([]);
                      setPreview(null);
                    } catch (e) {
                      setError(
                        e instanceof Error
                          ? e.message
                          : "Unable to retrieve the attached statement.",
                      );
                    } finally {
                      inFlight.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  Use attached CSV
                </Button>
                {attached && (
                  <span className="text-xs text-teal-light">
                    Attached statement CSV selected
                  </span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  Separator
                  <select
                    className={selectStyle}
                    value={options.delimiter}
                    onChange={(e) =>
                      changeOptions({
                        ...options,
                        delimiter: e.target.value as CsvOptions["delimiter"],
                      })
                    }
                  >
                    <option value=",">Comma</option>
                    <option value=";">Semicolon</option>
                    <option value={"\t"}>Tab</option>
                  </select>
                </label>
                <Input
                  label="Header row"
                  type="number"
                  min={1}
                  max={51}
                  value={options.headerRow + 1}
                  onChange={(e) =>
                    changeOptions({
                      ...options,
                      headerRow: Number(e.target.value) - 1,
                    })
                  }
                />
                <label className="text-sm">
                  Date format
                  <select
                    className={selectStyle}
                    value={options.dateFormat}
                    onChange={(e) =>
                      changeOptions({
                        ...options,
                        dateFormat: e.target.value as CsvOptions["dateFormat"],
                      })
                    }
                  >
                    <option value="yyyy-mm-dd">YYYY-MM-DD</option>
                    <option value="mm/dd/yyyy">MM/DD/YYYY</option>
                    <option value="dd/mm/yyyy">DD/MM/YYYY</option>
                  </select>
                </label>
                <label className="text-sm">
                  Decimal mark
                  <select
                    className={selectStyle}
                    value={options.decimal}
                    onChange={(e) =>
                      changeOptions({
                        ...options,
                        decimal: e.target.value as CsvOptions["decimal"],
                      })
                    }
                  >
                    <option value=".">Period</option>
                    <option value=",">Comma</option>
                  </select>
                </label>
                <label className="text-sm">
                  Thousands separator
                  <select
                    className={selectStyle}
                    value={options.thousands}
                    onChange={(e) =>
                      changeOptions({
                        ...options,
                        thousands: e.target.value as CsvOptions["thousands"],
                      })
                    }
                  >
                    <option value=",">Comma</option>
                    <option value=".">Period</option>
                    <option value=" ">Space</option>
                    <option value="">None</option>
                  </select>
                </label>
              </div>
              {!headers.length && (
                <Button
                  variant="outline"
                  disabled={!file || busy}
                  onClick={() => void parse("inspect")}
                >
                  Read columns
                </Button>
              )}
              {!!headers.length && (
                <>
                  <details className="rounded-lg border border-border p-3">
                    <summary className="cursor-pointer text-sm">
                      Original rows
                    </summary>
                    <div className="mt-3 max-h-48 overflow-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr>
                            {headers.map((h) => (
                              <th key={h} className="p-2">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {samples.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j} className="max-w-64 truncate p-2">
                                  <MaskedValue value={cell} />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {column("Statement date", "date")}
                    {column("Description", "description")}
                    <label className="text-sm">
                      Amount columns
                      <select
                        className={selectStyle}
                        value={shape}
                        onChange={(e) => {
                          setShape(e.target.value);
                          setMapping((m) => ({
                            ...m,
                            amount: undefined,
                            debit: undefined,
                            credit: undefined,
                          }));
                          setPreview(null);
                        }}
                      >
                        <option value="signed">One signed amount</option>
                        <option value="split">
                          Separate withdrawal and deposit
                        </option>
                      </select>
                    </label>
                    <label className="text-sm">
                      Signed amount convention
                      <select
                        className={selectStyle}
                        value={mapping.sign}
                        onChange={(e) => changeMapping("sign", e.target.value)}
                        disabled={shape === "split"}
                      >
                        <option value="deposits_positive">
                          Deposits / card payments are positive
                        </option>
                        <option value="withdrawals_positive">
                          Withdrawals / card charges are positive
                        </option>
                      </select>
                    </label>
                    {shape === "signed" ? (
                      column("Signed amount", "amount")
                    ) : (
                      <>
                        {column("Withdrawal / card charge", "debit")}
                        {column("Deposit / card payment", "credit")}
                      </>
                    )}
                    {column("Stable transaction ID", "externalId", true)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Repeated movements are kept separately. Retries use the
                    source identity to avoid adding the same imported item
                    twice. Existing manually entered items need a separate
                    duplicate review.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => void parse("preview")}
                    disabled={
                      busy ||
                      !mapping.date ||
                      !mapping.description ||
                      (shape === "signed"
                        ? !mapping.amount
                        : !mapping.debit || !mapping.credit)
                    }
                  >
                    Preview statement
                  </Button>
                </>
              )}
              {preview && totals && (
                <section className="space-y-4 rounded-xl border border-border p-4">
                  <h3 className="font-medium">
                    Compare with the original statement
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-right text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr>
                          <th className="py-2 text-left">Control</th>
                          <th>Statement</th>
                          <th>CSV</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          [
                            "Movements",
                            String(statement.declared_count),
                            String(preview.groups.length),
                          ],
                          [
                            "Increases",
                            formatCents(statement.declared_debits_cents),
                            formatCents(totals.increase),
                          ],
                          [
                            "Decreases",
                            formatCents(statement.declared_credits_cents),
                            formatCents(totals.decrease),
                          ],
                        ].map(([label, expected, actual]) => (
                          <tr key={label} className="border-t border-border">
                            <td className="py-3 text-left">{label}</td>
                            <td>
                              <MaskedValue value={expected} />
                            </td>
                            <td
                              className={
                                expected === actual
                                  ? "text-teal-light"
                                  : "text-warning"
                              }
                            >
                              <MaskedValue value={actual} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!!invalid.length && (
                    <div
                      role="alert"
                      className="max-h-40 overflow-auto text-sm text-error"
                    >
                      {invalid.slice(0, 30).map((v, i) => (
                        <p key={i}>{v}</p>
                      ))}
                      {invalid.length > 30 && (
                        <p>{invalid.length - 30} more errors.</p>
                      )}
                    </div>
                  )}
                  {!exact && (
                    <p className="text-sm text-warning">
                      All dates, movement counts, increases, and decreases must
                      agree. Check the mapping or edit the statement details
                      using the original statement.
                    </p>
                  )}
                  <div className="max-h-52 overflow-auto">
                    <table className="w-full text-left text-sm">
                      <tbody>
                        {preview.groups.slice(0, 30).map((g, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="whitespace-nowrap py-2 pr-3">
                              {g.entry_date}
                            </td>
                            <td className="pr-3">{g.memo}</td>
                            <td className="whitespace-nowrap text-right">
                              <MaskedValue
                                value={formatCents(g.bank_amount_cents ?? "0")}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={restore}
                      onChange={(e) => setRestore(e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      Restore items I previously removed from this statement.
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Leave off unless you intend to bring those source
                        movements back.
                      </span>
                    </span>
                  </label>
                  <Button disabled={!exact || busy} onClick={() => void save()}>
                    <Upload size={15} />
                    Import {preview.groups.length} statement{" "}
                    {preview.groups.length === 1 ? "item" : "items"}
                  </Button>
                </section>
              )}
            </fieldset>
            {progress && (
              <p role="status" className="text-sm text-muted-foreground">
                {progress}
              </p>
            )}
            {(error || cmd.error) && (
              <p role="alert" className="text-sm text-error">
                {error || cmd.error}
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
