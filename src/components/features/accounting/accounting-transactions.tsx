"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Check,
  CheckCheck,
  Copy,
  FileText,
  Filter,
  Pencil,
  Search,
  SlidersHorizontal,
  Split,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { MaskedValue } from "@/components/ui/masked-value";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import {
  RowActionsMenu,
  type RowAction,
} from "@/components/ui/row-actions-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import type {
  AccountingWorkspace,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type {
  RegisterFilter,
  WorkflowCommand,
} from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import {
  defaultEntryContext,
  presentTransaction,
} from "@/lib/accounting/transactions";
import { InstitutionLogo } from "@/components/ui/institution-logo";
import { Toggle } from "@/components/ui/inputs/Toggle";
import { AccountingPicker } from "./accounting-picker";
import { AccountingTransferFromDraft } from "./accounting-transfer-from-draft";
import {
  accountingGet,
  commandContext,
  useAccountingCommand,
} from "./use-accounting-command";
import { absMoney, dateLabel, money, signedMoney } from "./format";

type Result = {
  entries: JournalEntry[];
  total: number;
  offset: number;
  limit: number;
  revision: string;
};

/** An entry as the list shows it: the bank's own wording and prior treatment ride along. */
type TransactionRow = JournalEntry;

export type TransactionAction =
  | "edit"
  | "journal"
  | "copy"
  | "reverse"
  | "discard"
  | "detail";

const PAGE = 50;

export function AccountingTransactions({
  data,
  manage,
  demo,
  metadataLoading = false,
  initialFilter = {},
  onAction,
  onRefresh,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  metadataLoading?: boolean;
  initialFilter?: Partial<RegisterFilter>;
  onAction: (action: TransactionAction, entry: JournalEntry) => void;
  onRefresh: () => Promise<void>;
}) {
  // The inbox count: drafts plus anything else the books flag for review.
  const reviewCount = data.needs_review_count ?? data.draft_count;
  // Land on what needs attention. Fall back to everything when the inbox is empty.
  const inboxStatus: RegisterFilter["status"] =
    reviewCount > 0 ? "draft" : "all";
  const defaultStatus: RegisterFilter["status"] =
    initialFilter.status ?? inboxStatus;
  const [query, setQuery] = useState(initialFilter.query ?? "");
  const [search, setSearch] = useState(initialFilter.query ?? "");
  const [account, setAccount] = useState(initialFilter.account ?? "");
  const [status, setStatus] = useState<RegisterFilter["status"]>(defaultStatus);
  const [sort, setSort] = useState<NonNullable<RegisterFilter["sort"]>>(
    initialFilter.sort ?? "date_desc",
  );
  const [source, setSource] = useState(initialFilter.source ?? "");
  const [payee, setPayee] = useState(initialFilter.payee ?? "");
  const [from, setFrom] = useState(initialFilter.from ?? "");
  const [to, setTo] = useState(initialFilter.to ?? "");
  const [minimum, setMinimum] = useState(
    initialFilter.min_cents ? centsToDecimal(initialFilter.min_cents) : "",
  );
  const [maximum, setMaximum] = useState(
    initialFilter.max_cents ? centsToDecimal(initialFilter.max_cents) : "",
  );
  const [missing, setMissing] = useState(
    initialFilter.missing_receipt ?? false,
  );
  const [filters, setFilters] = useState(false);
  const [offset, setOffset] = useState(initialFilter.offset ?? 0);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Selected draft ids with the version seen at selection time, so a stale row never posts.
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [bulk, setBulk] = useState<{
    id: string;
    entries: JournalEntry[];
  } | null>(null);
  const [bulkCategory, setBulkCategory] = useState<{
    entries: JournalEntry[];
    account: string;
    review: boolean;
  } | null>(null);
  const [transfer, setTransfer] = useState<{
    entry: JournalEntry;
    counterpart: JournalEntry | null;
  } | null>(null);
  // Picking a category can also mark the draft reviewed, the routine case
  // for bank activity. Remembered per browser.
  const [reviewOnCategorize, setReviewOnCategorize] = useState(false);
  useEffect(() => {
    try {
      setReviewOnCategorize(
        localStorage.getItem("accounting.review-on-categorize") === "1",
      );
    } catch {
      /* Private mode keeps the default. */
    }
  }, []);
  function rememberReviewChoice(next: boolean) {
    setReviewOnCategorize(next);
    try {
      localStorage.setItem("accounting.review-on-categorize", next ? "1" : "0");
    } catch {
      /* Private mode keeps the choice for this page only. */
    }
  }
  const cmd = useAccountingCommand(onRefresh);

  const profiles = manage.profiles;
  const accounts = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a])),
    [data.accounts],
  );
  const parties = useMemo(
    () => new Map(manage.parties.map((p) => [p.id, p])),
    [manage.parties],
  );

  let invalid = "";
  let minCents: string | undefined;
  let maxCents: string | undefined;
  try {
    if (minimum) minCents = parseUsd(minimum).toString();
    if (maximum) maxCents = parseUsd(maximum).toString();
    if (
      (minCents && BigInt(minCents) < BigInt(0)) ||
      (maxCents && BigInt(maxCents) < BigInt(0)) ||
      (minCents && maxCents && BigInt(minCents) > BigInt(maxCents))
    )
      invalid = "Choose a valid positive amount range.";
  } catch {
    invalid = "Enter amounts in dollars and cents.";
  }
  if (from && to && from > to)
    invalid = "The end date must follow the start date.";

  const filter: Partial<RegisterFilter> = {
    from: from || undefined,
    to: to || undefined,
    account: account || undefined,
    status,
    query: search || undefined,
    source: (source || undefined) as RegisterFilter["source"],
    payee: payee || undefined,
    missing_receipt: missing,
    min_cents: minCents,
    max_cents: maxCents,
    sort,
    offset,
    limit: PAGE,
  };
  const signature = JSON.stringify(filter);

  useEffect(() => {
    if (query === search) return;
    const t = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [query, search]);

  // The URL carries the filter only when it differs from the inbox default,
  // so a plain visit stays a plain address and a filtered one can be shared.
  const isDefaultFilter =
    status === inboxStatus &&
    !search &&
    !account &&
    !source &&
    !payee &&
    !from &&
    !to &&
    !minCents &&
    !maxCents &&
    !missing &&
    sort === "date_desc" &&
    offset === 0;
  useEffect(() => {
    setSelection({});
    if (invalid || demo) return;
    const url = new URL(window.location.href);
    if (isDefaultFilter) {
      if (!url.searchParams.has("transactions")) return;
      url.searchParams.delete("transactions");
    } else {
      url.searchParams.set("transactions", signature);
    }
    window.history.replaceState(null, "", url);
  }, [signature, invalid, demo, isDefaultFilter]);

  useEffect(() => {
    if (invalid) {
      setResult(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const f: Partial<RegisterFilter> = JSON.parse(signature);
    if (demo) {
      const { status, account, query: search, offset = 0 } = f;
      const list = data.entries.filter(
        (e) =>
          (status === "all" ? e.status !== "discarded" : e.status === status) &&
          (!account || e.lines.some((l) => l.account_id === account)) &&
          (!search || e.memo.toLowerCase().includes(search.toLowerCase())),
      );
      setResult({
        entries: list.slice(offset, offset + PAGE),
        total: list.length,
        offset,
        limit: PAGE,
        revision: "demo",
      });
      setLoading(false);
      return;
    }
    accountingGet<Result>(
      { view: "register", filter: signature },
      controller.signal,
    )
      .then(setResult)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [signature, data.revision, data.entries, demo, invalid]);

  const bankProfiles = profiles.filter((p) => p.cash_kind !== "none");
  const bankIds = new Set(bankProfiles.map((p) => p.account_id));
  const cashBalance = data.balances
    .filter((a) =>
      bankProfiles.some((p) => p.account_id === a.id && p.cash_kind !== "card"),
    )
    .reduce((s, a) => s + BigInt(a.ending_cents), BigInt(0));
  const cardBalance = -data.balances
    .filter((a) =>
      bankProfiles.some((p) => p.account_id === a.id && p.cash_kind === "card"),
    )
    .reduce((s, a) => s + BigInt(a.ending_cents), BigInt(0));
  const selectedBalance = data.balances.find((a) => a.id === account);
  const selectedProfile = profiles.find((p) => p.account_id === account);
  const displayedBalance = selectedBalance
    ? BigInt(selectedBalance.ending_cents) *
      (selectedProfile?.cash_kind === "card" ? BigInt(-1) : BigInt(1))
    : cashBalance;

  const categoryOptions = useMemo(
    () =>
      data.accounts
        .filter((a) => !a.is_archived && !bankIds.has(a.id))
        .map((a) => ({
          value: a.id,
          label: a.name,
          keywords: a.code,
          group: a.account_type[0].toUpperCase() + a.account_type.slice(1),
        }))
        .sort(
          (a, b) =>
            a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
        ),
    // bankIds derives from profiles, which change with data.accounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.accounts, profiles],
  );

  const rows = (result?.entries ?? []) as TransactionRow[];
  const visibleDrafts = rows.filter((e) => e.status === "draft");
  const chosen = visibleDrafts.filter((e) => selection[e.id] === e.version);
  const chosenSet = new Set(chosen.map((e) => e.id));
  const busy = cmd.busy || loading;

  function changed(fn: () => void) {
    fn();
    setOffset(0);
  }

  /** Back to the inbox view: every filter cleared, first page. */
  function resetFilters() {
    setQuery("");
    setSearch("");
    setAccount("");
    setStatus(inboxStatus);
    setSort("date_desc");
    setSource("");
    setPayee("");
    setFrom("");
    setTo("");
    setMinimum("");
    setMaximum("");
    setMissing(false);
    setOffset(0);
  }

  async function review(entry: JournalEntry) {
    if (
      await cmd.execute({
        type: "entry.post",
        id: entry.id,
        expected_version: entry.version,
      })
    )
      toast("success", "Reviewed and included in your books.");
  }

  function saveCommand(
    entry: JournalEntry,
    accountId: string,
    payeeId?: string | null,
    review = false,
  ): WorkflowCommand | null {
    const p = presentTransaction(entry, profiles);
    if (!p.editable || p.categoryLines.length !== 1) return null;
    const context = commandContext(entry.context ?? defaultEntryContext);
    return {
      type: review ? "transaction.review" : "transaction.save",
      id: entry.id,
      expected_version: entry.version,
      entry_date: entry.entry_date,
      memo: entry.memo,
      context: payeeId ? { ...context, payee_id: payeeId } : context,
      lines: entry.lines.map((l) => ({
        account_id: l.id === p.categoryLines[0].id ? accountId : l.account_id,
        amount_cents: l.amount_cents,
        memo: l.memo,
      })),
    };
  }

  async function categorize(
    entry: JournalEntry,
    accountId: string,
    payeeId?: string | null,
  ) {
    const command = saveCommand(
      entry,
      accountId,
      payeeId,
      reviewOnCategorize && entry.status === "draft",
    );
    if (!command) return;
    if (await cmd.execute(command))
      toast(
        "success",
        reviewOnCategorize && entry.status === "draft"
          ? "Categorized and reviewed."
          : "Category saved. Review it when you are ready.",
      );
  }

  /** The bank's own wording for this movement, or the memo until the data layer reports it. */
  function descriptorOf(entry: TransactionRow) {
    return (entry.source_description ?? entry.memo).trim().slice(0, 250);
  }

  async function rememberPayee(entry: TransactionRow) {
    const description = descriptorOf(entry);
    if (!description || !entry.context?.payee_id) return;
    const command: WorkflowCommand = {
      type: "alias.save",
      id: crypto.randomUUID(),
      expected_version: 0,
      party_id: entry.context.payee_id,
      match_mode: "exact",
      description,
      enabled: true,
    };
    if (await cmd.execute(command))
      toast(
        "success",
        "Future transactions with this descriptor get this payee.",
      );
  }

  async function applyBulkCategory() {
    if (!bulkCategory?.account) return;
    const commands = bulkCategory.entries
      .map((e) =>
        saveCommand(e, bulkCategory.account, undefined, bulkCategory.review),
      )
      .filter((c): c is WorkflowCommand => c !== null);
    const { done, failed, saved } = await cmd.executeMany(commands);
    if (done > 0 && !failed) {
      setBulkCategory(null);
      // Reviewed rows leave the queue; categorized ones stay selected so
      // Review selected is one more click, not a fresh selection.
      if (bulkCategory.review) setSelection({});
      toast(
        "success",
        `${done} ${done === 1 ? "transaction" : "transactions"} ${bulkCategory.review ? "categorized and reviewed" : "categorized"}.`,
      );
    } else if (done > 0) {
      // Keep only the rows that did not land so a retry does not resend saved ones.
      const landed = new Set(saved);
      setBulkCategory((b) =>
        b ? { ...b, entries: b.entries.filter((e) => !landed.has(e.id)) } : b,
      );
      setSelection((s) => {
        const next = { ...s };
        for (const id of landed) delete next[id];
        return next;
      });
    }
  }

  const activeFilters = [
    from,
    to,
    source,
    payee,
    minimum,
    maximum,
    missing,
  ].filter(Boolean).length;

  const originLabel = (entry: JournalEntry) =>
    entry.primary_origin === "simplefin"
      ? "Bank feed"
      : entry.primary_origin === "wave"
        ? "Imported from Wave"
        : entry.primary_origin === "csv"
          ? "Imported file"
          : entry.primary_origin === "manual"
            ? "Manual transaction"
            : entry.primary_origin;

  function rowActions(entry: JournalEntry): RowAction[] {
    const row = entry as TransactionRow;
    const readOnly = (action: TransactionAction) =>
      demo && action !== "detail" && action !== "journal";
    const actions: RowAction[] = [
      {
        label:
          entry.status === "posted"
            ? "Edit with correction"
            : "Edit transaction",
        icon: <Pencil />,
        onSelect: () => onAction("edit", entry),
        disabled: readOnly("edit"),
      },
      {
        label: "Details & receipts",
        icon: <FileText />,
        onSelect: () => onAction("detail", entry),
      },
      {
        label: "View journal",
        icon: <SlidersHorizontal />,
        onSelect: () => onAction("journal", entry),
      },
      {
        label: "Duplicate as draft",
        icon: <Copy />,
        onSelect: () => onAction("copy", entry),
        disabled: readOnly("copy"),
      },
    ];
    if (row.context?.payee_id && descriptorOf(row) && !demo)
      actions.push({
        label: "Remember payee for this description",
        icon: <Tag />,
        onSelect: () => void rememberPayee(row),
      });
    if (entry.status === "draft") {
      const p = presentTransaction(entry, profiles);
      if (p.bankLine && p.editable && !demo)
        actions.push({
          label: "Record as transfer",
          icon: <ArrowLeftRight />,
          onSelect: () =>
            setTransfer({ entry, counterpart: transferCounterpart(row) }),
        });
    }
    if (entry.status === "draft")
      actions.push({
        label: "Discard draft",
        icon: <Trash2 />,
        variant: "danger",
        separator: true,
        onSelect: () => onAction("discard", entry),
        disabled: readOnly("discard"),
      });
    else if (!entry.reversed_by_entry_id && !entry.reverses_entry_id)
      actions.push({
        label: "Reverse transaction",
        icon: <Undo2 />,
        variant: "danger",
        separator: true,
        onSelect: () => onAction("reverse", entry),
        disabled: readOnly("reverse"),
      });
    return actions;
  }

  const transferWindow = manage.preferences?.transfer_window_days ?? 5;
  /** Another uncategorized draft on a different own account, same amount the other way, within the window. */
  function transferCounterpart(entry: TransactionRow): JournalEntry | null {
    const p = presentTransaction(entry, profiles);
    if (!p.bankLine || !p.editable || p.categorized || !result) return null;
    const amount = BigInt(p.bankLine.amount_cents);
    return (
      result.entries.find((other) => {
        if (other.id === entry.id || other.status !== "draft") return false;
        const q = presentTransaction(other, profiles);
        if (!q.bankLine || !q.editable || q.categorized) return false;
        if (q.bankLine.account_id === p.bankLine!.account_id) return false;
        if (BigInt(q.bankLine.amount_cents) !== -amount) return false;
        const days =
          Math.abs(
            Date.parse(other.entry_date) - Date.parse(entry.entry_date),
          ) / 86400000;
        return days <= transferWindow;
      }) ?? null
    );
  }

  function transferHint(
    row: TransactionRow,
    p: ReturnType<typeof presentTransaction>,
  ) {
    if (row.status !== "draft" || !p.editable || p.categorized || !p.bankLine)
      return null;
    const other = transferCounterpart(row);
    if (!other) return null;
    const otherAccount = accounts.get(
      presentTransaction(other, profiles).bankLine!.account_id,
    )?.name;
    return (
      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ArrowLeftRight
          size={11}
          aria-hidden="true"
          className="text-teal-light"
        />
        <span className="truncate">
          Matches the opposite movement on {otherAccount}
        </span>
        <button
          type="button"
          disabled={busy || demo}
          onClick={() => setTransfer({ entry: row, counterpart: other })}
          className="rounded px-1 font-medium text-teal-light hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Record transfer
        </button>
      </span>
    );
  }

  function priorHint(
    row: TransactionRow,
    p: ReturnType<typeof presentTransaction>,
  ) {
    const prior = row.prior_treatment;
    if (!prior || row.status !== "draft" || p.categorized || !p.editable)
      return null;
    const category = prior.last_category;
    const name = category ? accounts.get(category)?.name : undefined;
    if (!category || !name) return null;
    return (
      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Sparkles size={11} aria-hidden="true" className="text-copper" />
        <span className="truncate">
          Previously {name}
          {prior.count > 1 ? `, ${prior.count} times` : ""}
        </span>
        <button
          type="button"
          disabled={busy || demo}
          onClick={() => void categorize(row, category, prior.payee_id)}
          className="rounded px-1 font-medium text-teal-light hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Use
        </button>
      </span>
    );
  }

  function reviewButton(
    entry: JournalEntry,
    p: ReturnType<typeof presentTransaction>,
  ) {
    const posted = entry.status === "posted";
    const hint = posted
      ? "Reviewed"
      : p.categorized
        ? "Mark as reviewed"
        : "Choose a category first";
    return (
      <Tooltip content={hint}>
        <button
          type="button"
          disabled={demo || busy || !p.categorized || posted}
          onClick={() => void review(entry)}
          aria-label={
            posted
              ? `${entry.memo}: reviewed`
              : `Mark ${entry.memo} as reviewed`
          }
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-default",
            posted
              ? "border-primary/20 bg-primary/15 text-teal-light"
              : "border-border text-muted-foreground enabled:hover:border-primary enabled:hover:bg-primary/10 enabled:hover:text-teal-light",
            !p.categorized && !posted && "opacity-40",
          )}
        >
          <Check size={15} aria-hidden="true" />
        </button>
      </Tooltip>
    );
  }

  function categoryCell(
    entry: JournalEntry,
    p: ReturnType<typeof presentTransaction>,
  ) {
    const categories = p.categoryLines.map(
      (l) => accounts.get(l.account_id)?.name ?? "Unknown account",
    );
    const label = p.transfer
      ? "Transfer"
      : p.categoryLines.length > 1
        ? "Split transaction"
        : (categories[0] ?? "Journal entry");
    if (
      entry.status === "draft" &&
      p.editable &&
      p.categoryLines.length === 1 &&
      !demo
    )
      return (
        <AccountingPicker
          label={`Category for ${entry.memo}`}
          compact
          disabled={busy}
          value={p.categoryLines[0].account_id}
          options={categoryOptions}
          onChange={(id) => void categorize(entry, id)}
          className={cn("w-full", !p.categorized && "text-warning")}
        />
      );
    return (
      <button
        type="button"
        onClick={() => onAction("edit", entry)}
        className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {p.categoryLines.length > 1 && <Split size={12} aria-hidden="true" />}
        <span className="truncate">{label}</span>
      </button>
    );
  }

  const columns: DataTableColumn<TransactionRow>[] = [
    {
      key: "date",
      header: "Date",
      width: "w-[6.75rem]",
      className: "whitespace-nowrap",
      render: (e) => (
        <span className="text-xs text-muted-foreground">
          {dateLabel(e.entry_date)}
        </span>
      ),
    },
    {
      key: "description",
      header: "Description",
      render: (e) => {
        const p = presentTransaction(e, profiles, account);
        const party = parties.get(e.context?.payee_id ?? "");
        return (
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => onAction("edit", e)}
              className="block w-full truncate text-left font-medium transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:underline"
            >
              {e.memo}
            </button>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {party?.name ?? originLabel(e)}
              {e.reversed_by_entry_id ? ", corrected or reversed" : ""}
              {e.reverses_entry_id ? ", reversal" : ""}
            </p>
            {priorHint(e, p)}
            {transferHint(e, p)}
          </div>
        );
      },
    },
    {
      key: "account",
      header: "Account",
      className: "hidden w-[15%] xl:table-cell",
      render: (e) => {
        const p = presentTransaction(e, profiles, account);
        const first = p.accountIds[0]
          ? accounts.get(p.accountIds[0])
          : undefined;
        return (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {first && <InstitutionLogo name={first.name} size={22} />}
            <span className="truncate">
              {p.accountIds
                .map((id) => accounts.get(id)?.name ?? "Unknown account")
                .join(" / ") || "Multiple accounts"}
            </span>
          </span>
        );
      },
    },
    {
      key: "category",
      header: "Category",
      className: "w-[18%]",
      render: (e) => categoryCell(e, presentTransaction(e, profiles, account)),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      width: "w-28",
      render: (e) => {
        const p = presentTransaction(e, profiles, account);
        const inflow = p.movement && p.amount > BigInt(0);
        return (
          <span
            className={cn(
              "font-medium",
              inflow ? "text-success" : "text-foreground",
            )}
          >
            <MaskedValue
              value={p.movement ? signedMoney(p.amount) : money(p.amount)}
            />
            {!p.movement && (
              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                {p.transfer ? "Transfer" : "Journal"}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "w-24",
      render: (e) => (
        <div className="flex items-center justify-end gap-1">
          {reviewButton(e, presentTransaction(e, profiles, account))}
          <RowActionsMenu
            label={`Actions for ${e.memo}`}
            actions={rowActions(e)}
          />
        </div>
      ),
    },
  ];

  const mobileCard = (e: TransactionRow) => {
    const p = presentTransaction(e, profiles, account);
    const party = parties.get(e.context?.payee_id ?? "");
    const selectable = e.status === "draft" && !demo;
    return (
      <article className="glass-card space-y-3 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {selectable && (
              <Checkbox
                size="sm"
                checked={chosenSet.has(e.id)}
                ariaLabel={`Select ${e.memo}`}
                disabled={busy}
                onChange={() => toggleOne(e)}
                className="mt-0.5"
              />
            )}
            {p.accountIds[0] && (
              <InstitutionLogo
                name={accounts.get(p.accountIds[0])?.name}
                size={32}
                className="mt-0.5"
              />
            )}
            <div className="min-w-0">
              <button
                type="button"
                className="block max-w-full truncate text-left text-sm font-medium focus-visible:outline-none focus-visible:underline"
                onClick={() => onAction("edit", e)}
              >
                {e.memo}
              </button>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {dateLabel(e.entry_date)}
                {" · "}
                {party?.name ?? originLabel(e)}
              </p>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 text-sm font-medium tabular-nums",
              p.movement && p.amount > BigInt(0) && "text-success",
            )}
          >
            <MaskedValue
              value={p.movement ? signedMoney(p.amount) : money(p.amount)}
            />
          </span>
        </div>
        {priorHint(e, p)}
        {transferHint(e, p)}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">{categoryCell(e, p)}</div>
          <div className="flex shrink-0 items-center gap-1">
            {reviewButton(e, p)}
            <RowActionsMenu
              label={`Actions for ${e.memo}`}
              actions={rowActions(e)}
            />
          </div>
        </div>
      </article>
    );
  };

  function toggleOne(entry: JournalEntry) {
    setSelection((prev) => {
      const next = { ...prev };
      if (next[entry.id] === entry.version) delete next[entry.id];
      else next[entry.id] = entry.version;
      return next;
    });
  }

  const emptyState = loading ? (
    <span>Loading transactions...</span>
  ) : (
    <div className="space-y-1.5">
      <p className="font-medium text-foreground">
        {status === "draft" && !activeFilters && !query
          ? "Nothing needs review"
          : "No transactions in this view"}
      </p>
      <p>
        {activeFilters || query
          ? "Try adjusting your filters."
          : status === "draft"
            ? "New bank activity lands here for a quick category check."
            : "Add a transaction or connect your accounts to start your books."}
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-xl">
          <AccountingPicker
            label="Accounts"
            value={account}
            options={[
              {
                value: "",
                label: "All accounts",
                detail: (
                  <span>
                    Book cash <MaskedValue value={money(cashBalance)} />
                  </span>
                ),
              },
              ...data.accounts
                .filter((a) => bankIds.has(a.id) || a.id === account)
                .map((a) => {
                  const p = profiles.find((p) => p.account_id === a.id);
                  const b = data.balances.find((b) => b.id === a.id);
                  return {
                    value: a.id,
                    label: a.name,
                    icon: <InstitutionLogo name={a.name} size={20} />,
                    group:
                      p?.cash_kind === "card"
                        ? "Credit cards"
                        : bankIds.has(a.id)
                          ? "Cash & bank"
                          : "Other accounts",
                    detail: (
                      <span className="flex items-center justify-between">
                        <span>
                          {a.is_archived
                            ? "Archived account"
                            : p?.cash_kind === "card"
                              ? "Book card balance"
                              : "Posted book balance"}
                        </span>
                        <MaskedValue
                          value={money(
                            BigInt(b?.ending_cents ?? "0") *
                              (p?.cash_kind === "card"
                                ? BigInt(-1)
                                : BigInt(1)),
                          )}
                        />
                      </span>
                    ),
                  };
                }),
            ]}
            onChange={(v) => changed(() => setAccount(v))}
            className="w-full"
            triggerClassName="glass-card min-h-[60px] rounded-xl px-4 hover:border-[rgba(var(--ink),0.18)]"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {account ? (
                <InstitutionLogo name={accounts.get(account)?.name} size={36} />
              ) : (
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-teal-light">
                  <Wallet size={17} aria-hidden="true" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {accounts.get(account)?.name ?? "All accounts"}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {account ? "Posted balance" : "Cash & bank"} through{" "}
                  {dateLabel(data.to)}
                </p>
              </div>
              <span className="shrink-0 text-lg font-semibold tabular-nums">
                {metadataLoading ? (
                  <span className="text-xs text-muted-foreground">
                    Loading balance...
                  </span>
                ) : (
                  <MaskedValue value={money(displayedBalance)} />
                )}
              </span>
            </div>
          </AccountingPicker>
        </div>
        <div className="flex items-center gap-5 text-xs text-muted-foreground">
          <span>
            Card debt{" "}
            <span className="ml-1.5 font-medium tabular-nums text-foreground">
              <MaskedValue value={money(cardBalance)} />
            </span>
          </span>
          <span className="hidden lg:inline">
            Balances count reviewed transactions only
          </span>
        </div>
      </div>

      <section
        className="glass-card overflow-hidden rounded-xl"
        aria-label="Transactions"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="tablist"
              aria-label="Transaction status"
              className="flex items-center gap-1 rounded-lg bg-[rgba(var(--ink),0.05)] p-1 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]"
            >
              {(
                [
                  ["draft", "Needs review", reviewCount],
                  ["all", "All", null],
                  ["posted", "Reviewed", null],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={status === value}
                  onClick={() => changed(() => setStatus(value))}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    status === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {label}
                  {typeof count === "number" && count > 0 && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-[11px] font-semibold tabular-nums leading-4",
                        status === value
                          ? "bg-primary-foreground/20 text-primary-foreground"
                          : "bg-copper/20 text-copper",
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {status === "draft" && !demo && (
              <Toggle
                size="sm"
                checked={reviewOnCategorize}
                onChange={rememberReviewChoice}
                label="Review as I categorize"
              />
            )}
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <TextInput
              aria-label="Search transactions"
              placeholder="Search transactions"
              prefix={<Search size={15} aria-hidden="true" />}
              value={query}
              maxLength={200}
              onChange={(nextValue) => setQuery(nextValue)}
            />
            <Button
              size="sm"
              variant={filters ? "secondary" : "ghost"}
              onClick={() => setFilters(!filters)}
              aria-expanded={filters}
            >
              <Filter size={14} aria-hidden="true" />
              Filters
              {activeFilters > 0 && (
                <Badge variant="info" size="sm">
                  {activeFilters}
                </Badge>
              )}
            </Button>
            <Tooltip content="Sort">
              <div className="w-9">
                <AccountingPicker
                  label="Sort transactions"
                  showChevron={false}
                  value={sort}
                  onChange={(v) => changed(() => setSort(v as typeof sort))}
                  compact
                  options={[
                    { value: "date_desc", label: "Newest first" },
                    { value: "date_asc", label: "Oldest first" },
                    { value: "amount_desc", label: "Largest amount first" },
                    { value: "amount_asc", label: "Smallest amount first" },
                    { value: "description", label: "Description A to Z" },
                  ]}
                >
                  <ArrowUpDown size={15} aria-hidden="true" />
                </AccountingPicker>
              </div>
            </Tooltip>
          </div>
        </div>

        {filters && (
          <div className="grid gap-3 border-b border-border bg-[rgba(var(--ink),0.04)] p-4 sm:grid-cols-2 xl:grid-cols-4">
            <DateInput
              label="From date"
              value={from}
              onChange={(nextValue) => changed(() => setFrom(nextValue))}
            />
            <DateInput
              label="Through date"
              value={to}
              onChange={(nextValue) => changed(() => setTo(nextValue))}
            />
            <TextInput
              label="Minimum amount"
              inputMode="decimal"
              placeholder="0.00"
              value={minimum}
              onChange={(nextValue) => changed(() => setMinimum(nextValue))}
            />
            <TextInput
              label="Maximum amount"
              inputMode="decimal"
              placeholder="No maximum"
              value={maximum}
              onChange={(nextValue) => changed(() => setMaximum(nextValue))}
            />
            <AccountingPicker
              label="Source"
              visibleLabel="Source"
              value={source}
              options={[
                { value: "", label: "All sources" },
                { value: "simplefin", label: "Bank feed" },
                { value: "csv", label: "Imported file" },
                { value: "wave", label: "Wave" },
                { value: "manual", label: "Manual" },
                { value: "internal", label: "Internal" },
              ]}
              onChange={(v) => changed(() => setSource(v))}
            />
            <AccountingPicker
              label="Payee"
              visibleLabel="Payee"
              value={payee}
              options={[
                { value: "", label: "All payees" },
                ...manage.parties.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(v) => changed(() => setPayee(v))}
            />
            <Checkbox
              checked={missing}
              onChange={(v) => changed(() => setMissing(v))}
              label="Missing receipt or document"
              className="self-end pb-2"
            />
            <div className="flex gap-2 xl:justify-end">
              <Button size="sm" variant="ghost" onClick={resetFilters}>
                <X size={14} aria-hidden="true" />
                Reset filters
              </Button>
            </div>
          </div>
        )}

        {(invalid || error || cmd.error) && (
          <p
            role="alert"
            className="border-b border-border bg-error/5 px-4 py-3 text-sm text-error"
          >
            {invalid || error || cmd.error}
          </p>
        )}

        {chosen.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-primary/5 px-4 py-2">
            <span className="text-sm">
              {chosen.length} selected
              {cmd.progress
                ? ` · saving ${cmd.progress.done} of ${cmd.progress.total}`
                : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setBulkCategory({
                    entries: chosen.filter((e) => {
                      const p = presentTransaction(e, profiles);
                      return p.editable && p.categoryLines.length === 1;
                    }),
                    account: "",
                    review: reviewOnCategorize,
                  })
                }
              >
                <Tag size={14} aria-hidden="true" />
                Set category
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  setBulk({ id: crypto.randomUUID(), entries: chosen })
                }
              >
                <CheckCheck size={14} aria-hidden="true" />
                Review selected
              </Button>
            </div>
          </div>
        )}

        <DataTable<TransactionRow>
          framed={false}
          fixedLayout
          columns={columns}
          data={rows}
          keyExtractor={(e) => e.id}
          onRowClick={(e) => onAction("detail", e)}
          busy={loading && !!result}
          emptyState={emptyState}
          mobileCard={mobileCard}
          className="lg:[&_table]:min-w-[720px]"
          selection={
            demo
              ? undefined
              : {
                  selected: chosenSet,
                  isSelectable: (key) =>
                    visibleDrafts.some((e) => e.id === key),
                  onToggle: (key) => {
                    const entry = visibleDrafts.find((e) => e.id === key);
                    if (entry) toggleOne(entry);
                  },
                  onToggleAll: (keys) =>
                    setSelection(
                      keys.every((k) => chosenSet.has(k))
                        ? {}
                        : Object.fromEntries(
                            visibleDrafts
                              .filter((e) => keys.includes(e.id))
                              .map((e) => [e.id, e.version]),
                          ),
                    ),
                }
          }
          after={
            <Pagination
              offset={offset}
              limit={PAGE}
              total={result?.total ?? 0}
              onChange={setOffset}
              noun="transactions"
              busy={loading}
            />
          }
        />
      </section>

      <Dialog
        open={!!bulk}
        onOpenChange={(open) => {
          if (!open && !cmd.busy) setBulk(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review selected</DialogTitle>
            <DialogDescription className="sr-only">
              The selected transactions become reviewed and count in reports.
            </DialogDescription>
          </DialogHeader>
          {bulk && (
            <div className="mt-4 space-y-4">
              <p className="text-sm">
                {bulk.entries.length} transactions,{" "}
                {dateLabel(bulk.entries.map((e) => e.entry_date).sort()[0])} to{" "}
                {dateLabel(
                  bulk.entries
                    .map((e) => e.entry_date)
                    .sort()
                    .at(-1),
                )}
              </p>
              <div className="grid grid-cols-2 gap-3 glass-card rounded-xl p-3 text-sm">
                {(["in", "out"] as const).map((direction) => (
                  <div key={direction}>
                    <p className="text-xs text-muted-foreground">
                      Money {direction}
                    </p>
                    <MaskedValue
                      value={absMoney(
                        bulk.entries.reduce((sum, e) => {
                          const p = presentTransaction(e, profiles);
                          return p.movement &&
                            (direction === "in"
                              ? p.amount > BigInt(0)
                              : p.amount < BigInt(0))
                            ? sum +
                                (p.amount < BigInt(0) ? -p.amount : p.amount)
                            : sum;
                        }, BigInt(0)),
                      )}
                    />
                  </div>
                ))}
              </div>
              <div className="max-h-72 divide-y divide-border overflow-auto">
                {bulk.entries.map((e) => {
                  const p = presentTransaction(e, profiles);
                  return (
                    <div
                      key={e.id}
                      className="flex items-center justify-between gap-3 py-3 text-sm"
                    >
                      <span className="truncate">{e.memo}</span>
                      {p.categorized ? (
                        <MaskedValue value={money(p.amount)} />
                      ) : (
                        <span className="text-xs text-warning">
                          Needs a category or balanced lines
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {cmd.error && (
                <p role="alert" className="text-sm text-error">
                  {cmd.error}
                </p>
              )}
              <Button
                disabled={
                  cmd.busy ||
                  bulk.entries.some(
                    (e) => !presentTransaction(e, profiles).categorized,
                  )
                }
                onClick={async () => {
                  if (
                    await cmd.execute({
                      type: "entry.bulkpost",
                      id: bulk.id,
                      entries: bulk.entries.map((e) => ({
                        id: e.id,
                        expected_version: e.version,
                      })),
                    })
                  ) {
                    setBulk(null);
                    setSelection({});
                    toast("success", "Selected transactions reviewed.");
                  }
                }}
              >
                <CheckCheck size={15} aria-hidden="true" />
                Review {bulk.entries.length} transactions
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!bulkCategory}
        onOpenChange={(open) => {
          if (!open && !cmd.busy) setBulkCategory(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set category</DialogTitle>
            <DialogDescription className="sr-only">
              One category for every selected transaction.
            </DialogDescription>
          </DialogHeader>
          {bulkCategory && (
            <div className="mt-4 space-y-4">
              <AccountingPicker
                label="Category"
                visibleLabel="Category"
                value={bulkCategory.account}
                options={categoryOptions}
                placeholder="Choose a category"
                onChange={(v) =>
                  setBulkCategory({ ...bulkCategory, account: v })
                }
              />
              <div className="max-h-64 divide-y divide-border overflow-auto glass-card rounded-xl px-3">
                {bulkCategory.entries.map((e) => (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-3 py-2.5 text-sm"
                  >
                    <span className="truncate">{e.memo}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {dateLabel(e.entry_date)}
                    </span>
                  </div>
                ))}
                {bulkCategory.entries.length === 0 && (
                  <p className="py-4 text-sm text-muted-foreground">
                    None of the selected transactions can take a single
                    category. Splits and transfers are edited one at a time.
                  </p>
                )}
              </div>
              <Checkbox
                checked={bulkCategory.review}
                onChange={(v) =>
                  setBulkCategory({ ...bulkCategory, review: v })
                }
                label="Mark them reviewed too"
                description="Otherwise they stay selected for Review selected."
              />
              {chosen.length > bulkCategory.entries.length &&
                bulkCategory.entries.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {chosen.length - bulkCategory.entries.length} selected
                    transactions are splits or transfers and will be skipped.
                  </p>
                )}
              {cmd.error && (
                <p role="alert" className="text-sm text-error">
                  {cmd.error}
                </p>
              )}
              <Button
                disabled={
                  cmd.busy ||
                  !bulkCategory.account ||
                  bulkCategory.entries.length === 0
                }
                loading={cmd.busy}
                onClick={() => void applyBulkCategory()}
              >
                <Tag size={15} aria-hidden="true" />
                {bulkCategory.review
                  ? "Categorize and review"
                  : "Categorize"}{" "}
                {bulkCategory.entries.length} transactions
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {transfer && (
        <AccountingTransferFromDraft
          entry={transfer.entry}
          counterpart={transfer.counterpart}
          accounts={data.accounts}
          profiles={profiles}
          revision={data.revision}
          onClose={() => setTransfer(null)}
          onSaved={async () => {
            setTransfer(null);
            await onRefresh();
          }}
        />
      )}
    </div>
  );
}
