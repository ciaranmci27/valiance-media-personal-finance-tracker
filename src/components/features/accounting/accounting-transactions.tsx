"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpDown,
  Copy,
  Pencil,
  Plus,
  Search,
  Split,
  Sparkles,
  Trash2,
  Undo2,
  Wallet,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { ReviewCheck } from "./accounting-review-check";
import { Toggle } from "@/components/ui/inputs/Toggle";
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
  isTransactionReviewed,
  isTransactionReversed,
  canRestoreTransaction,
  presentTransaction,
  transactionRowAction,
} from "@/lib/accounting/transactions";
import {
  AccountingAccountLabel,
  AccountingAccountLogo,
  useAccountingBankIdentity,
} from "./accounting-bank-identity";
import { accountBalances } from "@/lib/accounting/account-balances";
import { entryMatchesSearch, parseSearchTerms } from "@/lib/accounting/search";
import {
  REGISTER_PAGE,
  buildRegisterFilter,
  journalInitialState,
  registerQuery,
} from "@/lib/accounting/preload";
import { useAccountingRead } from "./use-accounting-read";
import { useAccountingRowCommand } from "./use-accounting-row-command";
import { AccountingPicker } from "./accounting-picker";
import {
  AccountingCategoryPicker,
  type TransferMatch,
} from "./accounting-category-picker";
import {
  categoryGroups,
  categoryKind,
  categoryMenu,
  type CategoryKind,
} from "@/lib/accounting/categories";
import { AccountingTransferFromDraft } from "./accounting-transfer-from-draft";
import {
  commandContext,
  useAccountingCommand,
  type CommandContext,
} from "./use-accounting-command";
import { AccountingContextEditor } from "./accounting-context-editor";
import { FilterPopover } from "./accounting-filter-popover";
import { contactAffiliation } from "./accounting-party-form";
import { Select } from "@/components/ui/inputs/Select";
import { dateLabel, money, signedMoney } from "./format";

type Result = {
  entries: JournalEntry[];
  total: number;
  offset: number;
  limit: number;
  revision: string;
};

/** An entry as the list shows it: the bank's own wording and prior treatment ride along. */
type TransactionRow = JournalEntry;

/** One line of a bulk edit: which field changes, and to what. */
type BulkLine = {
  key: string;
  field: "category" | "payee" | "description" | "";
  account: string;
  context: CommandContext;
  memo: string;
};
const newBulkLine = (): BulkLine => ({
  key: crypto.randomUUID(),
  field: "",
  account: "",
  context: { kind: "manual", payee_id: null },
  memo: "",
});

export type TransactionAction =
  | "edit"
  | "journal"
  | "copy"
  | "restore"
  | "reverse"
  | "discard"
  | "detail";

const PAGE = REGISTER_PAGE;

export function AccountingTransactions({
  data,
  manage,
  demo,
  metadataLoading = false,
  initialFilter = {},
  onAction,
  onRefresh,
  onTransactionSaved = onRefresh,
  actions,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
  demo: boolean;
  metadataLoading?: boolean;
  initialFilter?: Partial<RegisterFilter>;
  onAction: (action: TransactionAction, entry: JournalEntry) => void;
  onRefresh: () => Promise<void>;
  onTransactionSaved?: () => Promise<void>;
  actions?: ReactNode;
}) {
  // The inbox count: drafts plus anything else the books flag for review.
  const reviewCount = data.needs_review_count ?? data.draft_count;
  // Land on what needs attention. Fall back to everything when the inbox is empty.
  const inboxStatus: RegisterFilter["status"] =
    reviewCount > 0 ? "draft" : "all";
  // The same starting point the shell warms, so the first page is already here.
  const [initialState] = useState(() =>
    journalInitialState(initialFilter, reviewCount),
  );
  const [query, setQuery] = useState(initialState.search);
  const [search, setSearch] = useState(initialState.search);
  const [account, setAccount] = useState(initialState.account);
  const [status, setStatus] = useState<RegisterFilter["status"]>(
    initialState.status,
  );
  const [sort, setSort] = useState<NonNullable<RegisterFilter["sort"]>>(
    initialState.sort,
  );
  const [source, setSource] = useState(initialState.source);
  const [payee, setPayee] = useState(initialState.payee);
  const [from, setFrom] = useState(initialState.from);
  const [to, setTo] = useState(initialState.to);
  const [minimum, setMinimum] = useState(
    initialState.minCents ? centsToDecimal(initialState.minCents) : "",
  );
  const [maximum, setMaximum] = useState(
    initialState.maxCents ? centsToDecimal(initialState.maxCents) : "",
  );
  const [missing, setMissing] = useState(initialState.missing);
  const [filters, setFilters] = useState(false);
  const [offset, setOffset] = useState(initialState.offset);
  const [overrides, setOverrides] = useState<
    Record<string, { entry: JournalEntry; pending: boolean }>
  >({});
  const rowCommand = useAccountingRowCommand();
  const clearRowErrors = rowCommand.clearResolved;
  const [error, setError] = useState("");
  // Selected draft ids with the version seen at selection time, so a stale row never posts.
  const [selection, setSelection] = useState<Record<string, number>>({});
  // One dialog for every selected row: a line per field to change, and a
  // switch to mark the drafts reviewed once the changes land.
  const [bulkEdit, setBulkEdit] = useState<{
    entries: JournalEntry[];
    lines: BulkLine[];
    review: boolean;
  } | null>(null);
  // A quick rename from the list: the description becomes an input in place.
  const [renaming, setRenaming] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [transfer, setTransfer] = useState<{
    entry: JournalEntry;
    counterpart: JournalEntry | null;
  } | null>(null);
  const cmd = useAccountingCommand(onRefresh);
  const { feeds } = useAccountingBankIdentity();
  const balances = useMemo(
    () => accountBalances(data.balances, manage.profiles, feeds),
    [data.balances, manage.profiles, feeds],
  );

  const profiles = manage.profiles;
  const accounts = useMemo(
    () => new Map(data.accounts.map((a) => [a.id, a])),
    [data.accounts],
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

  const filter = buildRegisterFilter({
    search,
    account,
    status,
    sort,
    source,
    payee,
    from,
    to,
    missing,
    minCents,
    maxCents,
    offset,
  });
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

  // The page comes from the shared cache: instant when the shell warmed it,
  // kept on screen (dimmed) while a changed filter loads, and read again
  // behind itself after any write.
  const page = useAccountingRead<Result>(registerQuery(filter), {
    enabled: !demo && !invalid,
    keepPrevious: true,
    revalidateOnFocus: true,
  });
  // The Review badge follows the search and filters: with any active it
  // counts the unreviewed rows that match instead of the whole inbox.
  const narrowed = Boolean(
    search ||
      account ||
      source ||
      payee ||
      from ||
      to ||
      minCents ||
      maxCents ||
      missing,
  );
  const reviewTotal = useAccountingRead<Result>(
    registerQuery({
      ...buildRegisterFilter({
        search,
        account,
        status: "draft",
        sort,
        source,
        payee,
        from,
        to,
        missing,
        minCents,
        maxCents,
        offset: 0,
      }),
      limit: 1,
    }),
    {
      enabled: !demo && !invalid && narrowed && status !== "draft",
      keepPrevious: true,
    },
  );
  const reviewBadge = !narrowed
    ? reviewCount
    : status === "draft"
      ? (page.data?.total ?? null)
      : (reviewTotal.data?.total ?? null);
  const demoResult = useMemo<Result | null>(() => {
    if (!demo || invalid) return null;
    const f: Partial<RegisterFilter> = JSON.parse(signature);
    // The same search the database runs, over the demo books.
    const terms = parseSearchTerms(f.query ?? "");
    const lookups = {
      partyName: (id: string) =>
        manage.parties.find((party) => party.id === id)?.name,
      account: (id: string) => accounts.get(id),
    };
    const list = data.entries.filter(
      (e) =>
        (f.status === "reversed"
          ? !e.reverses_entry_id &&
            Boolean(e.reversed_by_entry_id) &&
            !e.replacement_entry_id
          : !isTransactionReversed(e) &&
            (f.status === "all"
              ? e.status !== "discarded"
              : e.status === f.status)) &&
        (!f.review ||
          (f.review === "reviewed"
            ? isTransactionReviewed(e)
            : !isTransactionReviewed(e))) &&
        (!f.account || e.lines.some((l) => l.account_id === f.account)) &&
        entryMatchesSearch(
          e,
          terms,
          lookups,
          presentTransaction(e, profiles, f.account).amount,
        ),
    );
    const start = f.offset ?? 0;
    return {
      entries: list.slice(start, start + PAGE),
      total: list.length,
      offset: start,
      limit: PAGE,
      revision: "demo",
    };
  }, [
    demo,
    invalid,
    signature,
    data.entries,
    manage.parties,
    accounts,
    profiles,
  ]);
  const result = demo ? demoResult : (page.data ?? null);
  const loading = !demo && !invalid && page.loading;
  useEffect(() => {
    const next = page.data;
    if (!next || page.isPlaceholder) return;
    clearRowErrors(next.entries);
    setOverrides((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id, value]) => {
          const fresh = next.entries.find((e) => e.id === id);
          return (
            value.pending || (fresh && fresh.version < value.entry.version)
          );
        }),
      ),
    );
  }, [page.data, page.isPlaceholder, clearRowErrors]);

  const bankProfiles = profiles.filter((p) => p.cash_kind !== "none");
  const bankIds = new Set(bankProfiles.map((p) => p.account_id));
  const cashBalance = data.balances
    .filter((a) =>
      bankProfiles.some((p) => p.account_id === a.id && p.cash_kind !== "card"),
    )
    .reduce((s, a) => s + balances.get(a.id)!.amount, BigInt(0));
  const selectedBalance = data.balances.find((a) => a.id === account);
  const displayedBalance = selectedBalance
    ? balances.get(selectedBalance.id)!.amount
    : cashBalance;
  const cashAccounts = data.balances.filter((a) =>
    bankProfiles.some((p) => p.account_id === a.id && p.cash_kind !== "card"),
  );
  const bankBalanceCount = cashAccounts.filter(
    (a) => balances.get(a.id)?.bank !== null,
  ).length;
  const balanceLabel = account
    ? balances.get(account)?.bank != null
      ? "Bank-reported balance"
      : "Book balance (no bank balance)"
    : bankBalanceCount === cashAccounts.length && bankBalanceCount > 0
      ? "Latest bank balances"
      : bankBalanceCount > 0
        ? "Bank balances + unconnected book balances"
        : "Book balances (no bank balances)";

  // One base menu per direction; each row adds its own suggestions on top.
  const menus = useMemo(
    () => ({
      in: categoryGroups(data.accounts, profiles, "in"),
      out: categoryGroups(data.accounts, profiles, "out"),
      any: categoryGroups(data.accounts, profiles, "any"),
    }),
    [data.accounts, profiles],
  );
  const directionOf = (p: ReturnType<typeof presentTransaction>) =>
    p.amount < BigInt(0) ? "out" : "in";
  const payeeDefault = (entry: JournalEntry) =>
    manage.parties.find((party) => party.id === entry.context?.payee_id)
      ?.default_account_id;
  // The quiet tag beside a description: who the row is with, without
  // repeating a name the description already carries.
  const partyById = useMemo(
    () => new Map(manage.parties.map((party) => [party.id, party])),
    [manage.parties],
  );
  const affiliationOf = (entry: JournalEntry) => {
    const party = entry.context?.payee_id
      ? partyById.get(entry.context.payee_id)
      : undefined;
    return party ? contactAffiliation(entry.memo, party) : "";
  };

  const rows = (result?.entries ?? [])
    .map((entry) => overrides[entry.id]?.entry ?? entry)
    .filter((entry) =>
      status === "reversed"
        ? !entry.reverses_entry_id &&
          Boolean(entry.reversed_by_entry_id) &&
          !entry.replacement_entry_id
        : !isTransactionReversed(entry) &&
          (status === "all" ||
            (status === "discarded"
              ? entry.status === "discarded"
              : entry.status !== "discarded" &&
                isTransactionReviewed(entry) === (status === "posted"))),
    ) as TransactionRow[];
  // Any live row can be selected; deleted rows and earlier versions cannot.
  const selectableRows = rows.filter(
    (e) => !isTransactionReversed(e) && e.status !== "discarded",
  );
  const chosen = selectableRows.filter((e) => selection[e.id] === e.version);
  const plural = (n: number, noun: string) =>
    `${n} ${n === 1 ? noun : `${noun}s`}`;
  const chosenSet = new Set(chosen.map((e) => e.id));
  const busy = cmd.busy || page.isPlaceholder;
  const rowBusy = (id: string) => busy || rowCommand.pending.has(id);

  function openAction(action: TransactionAction, entry: JournalEntry) {
    if (!rowCommand.isPending(entry.id)) onAction(action, entry);
  }

  async function saveRow(
    entry: JournalEntry,
    command: WorkflowCommand,
    optimistic: JournalEntry,
  ) {
    if (rowCommand.isPending(entry.id)) return false;
    setOverrides((previous) => ({
      ...previous,
      [entry.id]: { entry: optimistic, pending: true },
    }));
    const saved = await rowCommand.execute(entry.id, command);
    setOverrides((previous) => {
      const next = { ...previous };
      if (saved)
        next[entry.id] = {
          entry: { ...optimistic, version: saved.version ?? entry.version + 1 },
          pending: false,
        };
      else delete next[entry.id];
      return next;
    });
    // Also re-read after an uncertain response, without retrying a mutation automatically.
    try {
      await onTransactionSaved();
    } catch {
      setError(
        "The transaction list could not refresh. Reload to check the latest saved state.",
      );
    }
    return !!saved;
  }

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
    const reviewed = !isTransactionReviewed(entry);
    if (
      await saveRow(
        entry,
        {
          type: "entry.review",
          id: entry.id,
          expected_version: entry.version,
          reviewed,
        },
        { ...entry, status: "posted", review_pending: !reviewed },
      )
    )
      toast(
        "success",
        reviewed ? "Transaction reviewed." : "Marked as unreviewed.",
      );
  }

  /** Words only, saved in place: no new version, whatever the row's status. */
  async function renameRow(entry: JournalEntry, memo: string) {
    const next = memo.trim();
    setRenaming(null);
    if (!next || next === entry.memo) return;
    if (
      await saveRow(
        entry,
        {
          type: "entry.context",
          id: entry.id,
          expected_version: entry.version,
          kind: commandContext(entry.context ?? defaultEntryContext).kind,
          memo: next,
        },
        { ...entry, memo: next },
      )
    )
      toast("success", "Description saved.");
  }

  function saveCommand(
    entry: JournalEntry,
    accountId: string,
    payeeId?: string | null,
    memo?: string,
    // The schema keeps save and review on one member, so the narrow type names both.
  ): Extract<
    WorkflowCommand,
    { type: "transaction.save" | "transaction.review" }
  > | null {
    const p = presentTransaction(entry, profiles);
    if (!p.editable || p.categoryLines.length !== 1) return null;
    const context = commandContext(entry.context ?? defaultEntryContext);
    // The category decides the kind: an expense on money in is a refund.
    const kind: CategoryKind | null = categoryKind(
      accountId,
      data.accounts,
      profiles,
      directionOf(p),
    );
    return {
      type: "transaction.save",
      id: entry.id,
      expected_version: entry.version,
      entry_date: entry.entry_date,
      memo: memo ?? entry.memo,
      context: {
        ...context,
        ...(kind ? { kind } : {}),
        ...(payeeId !== undefined ? { payee_id: payeeId } : {}),
      },
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
    const command = saveCommand(entry, accountId, payeeId);
    if (!command) return;
    // Categorizing never reviews: the checkmark is its own, deliberate step.
    const optimistic = {
      ...entry,
      context: {
        ...defaultEntryContext,
        ...entry.context,
        ...command.context,
      },
      lines: command.lines.map((line, index) => ({
        ...entry.lines[index],
        ...line,
      })),
    };
    if (await saveRow(entry, command, optimistic))
      toast("success", "Category saved. Review it when you are ready.");
  }

  /** The category change for one row: a draft saves in place, a reviewed row saves a new version. */
  function categoryCommand(
    entry: JournalEntry,
    accountId: string,
  ): WorkflowCommand | null {
    if (entry.status !== "posted") return saveCommand(entry, accountId);
    const p = presentTransaction(entry, profiles);
    if (!p.editable || p.categoryLines.length !== 1) return null;
    return {
      type: "entry.correct",
      id: entry.id,
      expected_version: entry.version,
      replacement_id: crypto.randomUUID(),
      entry_date: entry.entry_date,
      reversal_date: entry.entry_date,
      memo: entry.memo,
      reason: "Bulk edit in Transactions",
      lines: entry.lines.map((l) => ({
        account_id: l.id === p.categoryLines[0].id ? accountId : l.account_id,
        amount_cents: l.amount_cents,
        memo: l.memo,
      })),
    };
  }

  const takesCategory = (e: JournalEntry) => {
    const p = presentTransaction(e, profiles);
    return p.editable && p.categoryLines.length === 1;
  };
  const takesPayee = (e: JournalEntry) => e.context?.kind !== "invoice_receipt";

  /**
   * What a bulk edit does to each selected row. A draft that takes a new
   * category saves everything in one command; otherwise the payee lands in
   * place first, so a category change on a reviewed row copies it into the
   * new version. Rows no longer on screen (already replaced) are skipped.
   */
  function bulkPlan(edit: NonNullable<typeof bulkEdit>) {
    const entries = edit.entries.flatMap((e) => {
      const current = rows.find((r) => r.id === e.id);
      return current ? [current] : [];
    });
    const category = edit.lines.find(
      (l) => l.field === "category" && l.account,
    );
    const payee = edit.lines.find((l) => l.field === "payee");
    const description = edit.lines.find(
      (l) => l.field === "description" && l.memo.trim(),
    );
    const groups = entries.map((e) => {
      const wantsCategory = !!category && takesCategory(e);
      const wantsPayee = !!payee && takesPayee(e);
      const wantsDescription = !!description;
      const payeeId = payee ? (payee.context.payee_id ?? null) : undefined;
      const inPlace: WorkflowCommand[] = [];
      const money: WorkflowCommand[] = [];
      if (e.status === "draft" && wantsCategory) {
        const save = saveCommand(
          e,
          category!.account,
          wantsPayee ? payeeId : undefined,
          wantsDescription ? description!.memo.trim() : undefined,
        );
        if (save) money.push(save);
      } else {
        if (wantsPayee || wantsDescription)
          inPlace.push({
            type: "entry.context",
            id: e.id,
            expected_version: e.version,
            kind: commandContext(e.context ?? defaultEntryContext).kind,
            ...(wantsPayee ? { payee_id: payeeId ?? null } : {}),
            ...(wantsDescription ? { memo: description!.memo.trim() } : {}),
          });
        if (wantsCategory) {
          const correct = categoryCommand(e, category!.account);
          if (correct) money.push(correct);
        }
      }
      return {
        entry: e,
        inPlace,
        money,
        wantsCategory,
        wantsPayee,
        wantsDescription,
        categorized:
          wantsCategory || presentTransaction(e, profiles).categorized,
      };
    });
    return { entries, category, payee, description, groups };
  }

  async function applyBulkEdit() {
    if (!bulkEdit) return;
    const plan = bulkPlan(bulkEdit);
    const versions = new Map(plan.entries.map((e) => [e.id, e.version]));
    const note = (id: string, result?: { version?: number }) => {
      if (result?.version !== undefined) versions.set(id, result.version);
    };
    // Phase 1: payees, in place.
    const inPlace = plan.groups.flatMap((g) => g.inPlace);
    if (inPlace.length > 0) {
      const first = await cmd.executeMany(inPlace);
      first.results.forEach((r, i) =>
        note(String((inPlace[i] as { id: string }).id), r),
      );
      if (first.failed) return;
    }
    // Phase 2: categories, with the versions the payee phase produced.
    const money = plan.groups.flatMap((g) =>
      g.money.map((c) => ({
        ...c,
        expected_version: versions.get(g.entry.id) ?? g.entry.version,
      })),
    );
    if (money.length > 0) {
      const second = await cmd.executeMany(money as WorkflowCommand[]);
      second.results.forEach((r, i) => {
        const c = money[i] as { type: string; id: string };
        if (c.type === "transaction.save") note(c.id, r);
      });
      if (second.failed) return;
    }
    // Phase 3: review the drafts that have a category.
    const toReview = bulkEdit.review
      ? plan.groups.filter((g) => g.entry.status === "draft" && g.categorized)
      : [];
    if (toReview.length > 0) {
      const chunks: WorkflowCommand[] = [];
      for (let i = 0; i < toReview.length; i += 50)
        chunks.push({
          type: "entry.bulkpost",
          id: crypto.randomUUID(),
          entries: toReview.slice(i, i + 50).map((g) => ({
            id: g.entry.id,
            expected_version: versions.get(g.entry.id) ?? g.entry.version,
          })),
        });
      const third = await cmd.executeMany(chunks);
      if (third.failed) return;
    }
    const parts: string[] = [];
    if (plan.description)
      parts.push(
        "description on " +
          plural(
            plan.groups.filter((g) => g.wantsDescription).length,
            "transaction",
          ),
      );
    if (plan.payee)
      parts.push(
        "contact on " +
          plural(plan.groups.filter((g) => g.wantsPayee).length, "transaction"),
      );
    if (plan.category)
      parts.push(
        "category on " +
          plural(
            plan.groups.filter((g) => g.wantsCategory).length,
            "transaction",
          ),
      );
    if (toReview.length > 0)
      parts.push(plural(toReview.length, "transaction") + " reviewed");
    setBulkEdit(null);
    setSelection({});
    if (parts.length > 0) toast("success", "Saved: " + parts.join(", ") + ".");
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

  function rowActions(entry: JournalEntry): RowAction[] {
    const readOnly = (action: TransactionAction) =>
      rowBusy(entry.id) || (demo && action !== "detail");
    const actions: RowAction[] = [
      {
        label: "Edit",
        icon: <Pencil />,
        onSelect: () => openAction("edit", entry),
        disabled: isTransactionReversed(entry) || readOnly("edit"),
      },
      {
        label: "Copy",
        icon: <Copy />,
        onSelect: () => openAction("copy", entry),
        disabled: readOnly("copy"),
      },
    ];
    if (entry.status === "draft")
      actions.push({
        label: "Delete",
        icon: <Trash2 />,
        variant: "danger",
        separator: true,
        onSelect: () => openAction("discard", entry),
        disabled: readOnly("discard"),
      });
    else if (!entry.reversed_by_entry_id && !entry.reverses_entry_id)
      actions.push({
        label: entry.payroll_run_id ? "Delete in Payroll" : "Delete",
        icon: <Trash2 />,
        variant: "danger",
        separator: true,
        onSelect: () => openAction("reverse", entry),
        disabled: readOnly("reverse"),
      });
    if (canRestoreTransaction(entry))
      actions.push({
        label: "Restore",
        icon: <Undo2 />,
        onSelect: () => openAction("restore", entry),
        disabled: demo,
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

  /** The picker leads with a transfer only when the books hold the other leg. */
  function transferSuggestion(row: TransactionRow): TransferMatch | undefined {
    if (demo || row.status !== "draft") return undefined;
    const counterpart = transferCounterpart(row);
    if (!counterpart) return undefined;
    const otherLine = presentTransaction(counterpart, profiles).bankLine;
    return {
      account: otherLine
        ? (accounts.get(otherLine.account_id)?.name ?? "another account")
        : "another account",
      date: counterpart.entry_date,
      onSelect: () => setTransfer({ entry: row, counterpart }),
    };
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
          disabled={rowBusy(row.id) || demo}
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
    if (isTransactionReversed(entry))
      return (
        <Badge size="sm">
          {entry.restored_by_entry_id
            ? "Restored"
            : entry.replacement_entry_id
              ? "Earlier version"
              : "Deleted"}
        </Badge>
      );
    const reviewed = isTransactionReviewed(entry);
    return (
      <ReviewCheck
        reviewed={reviewed}
        categorized={p.categorized}
        name={entry.memo}
        busy={rowCommand.pending.has(entry.id)}
        disabled={demo || rowBusy(entry.id) || entry.status === "discarded"}
        onToggle={() => void review(entry)}
      />
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
        <AccountingCategoryPicker
          label={`Category for ${entry.memo}`}
          compact
          disabled={rowBusy(entry.id)}
          value={p.categoryLines[0].account_id}
          groups={categoryMenu(menus[directionOf(p)], data.accounts, {
            current: p.categoryLines[0].account_id,
            prior: entry.prior_treatment,
            payeeDefault: payeeDefault(entry),
          })}
          direction={directionOf(p)}
          // A placeholder category (Uncategorized) is named on the trigger, not listed.
          placeholder={categories[0] ?? "Choose a category"}
          transfer={transferSuggestion(entry as TransactionRow)}
          onChange={(id) => void categorize(entry, id)}
          className={cn("w-full", !p.categorized && "text-warning")}
        />
      );
    return (
      <button
        type="button"
        onClick={() => openAction(transactionRowAction(entry), entry)}
        className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        return (
          <div className="min-w-0">
            {renaming?.id === e.id ? (
              <div onClick={(event) => event.stopPropagation()}>
                <TextInput
                  aria-label={`Description for ${e.memo}`}
                  size="sm"
                  autoFocus
                  value={renaming.value}
                  maxLength={1000}
                  onChange={(value) => setRenaming({ id: e.id, value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void renameRow(e, renaming.value);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  }}
                  onBlur={() => void renameRow(e, renaming.value)}
                />
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => openAction(transactionRowAction(e), e)}
                  className="min-w-0 truncate text-left font-medium transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:underline"
                >
                  {e.memo}
                </button>
                {affiliationOf(e) && (
                  <Badge size="sm" className="shrink-0">
                    {affiliationOf(e)}
                  </Badge>
                )}
                {!demo &&
                  !isTransactionReversed(e) &&
                  e.status !== "discarded" && (
                    <button
                      type="button"
                      aria-label={`Rename ${e.memo}`}
                      disabled={rowBusy(e.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenaming({ id: e.id, value: e.memo });
                      }}
                      className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [tr:hover_&]:opacity-100"
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                  )}
              </div>
            )}
            {(e.reversed_by_entry_id || e.reverses_entry_id) && (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {e.reversed_by_entry_id
                  ? e.replacement_entry_id
                    ? "Earlier version"
                    : "Deleted"
                  : ""}
                {e.reverses_entry_id ? "Deletion" : ""}
              </p>
            )}
            {priorHint(e, p)}
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
        return (
          <span className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
            {p.accountIds.length
              ? p.accountIds.map((id) => (
                  <AccountingAccountLabel
                    key={id}
                    accountId={id}
                    name={accounts.get(id)?.name ?? "Unknown account"}
                  />
                ))
              : "Multiple accounts"}
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
            {!p.movement && p.transfer && (
              <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
                Transfer
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
    const selectable = e.status === "draft" && !demo;
    return (
      <article className="space-y-3">
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
              <AccountingAccountLogo
                accountId={p.accountIds[0]}
                name={accounts.get(p.accountIds[0])?.name}
                size={32}
                className="mt-0.5"
              />
            )}
            <div className="min-w-0">
              <button
                type="button"
                className="block max-w-full truncate text-left text-sm font-medium focus-visible:outline-none focus-visible:underline"
                onClick={() => openAction(transactionRowAction(e), e)}
              >
                {e.memo}
              </button>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{dateLabel(e.entry_date)}</span>
                {affiliationOf(e) && (
                  <Badge size="sm">{affiliationOf(e)}</Badge>
                )}
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

  const emptyState = page.error ? (
    <span role="alert" className="text-error">
      {page.error}
    </span>
  ) : (
    <div className="space-y-1.5">
      <p className="font-medium text-foreground">
        {search
          ? `No matches for "${search}"`
          : status === "draft" && !activeFilters
            ? "Nothing needs review"
            : "No transactions in this view"}
      </p>
      <p>
        {search
          ? "Try fewer words, an amount like 42.50, a card's last four digits, or >100."
          : activeFilters
            ? "Try adjusting your filters."
            : status === "draft"
              ? "New bank activity lands here for a quick category check."
              : "Add a transaction or connect your accounts to start your books."}
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 sm:max-w-xl">
          <AccountingPicker
            ariaLabel="Accounts"
            value={account}
            options={[
              {
                value: "",
                label: "All accounts",
                detail: (
                  <span>
                    Cash & bank <MaskedValue value={money(cashBalance)} />
                  </span>
                ),
              },
              ...data.accounts
                .filter((a) => bankIds.has(a.id) || a.id === account)
                .map((a) => {
                  const p = profiles.find((p) => p.account_id === a.id);
                  const balance = balances.get(a.id);
                  return {
                    value: a.id,
                    label: a.name,
                    icon: (
                      <AccountingAccountLogo
                        accountId={a.id}
                        name={a.name}
                        size={20}
                      />
                    ),
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
                            : balance?.bank != null
                              ? "Bank-reported balance"
                              : "Book balance (no bank balance)"}
                        </span>
                        <MaskedValue
                          value={money(balance?.amount ?? BigInt(0))}
                        />
                      </span>
                    ),
                  };
                }),
            ]}
            onChange={(v) => changed(() => setAccount(v))}
            className="w-full"
            // The same height and corner as the New button beside it: one line,
            // name and figure. Where the figure comes from is told in the menu rows.
            triggerClassName="glass-card h-10 min-h-0 rounded-lg px-3 hover:border-[rgba(var(--ink),0.18)]"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="hidden shrink-0 sm:block" title={balanceLabel}>
                {account ? (
                  <AccountingAccountLogo
                    accountId={account}
                    name={accounts.get(account)?.name}
                    size={22}
                  />
                ) : (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-teal-light">
                    <Wallet size={13} aria-hidden="true" />
                  </span>
                )}
              </span>
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                {accounts.get(account)?.name ?? "All accounts"}
              </p>
              <span className="shrink-0 text-sm font-semibold tabular-nums">
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
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      <section
        className="glass-card overflow-hidden rounded-xl"
        aria-label="Transactions"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <div
              role="tablist"
              aria-label="Transaction status"
              className="flex w-full flex-wrap items-center gap-1 rounded-lg bg-[rgba(var(--ink),0.05)] p-1 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)] sm:w-auto"
            >
              {(
                [
                  ["draft", "Review", reviewBadge],
                  ["all", "All", null],
                  ["reversed", "Deleted", null],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={status === value}
                  onClick={() => changed(() => setStatus(value))}
                  className={cn(
                    "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none",
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
          </div>
          {chosen.length > 0 ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
              <span className="text-sm text-muted-foreground">
                {chosen.length} selected
                {cmd.progress
                  ? ` · saving ${cmd.progress.done} of ${cmd.progress.total}`
                  : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || rowCommand.pending.size > 0}
                onClick={() =>
                  setBulkEdit({
                    entries: chosen,
                    lines: [newBulkLine()],
                    review: false,
                  })
                }
              >
                <Pencil size={14} aria-hidden="true" />
                Edit selected
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Clear selection"
                disabled={busy}
                onClick={() => setSelection({})}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Tooltip content="Sort">
                <RowActionsMenu
                  label="Sort transactions"
                  trigger={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Sort transactions"
                    >
                      <ArrowUpDown size={15} aria-hidden="true" />
                    </Button>
                  }
                  actions={(
                    [
                      ["date_desc", "Newest first"],
                      ["date_asc", "Oldest first"],
                      ["amount_desc", "Largest amount first"],
                      ["amount_asc", "Smallest amount first"],
                      ["description", "Description A to Z"],
                    ] as const
                  ).map(([value, label]) => ({
                    label,
                    checked: sort === value,
                    onSelect: () => changed(() => setSort(value)),
                  }))}
                />
              </Tooltip>
              <FilterPopover
                open={filters}
                onOpenChange={setFilters}
                count={activeFilters}
                onReset={resetFilters}
              >
                <div className="grid gap-3 sm:grid-cols-2">
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
                    onChange={(nextValue) =>
                      changed(() => setMinimum(nextValue))
                    }
                  />
                  <TextInput
                    label="Maximum amount"
                    inputMode="decimal"
                    placeholder="No maximum"
                    value={maximum}
                    onChange={(nextValue) =>
                      changed(() => setMaximum(nextValue))
                    }
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
                    label="Contact"
                    visibleLabel="Contact"
                    value={payee}
                    options={[
                      { value: "", label: "All contacts" },
                      ...manage.parties.map((p) => ({
                        value: p.id,
                        label: p.name,
                      })),
                    ]}
                    onChange={(v) => changed(() => setPayee(v))}
                  />
                  <Checkbox
                    checked={missing}
                    onChange={(v) => changed(() => setMissing(v))}
                    label="Missing receipt or document"
                    className="self-end pb-2"
                  />
                </div>
              </FilterPopover>
              <TextInput
                aria-label="Search transactions"
                placeholder="Search descriptions, contacts, amounts"
                clearable
                prefix={<Search size={15} aria-hidden="true" />}
                value={query}
                maxLength={200}
                onChange={(nextValue) => setQuery(nextValue)}
              />
            </div>
          )}
        </div>

        {(invalid ||
          error ||
          page.error ||
          cmd.error ||
          Object.keys(rowCommand.errors).length > 0) && (
          <p
            role="alert"
            className="border-b border-border bg-error/5 px-4 py-3 text-sm text-error"
          >
            {invalid ||
              error ||
              page.error ||
              cmd.error ||
              Object.entries(rowCommand.errors)
                .map(
                  ([id, message]) =>
                    `${result?.entries.find((entry) => entry.id === id)?.memo ?? "Transaction"}: ${message}`,
                )
                .join(" ")}
          </p>
        )}

        <DataTable<TransactionRow>
          framed={false}
          fixedLayout
          columns={columns}
          data={rows}
          keyExtractor={(e) => e.id}
          // A reviewed row is filed: it sits on the settled shade. A row still
          // to review stays on the bare card, so the unshaded rows are the
          // work. The shade is a theme token, set far enough from the page
          // and card surfaces that the two states read apart at a glance.
          rowClassName={(e) =>
            chosenSet.has(e.id)
              ? "bg-primary/[0.06]"
              : isTransactionReviewed(e)
                ? "bg-[var(--row-settled)] hover:bg-[var(--row-settled-hover)]"
                : "bg-card hover:bg-[color-mix(in_srgb,var(--card),var(--foreground)_2%)]"
          }
          onRowClick={(e) => openAction(transactionRowAction(e), e)}
          busy={page.isPlaceholder}
          skeletonRows={loading ? 12 : 0}
          emptyState={emptyState}
          mobileCard={mobileCard}
          className="lg:[&_table]:min-w-[720px]"
          selection={
            demo
              ? undefined
              : {
                  selected: chosenSet,
                  isSelectable: (key) =>
                    !rowCommand.pending.has(key) &&
                    selectableRows.some((e) => e.id === key),
                  onToggle: (key) => {
                    const entry = selectableRows.find((e) => e.id === key);
                    if (entry) toggleOne(entry);
                  },
                  onToggleAll: (keys) =>
                    setSelection(
                      keys.every((k) => chosenSet.has(k))
                        ? {}
                        : Object.fromEntries(
                            selectableRows
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
              busy={loading || page.isPlaceholder}
            />
          }
        />
      </section>

      <Dialog
        open={!!bulkEdit}
        onOpenChange={(open) => {
          if (!open && !cmd.busy) setBulkEdit(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              Edit{" "}
              {bulkEdit
                ? plural(bulkEdit.entries.length, "transaction")
                : "transactions"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              One change per line for every selected transaction, then
              optionally mark them reviewed.
            </DialogDescription>
          </DialogHeader>
          {bulkEdit &&
            (() => {
              const plan = bulkPlan(bulkEdit);
              const total = plan.entries.length;
              const drafts = plan.groups.filter(
                (g) => g.entry.status === "draft",
              );
              const unreviewable = drafts.filter((g) => !g.categorized).length;
              const complete = bulkEdit.lines.every(
                (l) =>
                  l.field === "payee" ||
                  (l.field === "category" && l.account !== "") ||
                  (l.field === "description" && l.memo.trim() !== ""),
              );
              const reaches = plan.groups.some(
                (g) => g.inPlace.length + g.money.length > 0,
              );
              const canApply =
                !cmd.busy &&
                complete &&
                (bulkEdit.lines.length > 0
                  ? reaches
                  : bulkEdit.review && drafts.length - unreviewable > 0);
              const update = (key: string, patch: Partial<BulkLine>) =>
                setBulkEdit({
                  ...bulkEdit,
                  lines: bulkEdit.lines.map((l) =>
                    l.key === key ? { ...l, ...patch } : l,
                  ),
                });
              const used = (field: BulkLine["field"], key: string) =>
                bulkEdit.lines.some((l) => l.key !== key && l.field === field);
              return (
                <div className="mt-4 space-y-4">
                  {bulkEdit.lines.map((line) => (
                    <div
                      key={line.key}
                      className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-end"
                    >
                      <Select
                        id={"bulk-field-" + line.key}
                        label="Edit"
                        value={line.field}
                        placeholder="Choose a field"
                        options={[
                          { value: "category", label: "Category" },
                          { value: "payee", label: "Contact" },
                          { value: "description", label: "Description" },
                        ].filter(
                          (o) =>
                            o.value === line.field ||
                            !used(o.value as BulkLine["field"], line.key),
                        )}
                        onChange={(value) =>
                          update(line.key, {
                            field: value as BulkLine["field"],
                          })
                        }
                      />
                      {line.field === "category" ? (
                        <AccountingCategoryPicker
                          label="Change to"
                          visibleLabel="Change to"
                          value={line.account}
                          groups={(() => {
                            // One direction gets its own menu; a mix opens both sides.
                            const directions = new Set(
                              plan.entries
                                .filter(takesCategory)
                                .map((e) =>
                                  directionOf(presentTransaction(e, profiles)),
                                ),
                            );
                            return directions.size === 1
                              ? menus[[...directions][0]]
                              : menus.any;
                          })()}
                          placeholder="Choose a category"
                          onChange={(v) => update(line.key, { account: v })}
                        />
                      ) : line.field === "description" ? (
                        <TextInput
                          label="Change to"
                          value={line.memo}
                          maxLength={1000}
                          placeholder="New description"
                          onChange={(nextValue) =>
                            update(line.key, { memo: nextValue })
                          }
                        />
                      ) : line.field === "payee" ? (
                        <AccountingContextEditor
                          className="min-w-0"
                          value={line.context}
                          manage={manage}
                          accounts={data.accounts}
                          onChange={(context) => update(line.key, { context })}
                        />
                      ) : (
                        <Select
                          id={"bulk-value-" + line.key}
                          label="Change to"
                          value=""
                          placeholder="Choose a field first"
                          options={[]}
                          disabled
                          onChange={() => {}}
                        />
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Remove this edit"
                        className="sm:mb-1"
                        onClick={() =>
                          setBulkEdit({
                            ...bulkEdit,
                            lines: bulkEdit.lines.filter(
                              (l) => l.key !== line.key,
                            ),
                          })
                        }
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  {bulkEdit.lines.length < 3 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setBulkEdit({
                          ...bulkEdit,
                          lines: [...bulkEdit.lines, newBulkLine()],
                        })
                      }
                    >
                      <Plus size={14} aria-hidden="true" />
                      Add another edit
                    </Button>
                  )}
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {plan.category && (
                      <p>
                        Category: applies to{" "}
                        {plan.groups.filter((g) => g.wantsCategory).length} of{" "}
                        {total}
                        {plan.groups.some((g) => !g.wantsCategory)
                          ? ". Splits and transfers are edited one at a time."
                          : "."}
                        {plan.groups.some(
                          (g) => g.wantsCategory && g.entry.status === "posted",
                        )
                          ? " Reviewed transactions save a new version; the earlier version stays in history."
                          : ""}
                      </p>
                    )}
                    {plan.description && (
                      <p>
                        Description: applies to{" "}
                        {plan.groups.filter((g) => g.wantsDescription).length}{" "}
                        of {total}.
                      </p>
                    )}
                    {plan.payee && (
                      <p>
                        Contact: applies to{" "}
                        {plan.groups.filter((g) => g.wantsPayee).length} of{" "}
                        {total}.
                      </p>
                    )}
                  </div>
                  {drafts.length > 0 && (
                    <Toggle
                      checked={bulkEdit.review}
                      onChange={(review) =>
                        setBulkEdit({ ...bulkEdit, review })
                      }
                      label="Mark selected transactions as reviewed"
                      description={
                        unreviewable > 0
                          ? plural(unreviewable, "transaction") +
                            " without a category will stay unreviewed."
                          : undefined
                      }
                    />
                  )}
                  {cmd.error && (
                    <p role="alert" className="text-sm text-error">
                      {cmd.error}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={cmd.busy}
                      onClick={() => setBulkEdit(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={!canApply}
                      loading={cmd.busy}
                      onClick={() => void applyBulkEdit()}
                    >
                      Apply
                    </Button>
                  </div>
                </div>
              );
            })()}
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
