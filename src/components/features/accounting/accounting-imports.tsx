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
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SectionHeader } from "@/components/ui/section-header";
import { CustomSelect } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import type {
  CsvOptions,
  ParsedImportGroup,
} from "@/lib/accounting/imports/csv";
import type {
  ImportBatch,
  ImportState,
  ImportGroup,
} from "@/lib/accounting/imports/contracts";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { uploadEvidence } from "./accounting-documents";
import { AccountingBankMatch } from "./accounting-bank-match";
import { AccountingEntryPicker } from "./accounting-entry-picker";
import {
  comparisonLabels,
  importComparisonFilterSchema,
  type ComparisonGroup,
  type ComparisonRow,
  type ImportComparison,
  type ImportComparisonFilter,
} from "@/lib/accounting/imports/comparison";
import { countLabel, dateLabel, enumLabel, money } from "./format";

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
type PreviewRow = { group: ParsedImportGroup; index: number };
type SampleRow = { cells: string[]; index: number };
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
  review: "text-warning",
  exception: "text-error",
  applied: "text-teal-light",
  duplicate: "text-muted-foreground",
  excluded: "text-muted-foreground",
};
const statusVariant: Record<string, BadgeVariant> = {
  review: "warning",
  exception: "danger",
  applied: "info",
};
const groupAmount = (g: ImportGroup) =>
  money(
    g.bank_amount_cents ??
      g.lines.reduce(
        (s, l) =>
          s +
          (BigInt(l.amount_cents) > BigInt(0)
            ? BigInt(l.amount_cents)
            : BigInt(0)),
        BigInt(0),
      ),
  );
const batchSource = (b: ImportBatch) =>
  `${b.source_system} · ${b.source_system === "simplefin" ? "Bank feed" : b.source_scope}`;
const batchPeriod = (b: ImportBatch) =>
  `${dateLabel(b.from_date)} to ${dateLabel(b.to_date)}`;

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
  const [comparison, setComparison] = useState(false);
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
  function openBatch(id: string) {
    setBatchId(id);
    setOffset(0);
  }
  const batchLink = (b: ImportBatch) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openBatch(b.id);
      }}
      className="rounded text-left font-medium text-foreground transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {b.file_name}
    </button>
  );
  const batchColumns: DataTableColumn<ImportBatch>[] = [
    { key: "file", header: "File", render: batchLink },
    { key: "source", header: "Source", render: batchSource },
    {
      key: "period",
      header: "Period",
      className: "whitespace-nowrap",
      render: batchPeriod,
    },
    {
      key: "groups",
      header: "Groups",
      align: "right",
      numeric: true,
      render: (b) => countLabel(b.expected_groups, "group"),
    },
    {
      key: "status",
      header: "Status",
      render: (b) => <Badge>{enumLabel(b.status)}</Badge>,
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      align: "right",
      width: "w-10",
      render: () => (
        <ArrowRight
          size={16}
          aria-hidden="true"
          className="inline-block text-muted-foreground"
        />
      ),
    },
  ];
  const batchCard = (b: ImportBatch) => (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {batchLink(b)}
          <p className="mt-1 text-xs text-muted-foreground">
            {batchSource(b)} · {batchPeriod(b)}
          </p>
        </div>
        <ArrowRight
          size={16}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
      </div>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <span className="tabular-nums">
          {countLabel(b.expected_groups, "group")}
        </span>
        <Badge>{enumLabel(b.status)}</Badge>
      </div>
    </div>
  );
  const groupActions = (g: ImportGroup) => (
    <div className="flex flex-wrap justify-end gap-2">
      {g.bank_amount_cents !== null && g.status !== "excluded" && (
        <Button
          variant="outline"
          size="sm"
          disabled={working}
          onClick={() => setBankGroup(g.id)}
        >
          Match bank movement
        </Button>
      )}
      {g.entry_id ? (
        <Button variant="ghost" size="sm" onClick={() => onEntry(g.entry_id!)}>
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
    </div>
  );
  const groupColumns: DataTableColumn<ImportGroup>[] = [
    {
      key: "date",
      header: "Date / source group",
      className: "whitespace-nowrap",
      render: (g) => (
        <>
          {dateLabel(g.entry_date)}
          <span className="mt-1 block text-xs text-muted-foreground">
            Group {g.ordinal + 1}
          </span>
        </>
      ),
    },
    {
      key: "memo",
      header: "Description",
      className: "min-w-52",
      render: (g) => (
        <>
          <p>{g.memo}</p>
          {g.reason && (
            <p className="mt-1 max-w-lg text-xs text-muted-foreground">
              {g.reason}
            </p>
          )}
        </>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      className: "whitespace-nowrap",
      render: (g) => (
        <MaskedValue value={groupAmount(g)} className="font-mono" />
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (g) => (
        <Badge variant={statusVariant[g.status] ?? "default"}>
          {enumLabel(g.status)}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Action</span>,
      align: "right",
      render: groupActions,
    },
  ];
  const groupCard = (g: ImportGroup) => (
    <div className="glass-card rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{dateLabel(g.entry_date)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Group {g.ordinal + 1}
          </p>
        </div>
        <Badge variant={statusVariant[g.status] ?? "default"}>
          {enumLabel(g.status)}
        </Badge>
      </div>
      <p className="mt-3 text-sm">{g.memo}</p>
      {g.reason && (
        <p className="mt-1 text-xs text-muted-foreground">{g.reason}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <MaskedValue
          value={groupAmount(g)}
          className="font-mono text-sm tabular-nums"
        />
        {groupActions(g)}
      </div>
    </div>
  );
  if (comparison)
    return (
      <ImportComparisonPanel
        batches={data.batches}
        initialLater={batchId}
        onBack={() => setComparison(false)}
        onReview={(id, group) => {
          setComparison(false);
          setBatchId(id);
          setOffset(0);
          setReview(group);
        }}
      />
    );
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
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={demo || working || data.batches.length < 2}
            onClick={() => setComparison(true)}
          >
            Compare exports
          </Button>
          <Button disabled={demo || working} onClick={() => setWizard(true)}>
            <Upload size={16} aria-hidden="true" />
            Import CSV
          </Button>
        </div>
      </div>
      {(loadError || command.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/10 p-4 text-sm text-error"
        >
          {loadError || command.error}
        </p>
      )}
      {!batchId ? (
        <section>
          <SectionHeader
            label="Import history"
            count={data.batches.length}
            description="A completed batch confirms processing. Historical coverage is verified separately against source reports."
          />
          {!data.batches.length ? (
            <div className="glass-card flex flex-col items-center rounded-xl p-12 text-center">
              <FileSpreadsheet
                className="mb-4 text-muted-foreground"
                size={30}
                aria-hidden="true"
              />
              <p className="font-medium">Start with a small, familiar period</p>
              <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                Use a cash-basis journal export for complete historical entries,
                or a bank CSV for transactions you will categorize. The preview
                shows exactly what will be saved.
              </p>
            </div>
          ) : (
            <DataTable
              columns={batchColumns}
              data={data.batches}
              keyExtractor={(b) => b.id}
              onRowClick={(b) => openBatch(b.id)}
              mobileCard={batchCard}
            />
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
                <ArrowLeft size={16} aria-hidden="true" />
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
                  · {enumLabel(batch.status)}
                </p>
              </div>
              <Tooltip content="Refresh import" className="ml-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={working}
                  onClick={() =>
                    void reload().catch((e) => setLoadError(e.message))
                  }
                  aria-label="Refresh import"
                >
                  <RefreshCw size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["new", "Ready"],
                ["review", "Match review"],
                ["exception", "Exceptions"],
                ["applied", "Applied"],
              ].map(([key, label]) => (
                <div className="glass-card rounded-xl p-4" key={key}>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p
                    className={`mt-2 font-mono text-2xl tabular-nums ${statusStyle[key]}`}
                  >
                    {data.counts[key] ?? 0}
                  </p>
                </div>
              ))}
            </div>
            {batch.status === "staging" && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm">
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
            <DataTable
              columns={groupColumns}
              data={data.groups}
              keyExtractor={(g) => g.id}
              emptyState="No groups staged"
              busy={working}
              mobileCard={groupCard}
              after={
                <Pagination
                  offset={offset}
                  limit={100}
                  total={data.total}
                  onChange={setOffset}
                  noun="groups"
                  busy={working}
                />
              }
            />
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
          <div className="glass-card rounded-xl p-4 text-sm">
            <p>{data.counts.new ?? 0} ready groups</p>
            <p className="mt-2 text-muted-foreground">
              Duplicates remain linked to their existing entries. Unresolved
              matches and exceptions stay pending.
            </p>
          </div>
          <Button onClick={() => void apply()}>
            <Check size={16} aria-hidden="true" />
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
      {group.reason && <p className="text-sm text-warning">{group.reason}</p>}
      {group.candidate_entry_id && (
        <Button
          type="button"
          variant="outline"
          onClick={() => onEntry(group.candidate_entry_id!)}
        >
          Inspect suggested entry
        </Button>
      )}
      <CustomSelect
        id="import-resolution"
        label="Treatment"
        value={resolution}
        onChange={(value) => setResolution(value as typeof resolution)}
        options={[
          { value: "match", label: "Attach to an existing posted entry" },
          ...(group.status !== "exception"
            ? [{ value: "new", label: "Separate transaction, keep as new" }]
            : []),
          { value: "exclude", label: "Exclude this source observation" },
        ]}
      />
      {resolution === "match" && (
        <AccountingEntryPicker
          value={entry}
          onChange={setEntry}
          postedOnly
          disabled={command.busy}
        />
      )}
      <Input
        label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        maxLength={1000}
        placeholder="Explain how you verified this treatment"
      />
      <p className="text-xs text-muted-foreground">
        Matching checks the actual account and amount. Exclusion preserves the
        observation and does not certify historical coverage.
      </p>
      {command.error && (
        <p role="alert" className="text-sm text-error">
          {command.error}
        </p>
      )}
      <Button
        disabled={
          command.busy || !reason.trim() || (resolution === "match" && !entry)
        }
      >
        Save treatment
      </Button>
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
  const bankAccountOptions = accounts
    .filter((a) => bankIds.has(a.id) && !a.is_archived)
    .map((a) => ({ value: a.id, label: a.name, keywords: a.code }));
  const accountOptions = accounts
    .filter((a) => !a.is_archived)
    .map((a) => ({
      value: a.id,
      label: `${a.code} · ${a.name}`,
      group: enumLabel(a.account_type),
    }))
    .sort(
      (a, b) =>
        a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );
  const sampleRows: SampleRow[] = (inspection?.samples ?? [])
    .slice(0, 3)
    .map((cells, index) => ({ cells, index }));
  const sampleColumns: DataTableColumn<SampleRow>[] = (
    inspection?.headers ?? []
  ).map((h, n) => ({
    key: `${n}:${h}`,
    header: h,
    className: "whitespace-nowrap",
    render: (row) => (
      <span className="block max-w-60 truncate text-xs text-muted-foreground">
        {row.cells[n]}
      </span>
    ),
  }));
  const sampleCard = (row: SampleRow) => (
    <dl className="glass-card rounded-xl p-4 text-xs">
      {(inspection?.headers ?? []).map((h, n) => (
        <div key={`${n}:${h}`} className="flex justify-between gap-3 py-1">
          <dt className="shrink-0 font-medium">{h}</dt>
          <dd className="min-w-0 truncate text-right text-muted-foreground">
            {row.cells[n]}
          </dd>
        </div>
      ))}
    </dl>
  );
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
      <CustomSelect
        key={key}
        id={`column-${key}`}
        label={label}
        value={columns[key] ?? ""}
        onChange={(value) => {
          setColumns({ ...columns, [key]: value });
          setPreview(null);
        }}
        options={[
          { value: "", label: optional ? "Not included" : "Choose column" },
          ...(inspection?.headers ?? []).map((h) => ({ value: h, label: h })),
        ]}
      />
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
    const previewRows: PreviewRow[] = preview.groups
      .slice(0, 100)
      .map((group, index) => ({ group, index }));
    const previewLines = (group: ParsedImportGroup) =>
      mode === "journal" ? (
        group.lines.length
      ) : (
        <MaskedValue value={money(group.bank_amount_cents ?? "0")} />
      );
    const previewColumns: DataTableColumn<PreviewRow>[] = [
      {
        key: "date",
        header: "Date",
        className: "whitespace-nowrap",
        render: ({ group }) => dateLabel(group.entry_date) || "Invalid date",
      },
      {
        key: "memo",
        header: "Description / validation",
        render: ({ group }) => (
          <>
            {group.memo}
            {group.errors.map((issue, n) => (
              <p className="mt-1 text-xs text-error" key={n}>
                {issue}
              </p>
            ))}
          </>
        ),
      },
      {
        key: "lines",
        header: "Lines",
        align: "right",
        numeric: true,
        render: ({ group }) => previewLines(group),
      },
    ];
    const previewCard = ({ group }: PreviewRow) => (
      <div className="glass-card rounded-xl p-4 text-sm">
        <div className="flex items-start justify-between gap-3">
          <span className="whitespace-nowrap">
            {dateLabel(group.entry_date) || "Invalid date"}
          </span>
          <span className="font-mono tabular-nums">{previewLines(group)}</span>
        </div>
        <p className="mt-2">{group.memo}</p>
        {group.errors.map((issue, n) => (
          <p className="mt-1 text-xs text-error" key={n}>
            {issue}
          </p>
        ))}
      </div>
    );
    return (
      <div className="space-y-5">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setPreview(null)}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Adjust mapping
        </Button>
        <div className="grid grid-cols-3 gap-3">
          {[
            ["Groups", String(preview.groups.length)],
            ["Invalid groups", String(preview.errorCount)],
            [
              mode === "journal" ? "Total debits" : "Net movement",
              money(total),
            ],
          ].map(([label, value]) => (
            <div key={label} className="glass-card rounded-xl p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-2 font-mono text-xl tabular-nums">
                <MaskedValue value={value} />
              </p>
            </div>
          ))}
        </div>
        <div className="glass-card max-h-80 overflow-auto rounded-xl">
          <DataTable
            columns={previewColumns}
            data={previewRows}
            keyExtractor={(row) => String(row.index)}
            framed={false}
            className="max-lg:p-3"
            mobileCard={previewCard}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Showing the first {Math.min(100, preview.groups.length)} groups. Every
          row is validated. Saving this preview checks existing sources and
          creates a resumable review batch.
        </p>
        {preview.errorCount > 0 && (
          <p role="alert" className="text-sm text-error">
            Resolve every validation error before staging. Correct the mapping
            or the source file, then preview again.
          </p>
        )}
        {(error || command.error) && (
          <p role="alert" className="text-sm text-error">
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
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <CustomSelect
          id="import-mode"
          label="Import type"
          disabled={!!inspection}
          value={mode}
          onChange={(value) => setMode(value as typeof mode)}
          options={[
            {
              value: "journal",
              label: "Journal entries, complete debits and credits",
            },
            {
              value: "bank",
              label: "Bank or card movements, categorize later",
            },
          ]}
        />
        <CustomSelect
          id="import-source"
          label="Source"
          disabled={!!inspection}
          value={source}
          onChange={(value) => setSource(value as typeof source)}
          options={[
            { value: "wave", label: "Wave" },
            { value: "csv", label: "Other CSV" },
          ]}
        />
        <div className="sm:col-span-2">
          <Input
            label="Source scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="e.g. Wave company ledger, or Chase checking 1234"
            maxLength={250}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Use the same scope for future exports of this ledger or account.
            Keep years and filenames out of the scope.
          </p>
        </div>
      </div>
      {!inspection ? (
        <>
          <label className="block rounded-lg border border-dashed border-border p-6 text-center">
            <Upload
              className="mx-auto mb-3 text-teal-light"
              size={24}
              aria-hidden="true"
            />
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
            <CustomSelect
              id="csv-delimiter"
              label="Delimiter"
              value={options.delimiter}
              onChange={(value) =>
                setOptions({
                  ...options,
                  delimiter: value as CsvOptions["delimiter"],
                })
              }
              options={[
                { value: ",", label: "Comma" },
                { value: ";", label: "Semicolon" },
                { value: "\t", label: "Tab" },
              ]}
            />
            <Input
              label="Header row"
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
          </div>
          <Button
            disabled={!file || !scope.trim() || busy}
            onClick={() => void parse("inspect")}
          >
            Read columns
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </>
      ) : (
        <>
          <div className="glass-card flex items-center justify-between rounded-xl p-4">
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
          <DataTable
            columns={sampleColumns}
            data={sampleRows}
            keyExtractor={(row) => String(row.index)}
            mobileCard={sampleCard}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <CustomSelect
              id="csv-date-format"
              label="Date format"
              value={options.dateFormat}
              onChange={(value) =>
                setOptions({
                  ...options,
                  dateFormat: value as CsvOptions["dateFormat"],
                })
              }
              options={[
                { value: "yyyy-mm-dd", label: "YYYY-MM-DD" },
                { value: "mm/dd/yyyy", label: "MM/DD/YYYY" },
                { value: "dd/mm/yyyy", label: "DD/MM/YYYY" },
              ]}
            />
            <CustomSelect
              id="csv-decimal"
              label="Decimal separator"
              value={options.decimal}
              onChange={(value) =>
                setOptions({
                  ...options,
                  decimal: value as CsvOptions["decimal"],
                })
              }
              options={[
                { value: ".", label: "Period (123.45)" },
                { value: ",", label: "Comma (123,45)" },
              ]}
            />
            <CustomSelect
              id="csv-thousands"
              label="Thousands separator"
              value={options.thousands}
              onChange={(value) =>
                setOptions({
                  ...options,
                  thousands: value as CsvOptions["thousands"],
                })
              }
              options={[
                { value: "", label: "None" },
                { value: ",", label: "Comma" },
                { value: ".", label: "Period" },
                { value: " ", label: "Space" },
              ]}
            />
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
              <SearchableSelect
                label="Bank or card account"
                visibleLabel="Bank or card account"
                value={bankAccount}
                onChange={setBankAccount}
                placeholder="Choose account"
                options={bankAccountOptions}
              />
            )}
          </div>
          <Checkbox
            checked={signed}
            onChange={setSigned}
            label="File uses one signed amount column"
          />
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
              <CustomSelect
                id="bank-sign"
                label="Positive amounts mean"
                value={sign}
                onChange={(value) => setSign(value as typeof sign)}
                options={[
                  {
                    value: "deposits_positive",
                    label: "Deposits / card payments and refunds",
                  },
                  {
                    value: "withdrawals_positive",
                    label: "Withdrawals / card purchases",
                  },
                ]}
              />
            )}
            {mode === "journal" && column("lineMemo", "Line description", true)}
          </div>
          {mode === "journal" && (
            <>
              <Checkbox
                className="items-start text-left"
                checked={stable}
                onChange={setStable}
                label={
                  <span className="block">
                    Group IDs are stable across repeated exports
                    <span className="block text-xs font-normal text-muted-foreground">
                      Leave unchecked for export row numbers or IDs that are
                      regenerated.
                    </span>
                  </span>
                }
              />
              {sourceAccounts.length > 500 ? (
                <p className="text-sm text-error">
                  This column has more than 500 values. Verify that you selected
                  the account column.
                </p>
              ) : (
                sourceAccounts.length > 0 && (
                  <section className="rounded-lg border border-border p-4">
                    <SectionHeader
                      label="Map accounts"
                      count={sourceAccounts.length}
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      {sourceAccounts.map((label) => (
                        <SearchableSelect
                          key={label}
                          label={`Account for ${label || "(blank)"}`}
                          visibleLabel={label || "(blank)"}
                          value={accountMap[label] ?? ""}
                          onChange={(value) =>
                            setAccountMap({
                              ...accountMap,
                              [label]: value,
                            })
                          }
                          placeholder="Choose account"
                          options={accountOptions}
                        />
                      ))}
                    </div>
                  </section>
                )
              )}
            </>
          )}
          <div className="rounded-lg border border-border p-4">
            <Checkbox
              className="items-start text-left"
              checked={cashConfirmed}
              onChange={setCashConfirmed}
              label={
                <span className="block">
                  {mode === "journal"
                    ? "I verified this export is suitable for cash-basis books. It excludes unsupported accrual conversions and duplicate annual closing entries."
                    : "These are actual movements on the selected business account."}
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    Unverified historical conversions need a source report
                    comparison before they can be considered complete.
                  </span>
                </span>
              }
            />
          </div>
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
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-error">
          <AlertCircle size={16} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

type ComparisonDraft = Omit<ImportComparisonFilter, "offset">;
const changeKinds = [
  "changed",
  "new",
  "missing",
  "source_only",
  "unchanged",
] as const satisfies readonly ComparisonRow["change"][];
const changeOptions = [
  "differences",
  "all",
  ...changeKinds,
] as const satisfies readonly ComparisonDraft["change"][];
const changeVariant: Record<ComparisonRow["change"], BadgeVariant> = {
  changed: "warning",
  new: "info",
  missing: "danger",
  source_only: "copper",
  unchanged: "default",
};
/** The comparison read only accepts two files from the same source, kind and scope. */
const comparableBatches = (batches: ImportBatch[], later?: ImportBatch) =>
  later
    ? batches.filter(
        (b) =>
          b.id !== later.id &&
          b.source_system === later.source_system &&
          b.mode === later.mode &&
          b.source_scope === later.source_scope,
      )
    : [];
/** Batches list newest first, so prefer the nearest file staged before the later one. */
const defaultEarlier = (
  batches: ImportBatch[],
  later: ImportBatch | undefined,
  preferred: string,
) => {
  const options = comparableBatches(batches, later),
    position = later ? batches.indexOf(later) : -1;
  return (
    options.find((b) => b.id === preferred) ??
    options.find((b) => batches.indexOf(b) > position) ??
    options[0]
  );
};
const sharedDates = (a?: ImportBatch, b?: ImportBatch) => ({
  from:
    a && b
      ? a.from_date > b.from_date
        ? a.from_date
        : b.from_date
      : ((a ?? b)?.from_date ?? ""),
  to:
    a && b
      ? a.to_date < b.to_date
        ? a.to_date
        : b.to_date
      : ((a ?? b)?.to_date ?? ""),
});

function ImportComparisonPanel({
  batches,
  initialLater,
  onBack,
  onReview,
}: {
  batches: ImportBatch[];
  initialLater: string;
  onBack: () => void;
  onReview: (batchId: string, group: ImportGroup) => void;
}) {
  const [draft, setDraft] = useState<ComparisonDraft>(() => {
    const later = batches.find((b) => b.id === initialLater) ?? batches[0],
      earlier = defaultEarlier(batches, later, "");
    return {
      earlier: earlier?.id ?? "",
      later: later?.id ?? "",
      ...sharedDates(earlier, later),
      change: "differences",
    };
  });
  const [applied, setApplied] = useState<ImportComparisonFilter | null>(null),
    [data, setData] = useState<ImportComparison | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const signature = applied ? JSON.stringify(applied) : "";
  useEffect(() => {
    if (!signature) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    accountingGet<ImportComparison>(
      { view: "import-comparison", filter: signature },
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [signature]);
  const later = batches.find((b) => b.id === draft.later),
    earlierOptions = comparableBatches(batches, later),
    earlier = earlierOptions.find((b) => b.id === draft.earlier),
    bounds = sharedDates(earlier, later);
  const batchOption = (b: ImportBatch) => ({
    value: b.id,
    label: `${b.file_name} · ${batchPeriod(b)}`,
  });
  function chooseLater(id: string) {
    const next = batches.find((b) => b.id === id),
      pick = defaultEarlier(batches, next, draft.earlier);
    setDraft({
      ...draft,
      later: id,
      earlier: pick?.id ?? "",
      ...sharedDates(pick, next),
    });
  }
  function chooseEarlier(id: string) {
    setDraft({
      ...draft,
      earlier: id,
      ...sharedDates(
        batches.find((b) => b.id === id),
        later,
      ),
    });
  }
  function compare() {
    const parsed = importComparisonFilterSchema.safeParse({
      ...draft,
      offset: 0,
    });
    if (
      !parsed.success ||
      !earlier ||
      draft.from < bounds.from ||
      draft.to > bounds.to
    ) {
      setError(
        "Choose two files from the same source and dates inside their shared period.",
      );
      return;
    }
    setError("");
    setApplied(parsed.data);
  }
  const side = (group: ComparisonGroup | null) =>
    group ? (
      <div className="min-w-0">
        <p className="text-sm">
          {dateLabel(group.entry_date)} ·{" "}
          <MaskedValue
            value={groupAmount(group)}
            className="font-mono tabular-nums"
          />
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {group.memo}
        </p>
      </div>
    ) : (
      <span className="text-xs text-muted-foreground">Not in this file</span>
    );
  const change = (row: ComparisonRow) => (
    <Badge variant={changeVariant[row.change]}>
      {comparisonLabels[row.change]}
    </Badge>
  );
  const reviewButton = (row: ComparisonRow) => {
    const group = row.later;
    return group && data ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => onReview(data.later.id, group)}
      >
        Review
      </Button>
    ) : null;
  };
  const columns: DataTableColumn<ComparisonRow>[] = [
    {
      key: "id",
      header: "Source ID",
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-xs">{row.external_id}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {enumLabel(row.identity_kind)}
          </p>
        </div>
      ),
    },
    { key: "change", header: "Change", render: change },
    {
      key: "earlier",
      header: "Earlier file",
      render: (row) => side(row.earlier),
    },
    { key: "later", header: "Later file", render: (row) => side(row.later) },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: reviewButton,
    },
  ];
  return (
    <div className="space-y-5">
      <div>
        <Button
          variant="link"
          size="sm"
          onClick={onBack}
          className="mb-3 h-auto px-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" />
          Import history
        </Button>
        <h2 className="text-lg font-semibold">Compare exports</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A read-only comparison of two staged files from the same source across
          their shared dates.
        </p>
      </div>
      <form
        className="glass-card grid items-end gap-3 rounded-xl p-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_150px_150px_180px_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          compare();
        }}
      >
        <CustomSelect
          id="comparison-later"
          label="Later file"
          value={draft.later}
          onChange={chooseLater}
          options={batches.map(batchOption)}
        />
        <CustomSelect
          id="comparison-earlier"
          label="Earlier file"
          value={draft.earlier}
          onChange={chooseEarlier}
          options={earlierOptions.map(batchOption)}
          placeholder="No comparable file"
          disabled={!earlierOptions.length}
        />
        <Input
          label="From"
          type="date"
          required
          min={bounds.from}
          max={bounds.to}
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <Input
          label="Through"
          type="date"
          required
          min={bounds.from}
          max={bounds.to}
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
        <CustomSelect
          id="comparison-change"
          label="Show"
          value={draft.change}
          onChange={(v) => {
            const kind = changeOptions.find((k) => k === v);
            if (kind) setDraft({ ...draft, change: kind });
          }}
          options={[
            { value: "differences", label: "Differences" },
            { value: "all", label: "All rows" },
            ...changeKinds.map((value) => ({
              value,
              label: comparisonLabels[value],
            })),
          ]}
        />
        <Button type="submit" disabled={loading || !earlierOptions.length}>
          Compare
        </Button>
      </form>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/10 p-4 text-sm text-error"
        >
          {error}
        </p>
      )}
      {loading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Comparing files...
        </p>
      )}
      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            {countLabel(data.total, "row")} between {dateLabel(data.from)} and{" "}
            {dateLabel(data.to)}
            {changeKinds
              .filter((kind) => data.counts[kind])
              .map(
                (kind) => ` · ${comparisonLabels[kind]} ${data.counts[kind]}`,
              )
              .join("")}
          </p>
          {(data.mapping_changed ||
            data.basis_changed ||
            data.uncertain_identity_count > 0) && (
            <div className="rounded-lg border border-copper/30 bg-copper/5 px-4 py-3 text-xs leading-relaxed">
              {data.mapping_changed
                ? "The two files were staged with different column mappings. "
                : ""}
              {data.basis_changed
                ? "The two files were staged on different accounting bases. "
                : ""}
              {data.uncertain_identity_count > 0
                ? `${countLabel(data.uncertain_identity_count, "row")} matched by fingerprint only and may pair differently.`
                : ""}
            </div>
          )}
          <DataTable
            columns={columns}
            data={data.rows}
            keyExtractor={(row) =>
              `${row.key}-${row.earlier?.id ?? ""}-${row.later?.id ?? ""}`
            }
            busy={loading}
            emptyState="No rows in this scope."
            mobileCard={(row) => (
              <div className="glass-card space-y-3 rounded-xl p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-mono text-xs">
                    {row.external_id}
                  </p>
                  {change(row)}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Earlier file
                    </p>
                    {side(row.earlier)}
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Later file
                    </p>
                    {side(row.later)}
                  </div>
                </div>
                {reviewButton(row)}
              </div>
            )}
            after={
              <Pagination
                offset={data.offset}
                limit={50}
                total={data.filtered_total}
                onChange={(next) =>
                  applied && setApplied({ ...applied, offset: next })
                }
                noun="rows"
                busy={loading}
              />
            }
          />
        </>
      )}
    </div>
  );
}
