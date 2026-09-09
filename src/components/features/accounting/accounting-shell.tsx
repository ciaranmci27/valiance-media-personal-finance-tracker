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
  Check,
  ChevronDown,
  Download,
  Plus,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
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
import { presentTransaction } from "@/lib/accounting/transactions";
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
import type { BooksMetadata } from "./types";

const ZERO = BigInt(0);
const loadingView = () => (
  <p role="status" className="p-6 text-sm text-muted-foreground">
    Loading...
  </p>
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

type View = "journal" | "reports" | "accounts" | "close" | "manage";
const VIEWS: { key: View; label: string; demoHidden?: boolean }[] = [
  { key: "journal", label: "Transactions" },
  { key: "reports", label: "Reports" },
  { key: "accounts", label: "Accounts" },
  { key: "close", label: "Month end", demoHidden: true },
  { key: "manage", label: "More" },
];

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

/** One destination in the top navigation. Module level so it keeps focus across re-renders. */
function NavButton({
  item,
  active,
  reviewCount,
  onSelect,
}: {
  item: (typeof VIEWS)[number];
  active: boolean;
  reviewCount: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {item.label}
      {item.key === "journal" && reviewCount > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[11px] font-semibold tabular-nums leading-4",
            active ? "bg-copper/25 text-copper" : "bg-copper/20 text-copper",
          )}
          aria-label={`${reviewCount} to review`}
        >
          {reviewCount}
        </span>
      )}
    </button>
  );
}

/**
 * The accounting workspace: five destinations, one add menu, and the shared
 * entry dialogs. State lives in the URL (`view`, `section`, `entry`) so links
 * and the browser's back button keep working.
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
  const candidate = params.get("view");
  const view: View = VIEWS.some((v) => v.key === candidate)
    ? (candidate as View)
    : "journal";

  function setView(next: View, section?: string) {
    if (next !== "journal") {
      setRegisterFilter(null);
      setAccountFilter("");
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    url.searchParams.delete("entry");
    if (section) url.searchParams.set("section", section);
    else url.searchParams.delete("section");
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
    const [next, metadata] = await Promise.all([
      accountingGet<Workspace>({ from: data.from, to: data.to }),
      accountingGet<BooksMetadata>({ view: "manage" }),
    ]);
    setData(next);
    setManage(metadata);
    setManageLoaded(true);
    setSelected(null);
  }
  const cmd = useAccountingCommand(refreshBooks);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    accountingGet<BooksMetadata>({ view: "manage" }, controller.signal)
      .then((value) => {
        setManage(value);
        setManageLoaded(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [demo, initial.revision]);

  // Sync on open: when the books report the newest feed run is stale, ask
  // for one in the background and refresh when it lands.
  useEffect(() => {
    if (demo || !data.sync_due || syncRequested.current) return;
    syncRequested.current = true;
    setSyncing(true);
    fetch("/api/accounting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: crypto.randomUUID(),
        command: { type: "bank.sync_request" },
      }),
    })
      .then(async (r) => {
        if (r.ok) await refreshBooks();
      })
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

  async function openEntry(id: string) {
    if (demo) {
      setSelected(data.entries.find((e) => e.id === id) ?? null);
      return;
    }
    try {
      const result = await accountingGet<{ entries: JournalEntry[] }>({
        view: "register",
        filter: JSON.stringify({ entry_id: id }),
      });
      setSelected(result.entries[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load entry.");
    }
  }

  async function openEditor(entry?: JournalEntry, copy = false) {
    setError("");
    try {
      if (entry && !demo) {
        const result = await accountingGet<{ entries: JournalEntry[] }>({
          view: "register",
          filter: JSON.stringify({ entry_id: entry.id }),
        });
        entry = result.entries[0];
        if (!entry)
          throw new Error("This entry is unavailable. Refresh the books.");
      }
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
      await openEntry(entry.id);
      return;
    }
    if (action === "copy") {
      await openEditor(entry, true);
      return;
    }
    if (action === "reverse" || action === "discard") {
      setApproval({
        entry,
        type: action === "reverse" ? "entry.reverse" : "draft.discard",
      });
      setError("");
      return;
    }
    try {
      const current = await accountingGet<{ entries: JournalEntry[] }>({
        view: "register",
        filter: JSON.stringify({ entry_id: entry.id }),
      });
      const fresh = current.entries[0];
      if (!fresh)
        throw new Error("This transaction is unavailable. Refresh the books.");
      if (presentTransaction(fresh, manage.profiles).editable)
        setSimpleEditor({ entry: fresh });
      else if (fresh.status === "draft") await openEditor(fresh);
      else await openEntry(fresh.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open transaction.");
    }
  }

  const reviewCount = data.needs_review_count ?? data.draft_count;

  const addMenu = (
    <Menu.Root>
      <Menu.Trigger asChild id="accounting-add-transaction">
        <Button disabled={demo}>
          <Plus size={16} aria-hidden="true" />
          Add
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
              run: () => setView("manage", "transfers"),
            },
            {
              label: "Payroll run",
              icon: Wallet,
              run: () => setView("manage", "payroll"),
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

  const visibleViews = VIEWS.filter((v) => !demo || !v.demoHidden);
  const primaryViews = visibleViews.slice(0, 2);
  const secondaryViews = visibleViews.slice(2);

  return (
    <div className="space-y-5 lg:space-y-6">
      <PageHeader
        title="Accounting"
        subtitle={
          demo ? "Synthetic company, read-only demonstration" : data.legal_name
        }
        actions={addMenu}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <nav
          aria-label="Accounting sections"
          className="grid w-full grid-cols-[1fr_1fr_auto] gap-1 md:hidden"
        >
          {primaryViews.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              active={view === item.key}
              reviewCount={reviewCount}
              onSelect={() => setView(item.key)}
            />
          ))}
          <Menu.Root>
            <Menu.Trigger asChild id="accounting-mobile-views">
              <button
                type="button"
                aria-label="More accounting sections"
                className={cn(
                  "inline-flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  secondaryViews.some((v) => v.key === view)
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {secondaryViews.find((v) => v.key === view)?.label ?? "More"}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                align="end"
                sideOffset={8}
                className="z-[70] min-w-56 rounded-xl border border-border bg-popover p-1.5 shadow-[var(--shadow-overlay)] animate-in fade-in-0 zoom-in-95"
              >
                {secondaryViews.map((item) => (
                  <Menu.Item
                    key={item.key}
                    onSelect={() => setView(item.key)}
                    className="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-3 py-3 text-sm outline-none data-[highlighted]:bg-secondary"
                  >
                    {item.label}
                    {view === item.key && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </nav>
        <nav
          aria-label="Accounting sections"
          className="hidden flex-wrap gap-1 md:flex"
        >
          {visibleViews.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              active={view === item.key}
              reviewCount={reviewCount}
              onSelect={() => setView(item.key)}
            />
          ))}
        </nav>
        <div className="hidden items-center gap-4 sm:flex">
          {syncing && (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <RefreshCw
                size={13}
                aria-hidden="true"
                className="animate-spin"
              />
              Syncing bank feeds
            </span>
          )}
          {!demo && (
            <a
              href="/api/accounting?export=true"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Download size={15} aria-hidden="true" />
              Export books
            </a>
          )}
        </div>
      </div>

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
          onFeeds={() => setView("manage", "feeds")}
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
          onImports={() => setView("manage", "imports")}
        />
      )}
      {view === "manage" && (
        <AccountingMore
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
          onSaved={refreshBooks}
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
        onClose={() => setSelected(null)}
        onEdit={(e) => void openEditor(e)}
        onPost={(e) => {
          setApproval({ entry: e, type: "entry.post" });
          setSelected(null);
        }}
        onDiscard={(e) => {
          setApproval({ entry: e, type: "draft.discard" });
          setSelected(null);
        }}
        onReverse={(e) => {
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
    </div>
  );
}
