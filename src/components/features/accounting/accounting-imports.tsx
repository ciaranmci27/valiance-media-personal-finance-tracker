"use client";

import { useEffect, useRef, useState } from "react";
import {
  Upload,
  FileSpreadsheet,
  ArrowLeft,
  ArrowRight,
  Check,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
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
import { formatCents } from "@/lib/accounting/money";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import type {
  CsvOptions,
  ParsedImportGroup,
} from "@/lib/accounting/imports/csv";
import type {
  ImportState,
  ImportGroup,
} from "@/lib/accounting/imports/contracts";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { uploadEvidence } from "./accounting-documents";
import { AccountingBankMatch } from "./accounting-bank-match";

const selectStyle =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
type Inspection = {
  headers: string[];
  samples: string[][];
  rowCount: number;
  fileHash: string;
  values: Record<string, string[]>;
};
type Preview = {
  fileHash: string;
  mappingHash: string;
  groups: ParsedImportGroup[];
  errorCount: number;
  rowCount: number;
};
const initialOptions: CsvOptions = {
  delimiter: ",",
  headerRow: 0,
  dateFormat: "yyyy-mm-dd",
  decimal: ".",
  thousands: "",
};
const emptyState: ImportState = {
  batches: [],
  groups: [],
  counts: {},
  total: 0,
};
const statusStyle: Record<string, string> = {
  new: "text-foreground",
  review: "text-amber-400",
  exception: "text-destructive",
  applied: "text-primary",
  duplicate: "text-muted-foreground",
  excluded: "text-muted-foreground",
};

export function AccountingImports({
  accounts,
  profiles,
  demo,
  onRefresh,
  onEntry,
}: {
  accounts: AccountingAccount[];
  profiles: AccountProfile[];
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const [data, setData] = useState<ImportState>(emptyState),
    [batchId, setBatchId] = useState(""),
    [offset, setOffset] = useState(0),
    [wizard, setWizard] = useState(false),
    [review, setReview] = useState<ImportGroup | null>(null),
    [approve, setApprove] = useState(false),
    [progress, setProgress] = useState(""),
    [loadError, setLoadError] = useState("");
  const [working, setWorking] = useState(false);
  const [bankGroup, setBankGroup] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false),
    [cancelReason, setCancelReason] = useState("");
  const active = useRef(false);
  const command = useAccountingCommand();
  const batch = data.batches.find((b) => b.id === batchId);
  async function reload(id = batchId, start = offset) {
    const next = await accountingGet<ImportState>({
      view: "imports",
      ...(id ? { batch: id } : {}),
      offset: String(start),
    });
    setData(next);
    return next;
  }
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    accountingGet<ImportState>(
      {
        view: "imports",
        ...(batchId ? { batch: batchId } : {}),
        offset: String(offset),
      },
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(e.message);
      });
    return () => controller.abort();
  }, [batchId, offset, demo]);
  async function apply() {
    if (!batch || active.current) return;
    active.current = true;
    setWorking(true);
    setApprove(false);
    setLoadError("");
    try {
      let current = await reload(batch.id, 0);
      while (true) {
        const currentBatch = current.batches.find((b) => b.id === batch.id)!;
        let pending = current.groups.filter((g) => g.status === "new");
        let page = 0;
        while (!pending.length && page + 100 < current.total) {
          page += 100;
          current = await accountingGet<ImportState>({
            view: "imports",
            batch: batch.id,
            offset: String(page),
          });
          pending = current.groups.filter((g) => g.status === "new");
        }
        if (!pending.length) break;
        const result = await command.execute({
          type: "import.apply",
          id: batch.id,
          expected_version: currentBatch.version,
          group_ids: pending.slice(0, 50).map((g) => g.id),
        });
        if (!result) break;
        current = await reload(batch.id, 0);
        setProgress(
          `${current.counts.applied ?? 0} of ${currentBatch.expected_groups} groups applied`,
        );
      }
      await reload(batch.id, offset);
      await onRefresh();
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "Batch paused. Refresh to resume.",
      );
    } finally {
      active.current = false;
      setWorking(false);
      setProgress("");
    }
  }
  async function finish() {
    if (!batch) return;
    const result = await command.execute({
      type: "import.finish",
      id: batch.id,
      expected_version: batch.version,
    });
    if (result) await reload();
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review imported activity</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Import journals or bank movements, review overlaps, and keep every
            source attached.
          </p>
        </div>
        <Button disabled={demo || working} onClick={() => setWizard(true)}>
          <Upload size={16} />
          Import CSV
        </Button>
      </div>
      {(loadError || command.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {loadError || command.error}
        </p>
      )}
      {!batchId ? (
        <section className="glass-card overflow-hidden">
          <div className="border-b border-border p-5">
            <h3 className="font-semibold">Import history</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              A completed batch confirms processing. Historical coverage is
              verified separately against source reports.
            </p>
          </div>
          {!data.batches.length ? (
            <div className="flex flex-col items-center p-12 text-center">
              <FileSpreadsheet
                className="mb-4 text-muted-foreground"
                size={30}
              />
              <p className="font-medium">Start with a small, familiar period</p>
              <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                Use a cash-basis journal export for complete historical entries,
                or a bank CSV for transactions you will categorize. The preview
                shows exactly what will be saved.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {data.batches.map((b) => (
                <button
                  key={b.id}
                  onClick={() => {
                    setBatchId(b.id);
                    setOffset(0);
                  }}
                  className="flex w-full flex-wrap items-center justify-between gap-3 p-5 text-left hover:bg-secondary/30"
                >
                  <div>
                    <p className="font-medium">{b.file_name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {b.source_system} ·{" "}
                      {b.source_system === "simplefin"
                        ? "Bank feed"
                        : b.source_scope}{" "}
                      · {b.from_date} to {b.to_date}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span>
                      {b.expected_groups}{" "}
                      {b.expected_groups === 1 ? "group" : "groups"}
                    </span>
                    <span className="rounded-md bg-secondary px-2 py-1 capitalize">
                      {b.status}
                    </span>
                    <ArrowRight size={16} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        batch && (
          <>
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setBatchId("");
                  setOffset(0);
                }}
                disabled={working}
              >
                <ArrowLeft size={16} />
                All imports
              </Button>
              <div>
                <h3 className="font-semibold">{batch.file_name}</h3>
                <p className="text-xs text-muted-foreground">
                  {batch.mode === "journal"
                    ? "Historical journals"
                    : "Bank movements"}{" "}
                  ·{" "}
                  {batch.source_system === "simplefin"
                    ? "Bank feed"
                    : batch.source_scope}{" "}
                  · {batch.status}
                </p>
              </div>
              <Button
                variant="ghost"
                className="ml-auto"
                disabled={working}
                onClick={() =>
                  void reload().catch((e) => setLoadError(e.message))
                }
                aria-label="Refresh import"
              >
                <RefreshCw size={16} />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["new", "Ready"],
                ["review", "Match review"],
                ["exception", "Exceptions"],
                ["applied", "Applied"],
              ].map(([key, label]) => (
                <div className="glass-card p-4" key={key}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`mt-2 text-2xl font-mono ${statusStyle[key]}`}>
                    {data.counts[key] ?? 0}
                  </p>
                </div>
              ))}
            </div>
            {batch.status === "staging" && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                <p>
                  Preview upload paused after {data.total} of{" "}
                  {batch.expected_groups} groups. Reopen the same CSV with the
                  same mapping to resume.
                </p>
                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={() => setWizard(true)}
                >
                  Resume upload
                </Button>
              </div>
            )}
            {["cancelled", "failed"].includes(batch.status) && (
              <div className="rounded-lg border border-border p-4 text-sm">
                <p>
                  This batch retains its source groups and any applied entries.
                  Resume from the saved checkpoint to finish the remaining work.
                </p>
                <Button
                  className="mt-3"
                  variant="outline"
                  disabled={working || command.busy}
                  onClick={async () => {
                    if (
                      await command.execute({
                        type: "import.resume",
                        id: batch.id,
                        expected_version: batch.version,
                      })
                    )
                      await reload().catch((e: Error) =>
                        setLoadError(e.message),
                      );
                  }}
                >
                  Resume batch
                </Button>
              </div>
            )}
            {["staging", "review", "applying"].includes(batch.status) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={working || command.busy}
                onClick={() => {
                  setCancelReason("");
                  setCancel(true);
                }}
              >
                Cancel this import batch
              </Button>
            )}
            <Dialog
              open={cancel}
              onOpenChange={(open) => {
                if (!command.busy) setCancel(open);
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Cancel this import batch?</DialogTitle>
                  <DialogDescription>
                    Applied entries remain in the books with their evidence. The
                    remaining groups stay available for a later resume. This
                    does not reverse any transactions.
                  </DialogDescription>
                </DialogHeader>
                <Input
                  label="Cancellation reason"
                  maxLength={1000}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                />
                {command.error && (
                  <p role="alert" className="text-sm text-error">
                    {command.error}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={command.busy}
                    onClick={() => setCancel(false)}
                  >
                    Back
                  </Button>
                  <Button
                    disabled={!cancelReason.trim() || command.busy}
                    loading={command.busy}
                    onClick={async () => {
                      if (
                        await command.execute({
                          type: "import.cancel",
                          id: batch.id,
                          expected_version: batch.version,
                          reason: cancelReason,
                        })
                      ) {
                        setCancel(false);
                        await reload().catch((e: Error) =>
                          setLoadError(e.message),
                        );
                      }
                    }}
                  >
                    Cancel batch
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            {["review", "applying"].includes(batch.status) && (
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">
                  {progress ||
                    `${data.counts.duplicate ?? 0} linked duplicates · ${data.counts.excluded ?? 0} excluded with a reason`}
                </p>
                <div className="flex gap-2">
                  <Button
                    disabled={
                      working ||
                      command.busy ||
                      !(data.counts.new > 0) ||
                      batch.basis !== "cash"
                    }
                    onClick={() => setApprove(true)}
                  >
                    Review{" "}
                    {batch.mode === "journal" ? "posting" : "draft creation"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      working ||
                      command.busy ||
                      data.total !== batch.expected_groups ||
                      ["new", "review", "exception"].some(
                        (s) => data.counts[s] > 0,
                      )
                    }
                    onClick={() => void finish()}
                  >
                    Complete batch
                  </Button>
                </div>
              </div>
            )}
            <div className="glass-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="p-4">Date / source group</th>
                    <th className="p-4">Description</th>
                    <th className="p-4 text-right">Amount</th>
                    <th className="p-4">Status</th>
                    <th className="p-4">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => (
                    <tr
                      key={g.id}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="whitespace-nowrap p-4">
                        {g.entry_date}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Group {g.ordinal + 1}
                        </span>
                      </td>
                      <td className="min-w-52 p-4">
                        <p>{g.memo}</p>
                        {g.reason && (
                          <p className="mt-1 max-w-lg text-xs text-muted-foreground">
                            {g.reason}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap p-4 text-right font-mono">
                        <MaskedValue
                          value={formatCents(
                            g.bank_amount_cents ??
                              g.lines.reduce(
                                (s, l) =>
                                  s +
                                  (BigInt(l.amount_cents) > BigInt(0)
                                    ? BigInt(l.amount_cents)
                                    : BigInt(0)),
                                BigInt(0),
                              ),
                          )}
                        />
                      </td>
                      <td
                        className={`p-4 capitalize ${statusStyle[g.status] ?? ""}`}
                      >
                        {g.status}
                      </td>
                      <td className="p-4">
                        {g.bank_amount_cents !== null &&
                          g.status !== "excluded" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mb-2"
                              disabled={working}
                              onClick={() => setBankGroup(g.id)}
                            >
                              Match bank movement
                            </Button>
                          )}
                        {g.entry_id ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onEntry(g.entry_id!)}
                          >
                            View entry
                          </Button>
                        ) : (
                          ["review", "exception", "new"].includes(g.status) && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={working}
                              onClick={() => setReview(g)}
                            >
                              Review
                            </Button>
                          )
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-border p-4 text-xs text-muted-foreground">
                <span>
                  {data.total
                    ? `${offset + 1}-${Math.min(offset + 100, data.total)} of ${data.total}`
                    : "No groups staged"}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!offset || working}
                    onClick={() => setOffset(offset - 100)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={offset + 100 >= data.total || working}
                    onClick={() => setOffset(offset + 100)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          </>
        )
      )}
      {bankGroup && (
        <AccountingBankMatch
          groupId={bankGroup}
          onClose={() => setBankGroup(null)}
          onEntry={onEntry}
          onSaved={async () => {
            await reload();
            await onRefresh();
          }}
        />
      )}
      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import your accounting data</DialogTitle>
            <DialogDescription>
              Choose the source, map the columns, and review before changing the
              books.
            </DialogDescription>
          </DialogHeader>
          {wizard && (
            <ImportWizard
              accounts={accounts}
              profiles={profiles}
              onDone={async (id) => {
                setWizard(false);
                setBatchId(id);
                setOffset(0);
                await reload(id, 0);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={approve} onOpenChange={setApprove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {batch?.mode === "journal"
                ? "Post imported historical entries"
                : "Create bank review drafts"}
            </DialogTitle>
            <DialogDescription>
              {batch?.mode === "journal"
                ? "These balanced entries will affect the normal ledger and reports. Corrections will preserve the original history."
                : "These movements will enter the review queue for categorization. They will affect reports when you post them."}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-secondary/40 p-4 text-sm">
            <p>{data.counts.new ?? 0} ready groups</p>
            <p className="mt-2 text-muted-foreground">
              Duplicates remain linked to their existing entries. Unresolved
              matches and exceptions stay pending.
            </p>
          </div>
          <Button onClick={() => void apply()}>
            <Check size={16} />
            Approve {batch?.mode === "journal" ? "posting" : "drafts"}
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review source group</DialogTitle>
            <DialogDescription>{review?.memo}</DialogDescription>
          </DialogHeader>
          {review && (
            <ImportResolution
              group={review}
              onEntry={onEntry}
              onSaved={async () => {
                setReview(null);
                await reload();
                await onRefresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImportResolution({
  group,
  onSaved,
  onEntry,
}: {
  group: ImportGroup;
  onSaved: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const [resolution, setResolution] = useState<"new" | "match" | "exclude">(
      group.candidate_entry_id ? "match" : "exclude",
    ),
    [entry, setEntry] = useState(group.candidate_entry_id ?? ""),
    [reason, setReason] = useState("");
  const command = useAccountingCommand(onSaved);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void command.execute({
          type: "import.resolve",
          id: group.id,
          expected_version: group.version,
          resolution,
          ...(resolution === "match" ? { entry_id: entry } : {}),
          reason,
        });
      }}
    >
      {group.reason && <p className="text-sm text-amber-400">{group.reason}</p>}
      {group.candidate_entry_id && (
        <Button
          type="button"
          variant="outline"
          onClick={() => onEntry(group.candidate_entry_id!)}
        >
          Inspect suggested entry
        </Button>
      )}
      <label className="block text-sm">
        Treatment
        <select
          className={selectStyle}
          value={resolution}
          onChange={(e) => setResolution(e.target.value as typeof resolution)}
        >
          <option value="match">Attach to an existing posted entry</option>
          {group.status !== "exception" && (
            <option value="new">Separate transaction, keep as new</option>
          )}
          <option value="exclude">Exclude this source observation</option>
        </select>
      </label>
      {resolution === "match" && (
        <label className="block text-sm">
          Existing entry ID
          <Input
            className="mt-1"
            required
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="Paste entry ID from transaction detail"
          />
        </label>
      )}
      <label className="block text-sm">
        Reason
        <Input
          className="mt-1"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={1000}
          placeholder="Explain how you verified this treatment"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Matching checks the actual account and amount. Exclusion preserves the
        observation and does not certify historical coverage.
      </p>
      {command.error && (
        <p role="alert" className="text-sm text-destructive">
          {command.error}
        </p>
      )}
      <Button disabled={command.busy || !reason.trim()}>Save treatment</Button>
    </form>
  );
}

function ImportWizard({
  accounts,
  profiles,
  onDone,
}: {
  accounts: AccountingAccount[];
  profiles: AccountProfile[];
  onDone: (id: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null),
    [options, setOptions] = useState<CsvOptions>(initialOptions),
    [inspection, setInspection] = useState<Inspection | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [mode, setMode] = useState<"journal" | "bank">("journal"),
    [source, setSource] = useState<"wave" | "csv">("wave"),
    [scope, setScope] = useState(""),
    [cashConfirmed, setCashConfirmed] = useState(false),
    [columns, setColumns] = useState<Record<string, string>>({}),
    [accountMap, setAccountMap] = useState<Record<string, string>>({}),
    [bankAccount, setBankAccount] = useState(""),
    [signed, setSigned] = useState(false),
    [sign, setSign] = useState<"deposits_positive" | "withdrawals_positive">(
      "deposits_positive",
    ),
    [stable, setStable] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState("");
  const ids = useRef<{
    batch: string;
    document: string;
    groups: string[];
  } | null>(null);
  const active = useRef(false);
  const command = useAccountingCommand();
  const bankIds = new Set(
    profiles.filter((p) => p.cash_kind !== "none").map((p) => p.account_id),
  );
  const sourceAccounts = inspection?.values[columns.account] ?? [];
  async function parse(phase: "inspect" | "preview") {
    if (!file || active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("phase", phase);
      form.set("options", JSON.stringify(options));
      form.set("mode", mode);
      const amountColumns = signed
        ? { amount: columns.amount }
        : {
            debit: columns.debit || undefined,
            credit: columns.credit || undefined,
          };
      form.set(
        "mapping",
        JSON.stringify(
          mode === "journal"
            ? {
                group: columns.group,
                date: columns.date,
                memo: columns.memo,
                account: columns.account,
                ...amountColumns,
                lineMemo: columns.lineMemo || undefined,
                stableGroupIds: stable,
                accounts: accountMap,
              }
            : {
                date: columns.date,
                description: columns.memo,
                ...amountColumns,
                externalId: columns.group || undefined,
                sign,
                accountId: bankAccount,
              },
        ),
      );
      const response = await fetch("/api/accounting/imports", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Unable to inspect CSV.");
      if (phase === "inspect") {
        setInspection(result);
        setPreview(null);
        setColumns({});
        setAccountMap({});
      } else {
        setPreview(result);
        ids.current = {
          batch: crypto.randomUUID(),
          document: crypto.randomUUID(),
          groups: result.groups.map(() => crypto.randomUUID()),
        };
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to parse CSV.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function stage() {
    if (!preview || !file || !ids.current || active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const dates = preview.groups.map((g) => g.entry_date).sort();
      setProgress("Retaining the original source file");
      const document = await uploadEvidence(file, ids.current.document);
      const created = await command.execute({
        type: "import.create",
        id: ids.current.batch,
        source_system: source,
        source_scope: scope.trim(),
        file_hash: preview.fileHash,
        mapping_hash: preview.mappingHash,
        file_name: file.name,
        source_document_id: document.id,
        mode,
        basis: cashConfirmed ? "cash" : "unconfirmed",
        expected_groups: preview.groups.length,
        from: dates[0],
        to: dates[dates.length - 1],
      });
      if (!created) return;
      let state = await accountingGet<ImportState>({
        view: "imports",
        batch: created.id,
        offset: "0",
      });
      let batch = state.batches.find((b) => b.id === created.id)!;
      if (batch.basis !== (cashConfirmed ? "cash" : "unconfirmed"))
        throw new Error(
          "This file was previously staged with a different accounting basis. Review that batch before proceeding.",
        );
      while (
        batch.status === "staging" &&
        state.total < preview.groups.length
      ) {
        const start = state.total;
        const groups = preview.groups.slice(start, start + 50).map((g, i) => ({
          ...g,
          source_hash: g.source_hash!,
          id: ids.current!.groups[start + i],
          ordinal: start + i,
        }));
        const result = await command.execute({
          type: "import.stage",
          id: created.id,
          expected_version: batch.version,
          groups,
        });
        if (!result) return;
        state = await accountingGet<ImportState>({
          view: "imports",
          batch: created.id,
          offset: "0",
        });
        batch = state.batches.find((b) => b.id === created.id)!;
        setProgress(`${state.total} of ${preview.groups.length} groups staged`);
      }
      await onDone(created.id);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Upload paused. Reopen this file to resume.",
      );
    } finally {
      active.current = false;
      setBusy(false);
      setProgress("");
    }
  }
  function column(key: string, label: string, optional = false) {
    return (
      <label key={key} className="block text-sm">
        {label}
        <select
          className={selectStyle}
          value={columns[key] ?? ""}
          onChange={(e) => {
            setColumns({ ...columns, [key]: e.target.value });
            setPreview(null);
          }}
        >
          <option value="">
            {optional ? "Not included" : "Choose column"}
          </option>
          {inspection?.headers.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </label>
    );
  }
  if (preview) {
    const total = preview.groups.reduce(
      (sum, g) =>
        sum +
        (g.bank_amount_cents
          ? BigInt(g.bank_amount_cents)
          : g.lines.reduce(
              (s, l) =>
                s +
                (BigInt(l.amount_cents) > BigInt(0)
                  ? BigInt(l.amount_cents)
                  : BigInt(0)),
              BigInt(0),
            )),
      BigInt(0),
    );
    return (
      <div className="space-y-5">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setPreview(null)}
        >
          <ArrowLeft size={16} />
          Adjust mapping
        </Button>
        <div className="grid grid-cols-3 gap-3">
          {[
            ["Groups", String(preview.groups.length)],
            ["Invalid groups", String(preview.errorCount)],
            [
              mode === "journal" ? "Total debits" : "Net movement",
              formatCents(total),
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-secondary/30 p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-2 font-mono text-xl">
                <MaskedValue value={value} />
              </p>
            </div>
          ))}
        </div>
        <div className="max-h-80 overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="p-3">Date</th>
                <th className="p-3">Description / validation</th>
                <th className="p-3 text-right">Lines</th>
              </tr>
            </thead>
            <tbody>
              {preview.groups.slice(0, 100).map((g, i) => (
                <tr className="border-t border-border" key={i}>
                  <td className="whitespace-nowrap p-3">
                    {g.entry_date || "Invalid date"}
                  </td>
                  <td className="p-3">
                    {g.memo}
                    {g.errors.map((error, n) => (
                      <p className="mt-1 text-xs text-destructive" key={n}>
                        {error}
                      </p>
                    ))}
                  </td>
                  <td className="p-3 text-right">
                    {mode === "journal" ? (
                      g.lines.length
                    ) : (
                      <MaskedValue
                        value={formatCents(g.bank_amount_cents ?? "0")}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Showing the first {Math.min(100, preview.groups.length)} groups. Every
          row is validated. Saving this preview checks existing sources and
          creates a resumable review batch.
        </p>
        {preview.errorCount > 0 && (
          <p role="alert" className="text-sm text-destructive">
            Resolve every validation error before staging. Correct the mapping
            or the source file, then preview again.
          </p>
        )}
        {(error || command.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || command.error}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span role="status" className="text-sm text-muted-foreground">
            {progress}
          </span>
          <Button
            disabled={busy || preview.errorCount > 0 || !cashConfirmed}
            onClick={() => void stage()}
          >
            {busy ? "Saving preview…" : "Save preview and check duplicates"}
            <ArrowRight size={16} />
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          Import type
          <select
            className={selectStyle}
            disabled={!!inspection}
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="journal">
              Journal entries, complete debits and credits
            </option>
            <option value="bank">
              Bank or card movements, categorize later
            </option>
          </select>
        </label>
        <label className="block text-sm">
          Source
          <select
            className={selectStyle}
            disabled={!!inspection}
            value={source}
            onChange={(e) => setSource(e.target.value as typeof source)}
          >
            <option value="wave">Wave</option>
            <option value="csv">Other CSV</option>
          </select>
        </label>
        <label className="block text-sm sm:col-span-2">
          Source scope
          <Input
            className="mt-1"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="e.g. Wave company ledger, or Chase checking 1234"
            maxLength={250}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Use the same scope for future exports of this ledger or account.
            Keep years and filenames out of the scope.
          </span>
        </label>
      </div>
      {!inspection ? (
        <>
          <label className="block rounded-lg border border-dashed border-border p-6 text-center">
            <Upload className="mx-auto mb-3 text-primary" size={24} />
            <span className="text-sm">Choose a UTF-8 CSV, up to 20 MB</span>
            <input
              aria-label="CSV file"
              className="mt-4 block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-secondary file:px-4 file:py-2 file:text-foreground"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="text-sm">
              Delimiter
              <select
                className={selectStyle}
                value={options.delimiter}
                onChange={(e) =>
                  setOptions({
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
            <label className="text-sm">
              Header row
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={51}
                value={options.headerRow + 1}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    headerRow: Number(e.target.value) - 1,
                  })
                }
              />
            </label>
          </div>
          <Button
            disabled={!file || !scope.trim() || busy}
            onClick={() => void parse("inspect")}
          >
            Read columns
            <ArrowRight size={16} />
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between rounded-lg bg-secondary/30 p-4">
            <p className="text-sm">
              {file?.name} · {inspection.rowCount} rows
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setInspection(null)}
            >
              Change file
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr>
                  {inspection.headers.map((h) => (
                    <th key={h} className="p-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inspection.samples.slice(0, 3).map((row, i) => (
                  <tr key={i} className="border-t border-border">
                    {row.map((v, n) => (
                      <td
                        key={n}
                        className="max-w-60 truncate p-2 text-muted-foreground"
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm">
              Date format
              <select
                className={selectStyle}
                value={options.dateFormat}
                onChange={(e) =>
                  setOptions({
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
              Decimal separator
              <select
                className={selectStyle}
                value={options.decimal}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    decimal: e.target.value as CsvOptions["decimal"],
                  })
                }
              >
                <option value=".">Period (123.45)</option>
                <option value=",">Comma (123,45)</option>
              </select>
            </label>
            <label className="text-sm">
              Thousands separator
              <select
                className={selectStyle}
                value={options.thousands}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    thousands: e.target.value as CsvOptions["thousands"],
                  })
                }
              >
                <option value="">None</option>
                <option value=",">Comma</option>
                <option value=".">Period</option>
                <option value=" ">Space</option>
              </select>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {column("date", "Transaction date")}
            {column(
              "memo",
              mode === "journal" ? "Shared journal description" : "Description",
            )}
            {column(
              "group",
              mode === "journal" ? "Journal group ID" : "Source transaction ID",
              mode === "bank",
            )}
            {mode === "journal" ? (
              column("account", "Source account")
            ) : (
              <label className="text-sm">
                Bank or card account
                <select
                  className={selectStyle}
                  value={bankAccount}
                  onChange={(e) => setBankAccount(e.target.value)}
                >
                  <option value="">Choose account</option>
                  {accounts
                    .filter((a) => bankIds.has(a.id) && !a.is_archived)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={signed}
              onChange={(e) => setSigned(e.target.checked)}
            />
            File uses one signed amount column
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {signed ? (
              column("amount", "Signed amount")
            ) : (
              <>
                {column(
                  "debit",
                  mode === "journal" ? "Debit" : "Withdrawal",
                  true,
                )}
                {column(
                  "credit",
                  mode === "journal" ? "Credit" : "Deposit",
                  true,
                )}
              </>
            )}
            {mode === "bank" && signed && (
              <label className="text-sm">
                Positive amounts mean
                <select
                  className={selectStyle}
                  value={sign}
                  onChange={(e) => setSign(e.target.value as typeof sign)}
                >
                  <option value="deposits_positive">
                    Deposits / card payments and refunds
                  </option>
                  <option value="withdrawals_positive">
                    Withdrawals / card purchases
                  </option>
                </select>
              </label>
            )}
            {mode === "journal" && column("lineMemo", "Line description", true)}
          </div>
          {mode === "journal" && (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={stable}
                  onChange={(e) => setStable(e.target.checked)}
                />
                <span>
                  Group IDs are stable across repeated exports
                  <span className="block text-xs text-muted-foreground">
                    Leave unchecked for export row numbers or IDs that are
                    regenerated.
                  </span>
                </span>
              </label>
              {sourceAccounts.length > 500 ? (
                <p className="text-sm text-destructive">
                  This column has more than 500 values. Verify that you selected
                  the account column.
                </p>
              ) : (
                sourceAccounts.length > 0 && (
                  <section className="rounded-lg border border-border p-4">
                    <h4 className="mb-3 font-medium">Map accounts</h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {sourceAccounts.map((label) => (
                        <label key={label} className="text-sm">
                          {label || "(blank)"}
                          <select
                            className={selectStyle}
                            value={accountMap[label] ?? ""}
                            onChange={(e) =>
                              setAccountMap({
                                ...accountMap,
                                [label]: e.target.value,
                              })
                            }
                          >
                            <option value="">Choose account</option>
                            {accounts
                              .filter((a) => !a.is_archived)
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.code} · {a.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </section>
                )
              )}
            </>
          )}
          <label className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={cashConfirmed}
              onChange={(e) => setCashConfirmed(e.target.checked)}
            />
            <span>
              {mode === "journal"
                ? "I verified this export is suitable for cash-basis books. It excludes unsupported accrual conversions and duplicate annual closing entries."
                : "These are actual movements on the selected business account."}
              <span className="mt-1 block text-xs text-muted-foreground">
                Unverified historical conversions need a source report
                comparison before they can be considered complete.
              </span>
            </span>
          </label>
          <Button
            disabled={
              busy ||
              !cashConfirmed ||
              !scope.trim() ||
              sourceAccounts.length > 500
            }
            onClick={() => void parse("preview")}
          >
            Validate and preview
            <ArrowRight size={16} />
          </Button>
        </>
      )}
      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive"
        >
          <AlertCircle size={16} />
          {error}
        </p>
      )}
    </div>
  );
}
