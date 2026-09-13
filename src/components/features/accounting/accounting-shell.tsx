"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { StatCardSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
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
import { registerFilterSchema } from "@/lib/accounting/workflows";
import {
  isTransactionReviewed,
  presentTransaction,
} from "@/lib/accounting/transactions";
import { feedSyncDue, type FeedData } from "@/lib/accounting/feeds";
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
import { createAccountingReadCache } from "@/lib/accounting/read-cache";

const ZERO = BigInt(0);
const loadingView = () => (
  <p role="status" className="p-6 text-sm text-muted-foreground">
    Loading...
  </p>
);
const loadingOverview = () => (
  <div
    role="status"
    aria-label="Loading overview"
    className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-4 lg:gap-4"
  >
    {[0, 1, 2, 3].map((i) => (
      <StatCardSkeleton key={i} />
    ))}
  </div>
);
const AccountingOverview = dynamic(
  () => import("./accounting-overview").then((m) => m.AccountingOverview),
  { loading: loadingOverview },
);
const AccountingReports = dynamic(
  () => import("./accounting-reports").then((m) => m.AccountingReports),
  { loading: loadingView },
);
const AccountingAccounts = dynamic(
  () => import("./accounting-accounts").then((m) => m.AccountingAccounts),
  { loading: loadingView },
);
const AccountingClose = dynamic(
  () => import("./accounting-close").then((m) => m.AccountingClose),
  { loading: loadingView },
);
const AccountingMore = dynamic(
  () => import("./accounting-more").then((m) => m.AccountingMore),
  { loading: loadingView },
);

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
 * Transactions, Accounts, Reports, Records, Settings); this shell renders
 * the one the URL names, owns the add menu and the shared entry dialogs.
 * State lives in the URL (`view`, `section`, `entry`, `report`) so links
 * and the back button keep working.
 */
export function AccountingBooks({
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

  function setView(
    next: View,
    section?: string,
    extra?: Record<string, string>,
  ) {
    if (next !== "journal") {
      setRegisterFilter(null);
      setAccountFilter("");
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    url.searchParams.delete("entry");
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
    for (const [key, value] of Object.entries(extra ?? {}))
      url.searchParams.set(key, value);
    window.history.pushState(null, "", url);
  }

  const [manage, setManage] = useState<BooksMetadata>(() =>
    demo ? demoManage(initial) : EMPTY_MANAGE,
  );
  const [manageLoaded, setManageLoaded] = useState(demo);
  const [error, setError] = useState("");
  const [simpleEditor, setSimpleEditor] = useState<{
    entry?: JournalEntry;
    direction?: "in" | "out";
  } | null>(null);
  const [accountFilter, setAccountFilter] = useState("");
  // Bumped whenever a filter link is applied so the list remounts even when
  // the new filter equals the current one.
  const [listKey, setListKey] = useState(0);
  const [registerFilter, setRegisterFilter] =
    useState<Partial<RegisterFilter> | null>(null);
  const [selected, setSelected] = useState<JournalEntry | null>(
    detailOnly ? (initial.entries[0] ?? null) : null,
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [replacementReview, setReplacementReview] = useState<Extract<
    WorkflowCommand,
    { type: "entry.correct" }
  > | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [addAccount, setAddAccount] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncRequested = useRef(false);
  // Bank feed state drives the notices under the header and the Overview.
  const [feeds, setFeeds] = useState<FeedData | null>(null);
  const [registerCache] = useState(() => createAccountingReadCache());
  const [registerEpoch, setRegisterEpoch] = useState(0);
  const balanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const balanceRequest = useRef<AbortController | null>(null);
  const entryRequest = useRef(0);

  useEffect(
    () => () => {
      if (balanceTimer.current) clearTimeout(balanceTimer.current);
      balanceRequest.current?.abort();
      registerCache.invalidate();
    },
    [registerCache],
  );

  function invalidateRegister() {
    registerCache.invalidate();
    setRegisterEpoch((value) => value + 1);
  }

  async function refreshTransactionBooks(command?: WorkflowCommand) {
    invalidateRegister();
    // New payees are the exceptional transaction edit that changes shared metadata.
    if (
      command &&
      "context" in command &&
      command.context?.payee_id &&
      !manage.parties.some((party) => party.id === command.context?.payee_id)
    ) {
      void accountingGet<BooksMetadata>({ view: "manage" })
        .then(setManage)
        .catch(() => toast("error", "Saved. Reload to update the payee list."));
    }
    if (balanceTimer.current) clearTimeout(balanceTimer.current);
    balanceRequest.current?.abort();
    // Coalesce rapid row edits; neither the save nor the next row waits for reports.
    balanceTimer.current = setTimeout(() => {
      const controller = new AbortController();
      balanceRequest.current = controller;
      void accountingGet<Workspace>(
        { from: data.from, to: data.to },
        controller.signal,
      )
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

  let urlFilter: Partial<RegisterFilter> = {};
  try {
    const parsed = registerFilterSchema.safeParse(
      JSON.parse(params.get("transactions") ?? "{}"),
    );
    if (parsed.success) urlFilter = parsed.data;
  } catch {
    /* Ignore malformed filter links. */
  }

  const range = `from=${data.from}&to=${data.to}`;
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));

  async function refreshBooks() {
    if (balanceTimer.current) clearTimeout(balanceTimer.current);
    balanceRequest.current?.abort();
    invalidateRegister();
    const [next, metadata, feedState] = await Promise.all([
      accountingGet<Workspace>({ from: data.from, to: data.to }),
      accountingGet<BooksMetadata>({ view: "manage" }),
      accountingGet<FeedData>({ view: "feeds" }).catch(() => null),
    ]);
    setData(next);
    setManage(metadata);
    setManageLoaded(true);
    if (feedState) setFeeds(feedState);
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

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    registerCache
      .read<BooksMetadata>({ view: "manage" }, controller.signal)
      .then((value) => {
        setManage(value);
        setManageLoaded(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.name !== "AbortError")
          setError(e.message);
      });
    registerCache
      .read<FeedData>({ view: "feeds" }, controller.signal)
      .then(setFeeds)
      .catch(() => undefined);
    return () => controller.abort();
  }, [demo, initial.revision, registerCache]);

  // Sync on open: when the books report the newest feed run is stale, run
  // each due connection in the background, the same way Sync now does, and
  // refresh once new activity has landed.
  useEffect(() => {
    if (demo || !data.sync_due || syncRequested.current) return;
    syncRequested.current = true;
    setSyncing(true);
    (async () => {
      const feeds = await registerCache.read<FeedData>({ view: "feeds" });
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
    try {
      const result = await registerCache.read<{ entries: JournalEntry[] }>({
        view: "register",
        filter: JSON.stringify({ entry_id: id }),
      });
      if (request === entryRequest.current)
        setSelected(result.entries[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load entry.");
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
        setEditor(null);
        setView("journal");
        toast("success", "Draft saved.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the journal entry.");
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
      setView("records", "payroll");
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
              label: "Money out",
              icon: ArrowUpRight,
              run: () => setSimpleEditor({ direction: "out" }),
            },
            {
              label: "Money in",
              icon: ArrowDownLeft,
              run: () => setSimpleEditor({ direction: "in" }),
            },
            {
              label: "Transfer or card payment",
              icon: ArrowLeftRight,
              run: () => setView("records", "transfers"),
            },
            {
              label: "Payroll records",
              icon: Wallet,
              run: () => setView("records", "payroll"),
            },
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

  return (
    <AccountingBankIdentityProvider
      feeds={feeds}
      profiles={manage.profiles}
      className="space-y-5 lg:space-y-6"
    >
      <PageHeader
        title="Accounting"
        subtitle={
          demo ? "Synthetic company, read-only demonstration" : data.legal_name
        }
      />

      {syncing && (
        <p
          role="status"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <RefreshCw size={13} aria-hidden="true" className="animate-spin" />
          Syncing bank feeds
        </p>
      )}

      <SetupGuide
        year={new Date().getFullYear()}
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
      {error && !editor && !replacementReview && !approval && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/5 p-3 text-sm text-error"
        >
          {error}
        </p>
      )}

      {view === "overview" && (
        <AccountingOverview
          data={data}
          manage={manage}
          feeds={feeds}
          metadataLoading={!manageLoaded}
          demo={demo}
          onReview={() => {
            setRegisterFilter({ status: "draft" });
            setAccountFilter("");
            setListKey((k) => k + 1);
            setView("journal");
          }}
          onTransactions={() => setView("journal")}
          onAccounts={() => setView("accounts")}
          onFeeds={() => setView("settings", "feeds")}
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
          key={`${listKey}:${accountFilter}:${JSON.stringify(registerFilter)}`}
          data={data}
          manage={manage}
          metadataLoading={!manageLoaded}
          demo={demo}
          initialFilter={{
            ...(registerFilter ?? urlFilter),
            ...(accountFilter ? { account: accountFilter } : {}),
          }}
          onRefresh={refreshBooks}
          onTransactionSaved={refreshTransactionBooks}
          registerCache={registerCache}
          registerEpoch={registerEpoch}
          actions={transactionAddMenu}
          onAction={(action, entry) => void transactionAction(action, entry)}
        />
      )}
      {view === "accounts" && (
        <AccountingAccounts
          data={data}
          profiles={manage.profiles}
          demo={demo}
          onRefresh={refreshBooks}
          onAdd={() => setAddAccount(true)}
          onFeeds={() => setView("settings", "feeds")}
          onEntry={(id) => void openEntry(id)}
        />
      )}
      {view === "close" && !demo && (
        <AccountingClose
          date={data.to}
          onRefresh={refreshBooks}
          onEntry={openEntry}
          onAccounts={() => setView("accounts")}
          onTransactions={() => setView("journal")}
          onImports={() => setView("settings", "imports")}
        />
      )}
      {(view === "settings" || view === "records") && (
        <AccountingMore
          key={view}
          scope={view}
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
      {view === "reports" && (
        <AccountingReports
          accounts={data.accounts}
          from={data.from}
          to={data.to}
          revision={data.revision}
          manage={manage}
          onEntry={openEntry}
          onRecords={(section) => setView("records", section)}
          demo={demo}
        />
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
            void openEditor(e);
          }}
        />
      )}

      <EntryDetailDialog
        entry={selected}
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
            setView("records", "payroll");
            return;
          }
          setApproval({ entry: e, type: "entry.reverse" });
          setSelected(null);
        }}
        onCopy={(e) => void openEditor(e, true)}
        onCorrect={(e) => {
          setEditor({
            ...makeEditor(data.to, e, true),
            corrects: e,
            correctionReason: "",
            date: e.entry_date,
            reversalDate: e.entry_date,
          });
          setSelected(null);
        }}
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
    </AccountingBankIdentityProvider>
  );
}
