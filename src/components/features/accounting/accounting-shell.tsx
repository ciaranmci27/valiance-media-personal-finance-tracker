"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Plus,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useLoaderPhase } from "@/components/ui/use-loader-phase";
import { useBoot, useBootHold } from "@/components/layout/boot";
import { defaultChart } from "@/lib/accounting/chart";
import { parseUsd } from "@/lib/accounting/money";
import type {
  AccountingWorkspace,
  JournalEntry,
} from "@/lib/accounting/contracts";
import type {
  RegisterFilter,
  WorkflowCommand,
} from "@/lib/accounting/workflows";
import {
  isTransactionReviewed,
  presentTransaction,
} from "@/lib/accounting/transactions";
import { feedSyncDue, type FeedData } from "@/lib/accounting/feeds";
import {
  journalFilterFromLocation,
  preloadContextFromLocation,
  registerQuery,
  type PreloadContext,
} from "@/lib/accounting/preload";
import {
  resolveAccountingView,
  type AccountingView,
} from "@/lib/accounting/views";
import {
  AccountingTransactions,
  type TransactionAction,
} from "./accounting-transactions";
import { AccountingTransactionEditor } from "./accounting-transaction-editor";
import { AccountingAccountCreate } from "./accounting-account-create";
import {
  ApprovalDialog,
  EntryDetailDialog,
  JournalEditorDialog,
  ReplacementReviewDialog,
  makeEditor,
  type Approval,
  type Editor,
} from "./accounting-journal-dialogs";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { SetupGuide } from "./setup-guide";
import type { BooksMetadata } from "./types";
import { AccountingBankIdentityProvider } from "./accounting-bank-identity";
import { ReverseTransfer } from "./accounting-transfer-dialogs";
import type { TransferGroup, TransfersView } from "@/lib/accounting/transfers";
import { todayInBooks } from "./format";
import {
  AccountingCacheProvider,
  useAccountingCache,
} from "./accounting-cache";
import { useAccountingRead } from "./use-accounting-read";
import {
  VIEW_STEPS,
  peekView,
  useViewComponent,
  warmAccountingView,
} from "./accounting-views";
import { useViewGate } from "./accounting-view-gate";
import { AccountingLoading, BOOT_STEPS } from "./accounting-loading";
import { loadEvidenceChunk } from "./accounting-entry-evidence";
import type { AccountingOverview } from "./accounting-overview";
import type { AccountingAccounts } from "./accounting-accounts";
import type { AccountingClose } from "./accounting-close";
import type { AccountingPayrollRuns } from "./accounting-payroll-run";
import type { AccountingMore } from "./accounting-more";
import type { AccountingReports } from "./accounting-reports";

const ZERO = BigInt(0);

type View = AccountingView;

type Workspace = AccountingWorkspace;

const EMPTY_MANAGE: BooksMetadata = {
  profiles: [],
  parties: [],
  periods: [],
  preferences: null,
};

/** Demo books carry no profiles, so bank and card accounts are inferred from the default chart. */
function demoManage(workspace: AccountingWorkspace): BooksMetadata {
  const byCode = new Map(defaultChart.map((a) => [a.code, a]));
  return {
    ...EMPTY_MANAGE,
    profiles: workspace.balances.flatMap((a) => {
      const chart = byCode.get(a.code);
      return chart && chart.cash_kind !== "none"
        ? [
            {
              account_id: a.id,
              version: 1,
              purpose: chart.purpose ?? null,
              cash_kind: chart.cash_kind,
              parent_account_id: null,
              subtype: "",
            },
          ]
        : [];
    }),
  };
}

/**
 * The accounting workspace. The sidebar links to its screens (Overview,
 * Transactions, Accounts, Payroll, Reports, Manage); this shell renders
 * the one the URL names, owns the add menu and the shared entry dialogs.
 * State lives in the URL (`view`, `section`, `entry`, `report`) so links
 * and the back button keep working.
 */
export function AccountingBooks(props: {
  initial: AccountingWorkspace;
  demo?: boolean;
  detailOnly?: boolean;
  testing?: boolean;
}) {
  const mode = props.demo ? "demo" : props.testing ? "test" : "live";
  return (
    <AccountingCacheProvider scope={`${mode}:${props.initial.legal_name}`}>
      <AccountingBooksInner {...props} />
    </AccountingCacheProvider>
  );
}

function AccountingBooksInner({
  initial,
  demo = false,
  detailOnly = false,
  testing = false,
}: {
  initial: AccountingWorkspace;
  demo?: boolean;
  detailOnly?: boolean;
  testing?: boolean;
}) {
  const [data, setData] = useState<Workspace>(initial);
  const params = useSearchParams();
  const view = resolveAccountingView(params.get("view"), params.get("section"));
  const cache = useAccountingCache();

  const [accountFilter, setAccountFilter] = useState("");
  // Bumped whenever a filter link is applied so the list remounts even when
  // the new filter equals the current one.
  const [listKey, setListKey] = useState(0);
  const [registerFilter, setRegisterFilter] =
    useState<Partial<RegisterFilter> | null>(null);

  // What the screens read first, keyed exactly as they will ask for it, so
  // a warmed screen finds its answers waiting.
  const today = todayInBooks();
  const reviewCount = data.needs_review_count ?? data.draft_count;
  const urlFilter = journalFilterFromLocation(params);
  const ledgerFilter: Partial<RegisterFilter> = {
    ...(registerFilter ?? urlFilter),
    ...(accountFilter ? { account: accountFilter } : {}),
  };
  const ledgerKey = `${listKey}:${accountFilter}:${JSON.stringify(registerFilter)}`;
  const ctx: PreloadContext = {
    ...preloadContextFromLocation(params, today, reviewCount),
    from: data.from,
    to: data.to,
    entry: detailOnly ? (initial.entries[0]?.id ?? null) : null,
  };

  function setView(
    next: View,
    section?: string,
    extra?: Record<string, string>,
  ) {
    if (next !== "journal") {
      setRegisterFilter(null);
      setAccountFilter("");
    }
    void warmAccountingView(
      next,
      ctx,
      cache,
      next === "journal" ? ledgerFilter : undefined,
    );
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    url.searchParams.delete("entry");
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    for (const [key, value] of Object.entries(extra ?? {}))
      url.searchParams.set(key, value);
    window.history.pushState(null, "", url);
  }

  // Metadata and feed state come from the cache: instant on a return visit,
  // kept on screen while a write refreshes them.
  const manageRead = useAccountingRead<BooksMetadata>(
    { view: "manage" },
    { enabled: !demo },
  );
  const feedsRead = useAccountingRead<FeedData>(
    { view: "feeds" },
    { enabled: !demo },
  );
  const demoMetadata = useMemo(
    () => (demo ? demoManage(initial) : null),
    [demo, initial],
  );
  const manage = demoMetadata ?? manageRead.data ?? EMPTY_MANAGE;
  const manageLoaded = demo || manageRead.data !== undefined;
  const feeds = feedsRead.data ?? null;

  const [error, setError] = useState("");
  const [simpleEditor, setSimpleEditor] = useState<{
    entry?: JournalEntry;
    direction?: "in" | "out";
  } | null>(null);
  const [selected, setSelected] = useState<JournalEntry | null>(
    detailOnly ? (initial.entries[0] ?? null) : null,
  );
  // An entry asked for by id alone: the dialog opens at once and fills in.
  const [opening, setOpening] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [replacementReview, setReplacementReview] = useState<Extract<
    WorkflowCommand,
    { type: "entry.correct" }
  > | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [addAccount, setAddAccount] = useState(false);
  const [reverseTransfer, setReverseTransfer] = useState<TransferGroup | null>(
    null,
  );
  const [syncing, setSyncing] = useState(false);
  const syncRequested = useRef(false);
  const balanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const balanceRequest = useRef<AbortController | null>(null);
  const entryRequest = useRef(0);

  useEffect(
    () => () => {
      if (balanceTimer.current) clearTimeout(balanceTimer.current);
      balanceRequest.current?.abort();
    },
    [],
  );

  // The screen the URL names mounts only once its chunk and first reads are
  // in memory. Until then the loader stands where it will: the whole page on
  // the first visit, the content area on a later switch.
  const gate = useViewGate({
    view,
    mountKey: view === "journal" ? ledgerKey : "",
    ctx,
    initialFilter: ledgerFilter,
    demo,
    cache,
  });
  // A hard load arrives under the workspace boot screen: hold it open until
  // the first screen is ready and let it dissolve over the finished page. A
  // later arrival, or an uncached switch, runs the books' own loader.
  const boot = useBoot();
  useBootHold(!gate.ready, BOOT_STEPS, gate.step);
  const { phase, onLeft } = useLoaderPhase(!gate.ready && !boot.active, {
    minShowMs: 350,
  });
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (gate.ready && (boot.active || phase === "done")) setBooted(true);
  }, [gate.ready, boot.active, phase]);
  useViewComponent(view);
  const Overview = peekView("overview") as
    | typeof AccountingOverview
    | undefined;
  const Accounts = peekView("accounts") as
    | typeof AccountingAccounts
    | undefined;
  const Close = peekView("close") as typeof AccountingClose | undefined;
  const Payroll = peekView("payroll") as
    | typeof AccountingPayrollRuns
    | undefined;
  const More = peekView("manage") as typeof AccountingMore | undefined;
  const Reports = peekView("reports") as typeof AccountingReports | undefined;

  // Receipts and history are warmed the moment a transaction opens, so the
  // disclosure has them before anyone reaches for it.
  const openEntryId =
    selected?.id ??
    simpleEditor?.entry?.id ??
    (editor && editor.version > 0 ? editor.id : null);
  useEffect(() => {
    if (!openEntryId || demo) return;
    void loadEvidenceChunk();
    void cache
      .read({ view: "evidence", entry: openEntryId })
      .catch(() => undefined);
  }, [openEntryId, demo, cache]);

  async function refreshTransactionBooks(command?: WorkflowCommand) {
    // Every page of the ledger and every report is out of date; the screens
    // showing them keep their rows while the fresh ones load.
    cache.dropWhere((q) => q.view !== "manage" && q.view !== "feeds");
    // New payees are the exceptional transaction edit that changes shared metadata.
    if (
      command &&
      "context" in command &&
      command.context?.payee_id &&
      !manage.parties.some((party) => party.id === command.context?.payee_id)
    )
      cache.drop({ view: "manage" });
    if (balanceTimer.current) clearTimeout(balanceTimer.current);
    balanceRequest.current?.abort();
    // Coalesce rapid row edits; neither the save nor the next row waits for reports.
    balanceTimer.current = setTimeout(() => {
      const controller = new AbortController();
      balanceRequest.current = controller;
      void cache
        .read<Workspace>({ from: data.from, to: data.to }, controller.signal, {
          fresh: true,
        })
        .then((next) => {
          if (controller.signal.aborted) return;
          setData(next);
          window.dispatchEvent(new Event("accounting-refreshed"));
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          toast(
            "error",
            "Saved. Summary totals could not refresh; reload the page to update them.",
          );
        });
    }, 350);
  }

  const range = `from=${data.from}&to=${data.to}`;
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  async function refreshBooks() {
    if (balanceTimer.current) clearTimeout(balanceTimer.current);
    balanceRequest.current?.abort();
    cache.dropWhere(() => true);
    const [next] = await Promise.all([
      cache.read<Workspace>({ from: data.from, to: data.to }, undefined, {
        fresh: true,
      }),
      cache
        .read<BooksMetadata>({ view: "manage" }, undefined, { fresh: true })
        .catch(() => null),
      cache
        .read<FeedData>({ view: "feeds" }, undefined, { fresh: true })
        .catch(() => null),
    ]);
    setData(next);
    setSelected(null);
    // The sidebar's review badge follows the books.
    window.dispatchEvent(new Event("accounting-refreshed"));
  }

  // Navigation can also come from the sidebar, so filters that only make
  // sense on Transactions reset whenever another screen is open.
  useEffect(() => {
    if (view !== "journal") {
      setRegisterFilter(null);
      setAccountFilter("");
    }
  }, [view]);
  const cmd = useAccountingCommand(refreshBooks);
  const detailCommand = useAccountingCommand(refreshTransactionBooks);

  // Sync on open: when the books report the newest feed run is stale, run
  // each due connection in the background, the same way Sync now does, and
  // refresh once new activity has landed.
  useEffect(() => {
    if (demo || !data.sync_due || syncRequested.current) return;
    syncRequested.current = true;
    setSyncing(true);
    (async () => {
      const feeds = await cache.read<FeedData>({ view: "feeds" });
      // Only a connection with at least one mapped account can sync; the
      // Overview explains the mapping step for the rest.
      const mapped = new Set(
        feeds.identities
          .filter((i) => i.feed_account_id)
          .map((i) => i.connection_id),
      );
      let synced = false;
      let blocked = "";
      for (const connection of feeds.connections.filter(
        (c) => feedSyncDue(c) && mapped.has(c.id),
      )) {
        const response = await fetch("/api/accounting/feeds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync", id: connection.id }),
        });
        if (response.ok) synced = true;
        else if (!blocked) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          blocked = body.error ?? "";
        }
      }
      if (synced) await refreshBooks();
      else if (blocked) {
        // Once per session: the Overview keeps showing the state after this.
        const seen = `accounting.sync-blocked:${blocked}`;
        let shown = false;
        try {
          shown = sessionStorage.getItem(seen) === "1";
          sessionStorage.setItem(seen, "1");
        } catch {
          /* Private mode: fall back to showing it. */
        }
        if (!shown) toast("error", blocked);
      }
    })()
      .catch(() => {
        /* The next visit tries again. */
      })
      .finally(() => setSyncing(false));
    // refreshBooks reads the current range; the effect keys on the flag only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, data.sync_due]);

  async function mutate(command: WorkflowCommand) {
    if (demo) return false;
    setError("");
    const ok = await cmd.execute(command);
    if (!ok) setError(cmd.lastError.current || "Unable to save the change.");
    return !!ok;
  }

  async function openEntry(id: string, known?: JournalEntry) {
    const request = ++entryRequest.current;
    const loaded = known ?? data.entries.find((e) => e.id === id);
    if (loaded || demo) {
      setSelected(loaded ?? null);
      return;
    }
    setOpening(true);
    try {
      const result = await cache.read<{ entries: JournalEntry[] }>(
        registerQuery({ entry_id: id }),
      );
      if (request === entryRequest.current)
        setSelected(result.entries[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load entry.");
    } finally {
      if (request === entryRequest.current) setOpening(false);
    }
  }

  async function openEditor(entry?: JournalEntry, copy = false) {
    setError("");
    try {
      // The loaded entry carries an expected_version; the server rejects stale edits.
      entryRequest.current++;
      setSelected(null);
      setEditor(makeEditor(data.to, entry, copy));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open this entry.");
    }
  }

  /** A posted entry is never edited in place: the journal editor opens a replacement that reverses it. */
  function openCorrection(entry: JournalEntry) {
    setEditor({
      ...makeEditor(data.to, entry, true),
      corrects: entry,
      correctionReason: "",
      date: entry.entry_date,
      reversalDate: entry.entry_date,
    });
    setSelected(null);
  }

  /** A note typed before the entry existed goes in right after the save gives it an id. */
  async function saveEditorNote(current: Editor) {
    const note = current.note?.trim();
    if (!note) return;
    await mutate({
      type: "entry.annotate",
      id: crypto.randomUUID(),
      entry_id: current.id,
      note,
    });
  }

  async function saveDraft() {
    if (!editor) return;
    try {
      const lines = editor.lines
        .filter((l) => l.account || l.debit || l.credit || l.memo)
        .map((l) => {
          if (!l.account)
            throw new Error("Choose an account for every amount.");
          const amount =
            (l.debit ? parseUsd(l.debit) : ZERO) -
            (l.credit ? parseUsd(l.credit) : ZERO);
          if (amount === ZERO)
            throw new Error("Each saved line needs a nonzero amount.");
          return {
            account_id: l.account,
            amount_cents: amount.toString(),
            memo: l.memo,
          };
        });
      if (editor.corrects) {
        const total = lines.reduce((s, l) => s + BigInt(l.amount_cents), ZERO);
        if (total !== ZERO || lines.length < 2)
          throw new Error("The replacement needs at least two balanced lines.");
        setReplacementReview({
          type: "entry.correct",
          id: editor.corrects.id,
          expected_version: editor.corrects.version,
          replacement_id: editor.id,
          entry_date: editor.date,
          reversal_date: editor.reversalDate ?? editor.corrects.entry_date,
          memo: editor.memo,
          reason: editor.correctionReason ?? "",
          lines,
        });
        return;
      }
      if (
        await mutate({
          type: "transaction.save",
          id: editor.id,
          expected_version: editor.version,
          entry_date: editor.date,
          memo: editor.memo,
          lines,
          context: editor.context,
        })
      ) {
        await saveEditorNote(editor);
        setEditor(null);
        setView("journal");
        toast("success", "Draft saved.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the journal entry.");
    }
  }

  /** Both legs of a transfer reverse together, so the row opens the group's dialog. */
  async function openReverseTransfer(groupId: string) {
    try {
      const view = await accountingGet<TransfersView>({
        view: "transfers",
        from: data.from,
        to: data.to,
        id: groupId,
      });
      const group = view.groups[0];
      if (!group) throw new Error("This transfer is no longer in the books.");
      setError("");
      setReverseTransfer(group);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open transfer.");
    }
  }

  async function transactionAction(
    action: TransactionAction,
    entry: JournalEntry,
  ) {
    if (action === "detail" || action === "journal" || demo) {
      await openEntry(entry.id, entry);
      return;
    }
    if (action === "reverse" && entry.payroll_run_id) {
      setSelected(null);
      setView("payroll");
      return;
    }
    if (action === "reverse" && entry.transfer_group_id) {
      setSelected(null);
      await openReverseTransfer(entry.transfer_group_id);
      return;
    }
    if (action === "copy") {
      await openEditor(entry, true);
      return;
    }
    if (action === "reverse" || action === "discard" || action === "restore") {
      setApproval({
        entry,
        type:
          action === "restore"
            ? "entry.restore"
            : action === "reverse"
              ? "entry.reverse"
              : "draft.discard",
      });
      setError("");
      return;
    }
    try {
      entryRequest.current++;
      if (presentTransaction(entry, manage.profiles).editable)
        setSimpleEditor({ entry });
      else if (entry.status === "draft") await openEditor(entry);
      else await openEntry(entry.id, entry);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open transaction.");
    }
  }

  const transactionAddMenu = (
    <Menu.Root>
      <Menu.Trigger asChild id="accounting-add-transaction">
        <Button disabled={demo}>
          <Plus size={16} aria-hidden="true" />
          Add transaction
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={8}
          className="z-[70] min-w-56 rounded-xl border border-border bg-popover p-1.5 shadow-[var(--shadow-overlay)] animate-in fade-in-0 zoom-in-95"
        >
          {[
            {
              label: "Deposit",
              icon: ArrowDownLeft,
              run: () => setSimpleEditor({ direction: "in" }),
            },
            {
              label: "Withdrawal",
              icon: ArrowUpRight,
              run: () => setSimpleEditor({ direction: "out" }),
            },
            // Transfers and payroll have their own homes: the ledger row and the Payroll page.
            {
              label: "Journal entry",
              icon: BookOpen,
              run: () => void openEditor(),
            },
          ].map((item) => (
            <Menu.Item
              key={item.label}
              onSelect={item.run}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-secondary"
            >
              <item.icon size={15} aria-hidden="true" />
              {item.label}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );

  const shownError = error || manageRead.error;

  // The loader takes the whole viewport while a screen is on its way. On the
  // first visit nothing renders behind it until it starts to leave; the page
  // then mounts under the dissolve and is complete when the overlay clears.
  const overlay = !boot.active && phase !== "done" && (
    <AccountingLoading
      continuing={!booted}
      steps={booted ? [VIEW_STEPS[view]] : BOOT_STEPS}
      step={booted ? 0 : gate.step}
      announcement={booted ? VIEW_STEPS[view] : "Loading the books"}
      leaving={phase === "leaving"}
      onLeft={onLeft}
    />
  );
  // Nothing renders behind a loader on the first load; the page mounts as
  // the loader starts to leave, or under the boot screen as soon as it is ready.
  const ready = boot.active ? gate.ready : phase !== "loading";
  if (!booted && !ready) return overlay || null;

  return (
    <>
      {overlay}
      <AccountingBankIdentityProvider
        feeds={feeds}
        profiles={manage.profiles}
        className="space-y-5 lg:space-y-6"
      >
        <PageHeader
          title="Accounting"
          subtitle={
            demo
              ? "Synthetic company, read-only demonstration"
              : data.legal_name
          }
          actions={
            syncing ? (
              <p
                role="status"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <RefreshCw
                  size={13}
                  aria-hidden="true"
                  className="animate-spin"
                />
                Syncing bank feeds
              </p>
            ) : undefined
          }
        />

        <SetupGuide
          year={Number(today.slice(0, 4))}
          enabled={!demo}
          onApplied={() => void refreshBooks()}
        />

        {(testing || demo) && (
          <p className="glass-card rounded-xl bg-[rgba(var(--ink),0.03)] px-3 py-2 text-xs text-muted-foreground">
            {testing
              ? "Isolated test books. All entries on this server are synthetic."
              : "Demo transactions are synthetic. Real books show your own accounts here."}
          </p>
        )}
        {shownError && !editor && !replacementReview && !approval && (
          <p
            role="alert"
            className="rounded-lg border border-error/30 bg-error/5 p-3 text-sm text-error"
          >
            {shownError}
          </p>
        )}

        {ready && (
          <>
            {view === "overview" && Overview && (
              <Overview
                data={data}
                manage={manage}
                feeds={feeds}
                metadataLoading={!manageLoaded}
                demo={demo}
                onIntent={(next) => void warmAccountingView(next, ctx, cache)}
                onReview={() => {
                  setRegisterFilter({ status: "draft" });
                  setAccountFilter("");
                  setListKey((k) => k + 1);
                  setView("journal");
                }}
                onTransactions={() => setView("journal")}
                onAccounts={() => setView("accounts")}
                onFeeds={() => setView("manage", "feeds")}
                onMonthEnd={() => setView("close")}
                onReport={(id) => setView("reports", undefined, { report: id })}
                onEntry={(entry) =>
                  void transactionAction(
                    entry.status === "draft" ? "edit" : "detail",
                    entry,
                  )
                }
                onAdd={(direction) => setSimpleEditor({ direction })}
              />
            )}
            {view === "journal" && (
              <AccountingTransactions
                key={ledgerKey}
                data={data}
                manage={manage}
                metadataLoading={!manageLoaded}
                demo={demo}
                initialFilter={ledgerFilter}
                onRefresh={refreshBooks}
                onTransactionSaved={refreshTransactionBooks}
                actions={transactionAddMenu}
                onAction={(action, entry) =>
                  void transactionAction(action, entry)
                }
              />
            )}
            {view === "accounts" && Accounts && (
              <Accounts
                data={data}
                profiles={manage.profiles}
                demo={demo}
                onRefresh={refreshBooks}
                onAdd={() => setAddAccount(true)}
                onFeeds={() => setView("manage", "feeds")}
                onEntry={(id) => void openEntry(id)}
              />
            )}
            {view === "close" && !demo && Close && (
              <Close
                date={data.to}
                onRefresh={refreshBooks}
                onEntry={openEntry}
                onAccounts={() => setView("accounts")}
                onTransactions={() => setView("journal")}
                onImports={() => setView("manage", "imports")}
              />
            )}
            {view === "payroll" && Payroll && (
              <Payroll
                accounts={data.accounts}
                manage={manage}
                today={today}
                demo={demo}
                onRefresh={refreshBooks}
                onEntry={(id) => void openEntry(id)}
              />
            )}
            {view === "manage" && More && (
              <More
                initialSection={params.get("section") ?? undefined}
                data={data}
                manage={manage}
                demo={demo}
                onRefresh={refreshBooks}
                onEntry={openEntry}
                onFilter={(filter) => {
                  setRegisterFilter(filter);
                  setAccountFilter("");
                  setListKey((k) => k + 1);
                  setView("journal");
                }}
              />
            )}
            {view === "reports" && Reports && (
              <Reports
                accounts={data.accounts}
                from={data.from}
                to={data.to}
                revision={data.revision}
                manage={manage}
                onEntry={openEntry}
                demo={demo}
              />
            )}
          </>
        )}

        {simpleEditor && (
          <AccountingTransactionEditor
            entry={simpleEditor.entry}
            initialDirection={simpleEditor.direction}
            date={data.to}
            accounts={data.accounts}
            manage={manage}
            onClose={() => setSimpleEditor(null)}
            onSaved={refreshTransactionBooks}
            onJournal={() => {
              const e = simpleEditor.entry;
              setSimpleEditor(null);
              // The same escape hatch for every state: a posted entry lands in the correction mode.
              if (e?.status === "posted") openCorrection(e);
              else void openEditor(e);
            }}
          />
        )}

        <EntryDetailDialog
          entry={selected}
          opening={opening}
          accounts={accountMap}
          parties={manage.parties}
          demo={demo}
          range={range}
          busy={detailCommand.busy}
          error={detailCommand.error}
          canReview={
            !!selected &&
            presentTransaction(selected, manage.profiles).categorized
          }
          onClose={() => {
            entryRequest.current++;
            setSelected(null);
            setOpening(false);
            detailCommand.setError("");
          }}
          onEdit={(e) => {
            setSelected(null);
            void transactionAction("edit", e);
          }}
          onPost={async (e) => {
            const reviewed = !isTransactionReviewed(e);
            const saved = await detailCommand.execute({
              type: "entry.review",
              id: e.id,
              expected_version: e.version,
              reviewed,
            });
            if (saved) {
              setSelected((current) =>
                current?.id === e.id
                  ? {
                      ...current,
                      status: "posted",
                      review_pending: !reviewed,
                      version: saved.version ?? e.version + 1,
                    }
                  : current,
              );
              toast(
                "success",
                reviewed ? "Transaction reviewed." : "Marked as unreviewed.",
              );
            }
          }}
          onDiscard={(e) => {
            setApproval({ entry: e, type: "draft.discard" });
            setSelected(null);
          }}
          onRestore={(e) => {
            setApproval({ entry: e, type: "entry.restore" });
            setSelected(null);
          }}
          onReverse={(e) => {
            if (e.payroll_run_id) {
              setSelected(null);
              setView("payroll");
              return;
            }
            if (e.transfer_group_id) {
              setSelected(null);
              void openReverseTransfer(e.transfer_group_id);
              return;
            }
            setApproval({ entry: e, type: "entry.reverse" });
            setSelected(null);
          }}
          onCopy={(e) => void openEditor(e, true)}
          onCorrect={openCorrection}
        />

        <JournalEditorDialog
          editor={replacementReview ? null : editor}
          setEditor={setEditor}
          accounts={data.accounts}
          manage={manage}
          busy={cmd.busy}
          error={error}
          onSave={() => void saveDraft()}
          onClose={() => setEditor(null)}
        />

        <ReplacementReviewDialog
          review={replacementReview}
          original={editor?.corrects ?? null}
          accounts={accountMap}
          busy={cmd.busy}
          error={error}
          onBack={() => setReplacementReview(null)}
          onApply={async () => {
            if (replacementReview && (await mutate(replacementReview))) {
              if (editor) await saveEditorNote(editor);
              setReplacementReview(null);
              setEditor(null);
              toast("success", "Correction applied.");
            }
          }}
        />

        <ApprovalDialog
          approval={approval}
          accounts={accountMap}
          busy={cmd.busy}
          error={error}
          defaultDate={data.to}
          onSubmit={mutate}
          onClose={() => setApproval(null)}
        />

        {addAccount && (
          <AccountingAccountCreate
            accounts={data.accounts}
            profiles={manage.profiles}
            onClose={() => setAddAccount(false)}
            onSaved={refreshBooks}
          />
        )}
        {reverseTransfer && (
          <ReverseTransfer
            group={reverseTransfer}
            revision={data.revision}
            onClose={() => setReverseTransfer(null)}
            onSaved={refreshBooks}
          />
        )}
      </AccountingBankIdentityProvider>
    </>
  );
}
