"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Download,
  Plus,
  ArrowUpRight,
  Check,
  RotateCcw,
  Copy,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { centsToDecimal, formatCents, parseUsd } from "@/lib/accounting/money";
import type {
  AccountingAccount,
  AccountingWorkspace,
  JournalEntry,
  EntryContext,
} from "@/lib/accounting/contracts";
import type {
  ManageData,
  WorkflowCommand,
  RegisterFilter,
} from "@/lib/accounting/workflows";
import { AccountingRegister } from "./accounting-register";
import { AccountingAccounts } from "./accounting-accounts";
import { AccountingClose } from "./accounting-close";
import { AccountingEvidence } from "./accounting-evidence";
import { AccountingManage } from "./accounting-manage";
import { AccountingContextEditor } from "./accounting-context-editor";
import { accountingGet } from "./use-accounting-command";
import {
  AccountingRetainedPost,
  RetainedReviewFields,
  emptyRetainedReview,
  readRetainedReview,
} from "./accounting-retained-review";

const ZERO = BigInt(0);
const selectStyle =
  "h-10 w-full rounded-lg border border-border bg-input px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
function Money({ value }: { value: string | bigint }) {
  return (
    <MaskedValue
      value={formatCents(value)}
      className="font-mono tabular-nums"
    />
  );
}
type Editor = {
  context: EntryContext;
  corrects?: JournalEntry;
  correctionReason?: string;
  reversalDate?: string;
  id: string;
  version: number;
  date: string;
  memo: string;
  lines: {
    key: string;
    account: string;
    debit: string;
    credit: string;
    memo: string;
  }[];
};
type Approval = {
  entry: JournalEntry;
  type: "entry.post" | "entry.reverse" | "draft.discard";
};

function makeEditor(date: string, entry?: JournalEntry, copy = false): Editor {
  return {
    context: entry?.context
      ? {
          kind: entry.context.kind,
          payee_id: entry.context.payee_id,
          customer_id: entry.context.customer_id,
          project_id: entry.context.project_id,
          business_line_id: entry.context.business_line_id,
          payment_rail: entry.context.payment_rail,
          contractor_treatment: entry.context.contractor_treatment,
          contractor_reason: entry.context.contractor_reason,
        }
      : {
          kind: "manual",
          payment_rail: "unknown",
          contractor_treatment: "unreviewed",
          contractor_reason: "",
        },
    id: copy || !entry ? crypto.randomUUID() : entry.id,
    version: copy ? 0 : (entry?.version ?? 0),
    date: copy ? date : (entry?.entry_date ?? date),
    memo: entry?.memo ?? "",
    lines:
      entry?.lines.map((l) => ({
        key: crypto.randomUUID(),
        account: l.account_id,
        debit:
          BigInt(l.amount_cents) > ZERO ? centsToDecimal(l.amount_cents) : "",
        credit:
          BigInt(l.amount_cents) < ZERO
            ? centsToDecimal(-BigInt(l.amount_cents))
            : "",
        memo: l.memo,
      })) ??
      [0, 1].map(() => ({
        key: crypto.randomUUID(),
        account: "",
        debit: "",
        credit: "",
        memo: "",
      })),
  };
}

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
  const [data, setData] = useState(initial);
  const [view, setView] = useState<
    "overview" | "journal" | "accounts" | "reports" | "manage" | "close"
  >(detailOnly ? "journal" : "overview");
  const [accountFilter, setAccountFilter] = useState("");
  const [registerFilter, setRegisterFilter] = useState<Partial<RegisterFilter>>(
    {},
  );
  const [saveView, setSaveView] = useState<Extract<
    WorkflowCommand,
    { type: "view.save" }
  > | null>(null);
  const [saveTemplate, setSaveTemplate] = useState<Extract<
    WorkflowCommand,
    { type: "template.save" }
  > | null>(null);
  const [manage, setManage] = useState<ManageData>({
    profiles: [],
    parties: [],
    dimensions: [],
    templates: [],
    views: [],
    periods: [],
    preferences: null,
  });
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    accountingGet<ManageData>({ view: "manage" }, controller.signal)
      .then(setManage)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [demo, initial.revision]);
  const [selected, setSelected] = useState<JournalEntry | null>(
    detailOnly ? (initial.entries[0] ?? null) : null,
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [replacementReview, setReplacementReview] = useState<Extract<
    WorkflowCommand,
    { type: "entry.correct" }
  > | null>(null);
  const [addAccount, setAddAccount] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [retainedReplacement, setRetainedReplacement] =
    useState(emptyRetainedReview);
  const retainedAccount = manage.profiles.find(
    (p) => p.purpose === "opening_retained_earnings",
  )?.account_id;
  const retainedApproval =
    approval?.type === "entry.post" &&
    approval.entry.lines.some((l) => l.account_id === retainedAccount)
      ? approval.entry
      : null;
  const replacementUsesRetained = !!replacementReview?.lines.some(
    (l) => l.account_id === retainedAccount,
  );
  const replacementRetainedProof = replacementReview
    ? readRetainedReview(replacementReview.lines, retainedReplacement)
    : null;
  const [reason, setReason] = useState("");
  const [correctionDate, setCorrectionDate] = useState(initial.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const accountId = useRef<string>("");
  const accountMap = new Map(data.accounts.map((a) => [a.id, a]));
  const range = `from=${data.from}&to=${data.to}`;
  async function refreshBooks() {
    const [next, metadata] = await Promise.all([
      accountingGet<AccountingWorkspace>({ from: data.from, to: data.to }),
      accountingGet<ManageData>({ view: "manage" }),
    ]);
    setData(next);
    setManage(metadata);
  }
  async function openEntry(id: string) {
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

  async function mutate(command: WorkflowCommand) {
    if (demo || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify(command);
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await fetch("/api/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: pending.current.key, command }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Unable to save the entry.");
      const refreshed = await fetch(`/api/accounting?${range}`, {
        cache: "no-store",
      });
      const next = await refreshed.json();
      if (!refreshed.ok)
        throw new Error(
          "The change was saved, but the books could not refresh. Retry to retrieve the same result.",
        );
      setData(next);
      setManage(await accountingGet<ManageData>({ view: "manage" }));
      pending.current = null;
      setSelected(null);
      setNotice("Books updated. Reports include posted entries only.");
      return true;
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Connection interrupted. Retry the same action to check its result.",
      );
      return false;
    } finally {
      setBusy(false);
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
  function updateLine(
    key: string,
    field: "account" | "debit" | "credit" | "memo",
    value: string,
  ) {
    setEditor((e) =>
      e
        ? {
            ...e,
            lines: e.lines.map((l) =>
              l.key === key ? { ...l, [field]: value } : l,
            ),
          }
        : e,
    );
  }
  let debit = ZERO,
    credit = ZERO,
    amountError = "";
  if (editor) {
    try {
      for (const l of editor.lines) {
        const d = l.debit ? parseUsd(l.debit) : ZERO;
        const c = l.credit ? parseUsd(l.credit) : ZERO;
        if (d < ZERO || c < ZERO || (d > ZERO && c > ZERO))
          throw new Error("Use one positive debit or credit per line.");
        debit += d;
        credit += c;
      }
    } catch (e) {
      amountError = e instanceof Error ? e.message : "Check the amounts.";
    }
  }
  async function saveDraft() {
    if (!editor) return;
    try {
      if (amountError) throw new Error(amountError);
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
        if (debit !== credit || lines.length < 2)
          throw new Error("The replacement needs at least two balanced lines.");
        setRetainedReplacement(emptyRetainedReview());
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
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the journal entry.");
    }
  }
  const journalAction = (
    <Button disabled={demo} onClick={() => openEditor()}>
      <Plus size={16} />
      New journal entry
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounting"
        subtitle={
          demo ? "Synthetic company · Read-only demonstration" : data.legal_name
        }
        actions={journalAction}
      />
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-3">
        <nav
          aria-label="Accounting views"
          className="flex gap-1 overflow-x-auto"
        >
          {(
            [
              ["overview", "Overview"],
              ["journal", "Transactions"],
              ["accounts", "Accounts"],
              ["reports", "Reports"],
              ["close", "Close books"],
              ["manage", "Manage"],
            ] as const
          )
            .filter(([key]) => !demo || key !== "close")
            .map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                aria-current={view === key ? "page" : undefined}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring",
                  view === key
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
        </nav>
        {!demo && (
          <a
            href="/api/accounting?export=true"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Download size={15} />
            Export books
          </a>
        )}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <form action="/accounting" className="flex flex-wrap items-end gap-2">
          <Input
            type="date"
            label="From"
            name="from"
            defaultValue={data.from}
            disabled={demo}
            required
            className="w-40"
          />
          <Input
            type="date"
            label="Through"
            name="to"
            defaultValue={data.to}
            disabled={demo}
            required
            className="w-40"
          />
          <Button variant="outline" type="submit" disabled={demo}>
            Apply
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Posted reports · {data.draft_count}{" "}
          {data.draft_count === 1 ? "draft" : "drafts"} excluded
        </p>
      </div>
      <div className="rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
        {testing
          ? "Isolated test books. All entries on this server are synthetic."
          : demo
            ? "Demo transactions are synthetic. Change the dates and enter real journals only in your configured books."
            : "Review imported history and complete the close checks before relying on these books as your primary records."}
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 p-3 text-sm text-error"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}

      {view === "overview" && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["Income", data.reports.income_cents],
              ["Expenses", data.reports.expense_cents],
              ["Net income", data.reports.net_income_cents],
            ].map(([label, value]) => (
              <button
                key={label}
                onClick={() => setView("reports")}
                className="glass-card p-5 text-left group focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex justify-between text-sm text-muted-foreground">
                  {label}
                  <ArrowUpRight
                    size={16}
                    className="opacity-50 group-hover:opacity-100"
                  />
                </div>
                <div className="mt-3 text-2xl tracking-tight">
                  <Money value={value} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Posted in selected period
                </p>
              </button>
            ))}
          </div>
          <div className="glass-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border p-5">
              <h2 className="font-semibold">Recent entries</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setView("journal")}
              >
                View journal <ArrowUpRight size={14} />
              </Button>
            </div>
            {data.entries.length ? (
              data.entries
                .slice(0, 6)
                .map((e) => (
                  <EntryRow
                    key={e.id}
                    entry={e}
                    onSelect={() => setSelected(e)}
                  />
                ))
            ) : (
              <Empty
                onAdd={() => openEditor()}
                disabled={demo}
                title="Your books start here"
                description="Add the chart of accounts, then record an opening balance or a manual journal."
              />
            )}
          </div>
        </>
      )}

      {view === "journal" && (
        <AccountingRegister
          key={accountFilter + JSON.stringify(registerFilter)}
          from={data.from}
          to={data.to}
          accounts={data.accounts}
          initialAccount={accountFilter}
          initialFilter={registerFilter}
          manage={manage}
          onRefresh={refreshBooks}
          onSaveView={
            demo
              ? undefined
              : (filter) => {
                  const filters = { ...filter };
                  delete filters.offset;
                  delete filters.limit;
                  setSaveView({
                    type: "view.save",
                    id: crypto.randomUUID(),
                    expected_version: 0,
                    name: "",
                    filters: { ...filters, status: filters.status ?? "all" },
                  });
                }
          }
          onUseView={(filter) => {
            setRegisterFilter(filter);
            setAccountFilter("");
          }}
          revision={data.revision}
          onSelect={setSelected}
          demoEntries={demo ? data.entries : undefined}
        />
      )}
      {view === "accounts" && (
        <AccountingAccounts
          data={data}
          profiles={manage.profiles}
          demo={demo}
          onRefresh={refreshBooks}
          onAdd={() => {
            accountId.current = crypto.randomUUID();
            setAddAccount(true);
          }}
          onEntry={(id) => {
            void openEntry(id);
          }}
        />
      )}
      {view === "close" && !demo && (
        <AccountingClose
          date={data.to}
          onRefresh={refreshBooks}
          onEntry={openEntry}
          onAccounts={() => setView("accounts")}
          onTransactions={() => setView("journal")}
          onImports={() => setView("manage")}
        />
      )}

      {view === "manage" && (
        <AccountingManage
          data={data}
          manage={manage}
          demo={demo}
          onRefresh={refreshBooks}
          onEntry={openEntry}
          onFilter={(filter) => {
            setRegisterFilter(filter);
            setAccountFilter("");
            setView("journal");
          }}
          onTemplate={(template) => {
            const edit = makeEditor(data.to);
            edit.memo = template.memo;
            edit.lines = template.lines.map((l) => ({
              key: crypto.randomUUID(),
              account: l.account_id,
              debit:
                BigInt(l.amount_cents) > ZERO
                  ? centsToDecimal(l.amount_cents)
                  : "",
              credit:
                BigInt(l.amount_cents) < ZERO
                  ? centsToDecimal(-BigInt(l.amount_cents))
                  : "",
              memo: l.memo,
            }));
            setEditor(edit);
          }}
        />
      )}
      {view === "reports" && (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <ReportPanel
              title="Profit and loss"
              rows={[
                ["Income", data.reports.income_cents],
                ["Expenses", data.reports.expense_cents],
                ["Net income", data.reports.net_income_cents],
              ]}
            />
            <ReportPanel
              title={`Balance sheet · ${data.to}`}
              rows={[
                ["Assets", data.reports.assets_cents],
                ["Liabilities", data.reports.liabilities_cents],
                ["Equity account balances", data.reports.equity_cents],
                ["Prior years' net income", data.reports.retained_cents],
                ["Current-year net income", data.reports.year_income_cents],
                ["Balance difference", data.reports.balance_difference_cents],
              ]}
            />
          </div>
          <div className="glass-card overflow-hidden">
            <div className="border-b border-border p-5">
              <h2 className="font-semibold">Trial balance</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Signed opening and ending balances: debit positive, credit
                negative. Select an account to inspect its journal entries.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    {["Account", "Opening", "Debits", "Credits", "Ending"].map(
                      (h, i) => (
                        <th
                          key={h}
                          className={cn(
                            "p-4 font-medium",
                            i ? "text-right" : "text-left",
                          )}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.balances.map((a) => (
                    <tr key={a.id} className="border-b border-border">
                      <td className="p-4">
                        <button
                          onClick={() => {
                            setAccountFilter(a.id);
                            setView("journal");
                          }}
                          className="text-left hover:text-teal-light"
                        >
                          {a.name}
                        </button>
                      </td>
                      {[
                        a.opening_cents,
                        a.debit_cents,
                        a.credit_cents,
                        a.ending_cents,
                      ].map((n, i) => (
                        <td
                          key={i}
                          className="p-4 text-right whitespace-nowrap"
                        >
                          <Money value={n} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="p-4 text-xs text-muted-foreground">
              Ledger balance difference:{" "}
              <Money value={data.reports.trial_balance_cents} />. This checks
              arithmetic, not statement reconciliation or historical
              completeness.
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selected?.memo}</DialogTitle>
            <DialogDescription>
              {selected?.entry_date} · {selected?.status} · Source:{" "}
              {selected?.primary_origin}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <div className="divide-y divide-border">
                {selected.lines.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-center justify-between gap-3 py-3 text-sm"
                  >
                    <span>
                      {accountMap.get(l.account_id)?.name ?? "Account"}
                      {l.memo && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {l.memo}
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap">
                      <Money
                        value={
                          BigInt(l.amount_cents) < ZERO
                            ? -BigInt(l.amount_cents)
                            : l.amount_cents
                        }
                      />{" "}
                      {BigInt(l.amount_cents) > ZERO ? "Dr" : "Cr"}
                    </span>
                  </div>
                ))}
              </div>
              {selected.reverses_entry_id && (
                <p className="text-xs text-muted-foreground">
                  This reverses an earlier entry.{" "}
                  <Link
                    className="text-teal-light"
                    href={`/accounting?${range}&entry=${selected.reverses_entry_id}`}
                  >
                    View original entry
                  </Link>
                  .
                </p>
              )}
              {selected.reversed_by_entry_id && (
                <p className="text-xs text-muted-foreground">
                  This entry has been reversed.{" "}
                  <Link
                    className="text-teal-light"
                    href={`/accounting?${range}&entry=${selected.reversed_by_entry_id}`}
                  >
                    View reversal
                  </Link>
                  . Both entries remain in the books.
                </p>
              )}
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {selected.status === "draft" && (
                  <>
                    <Button
                      disabled={demo}
                      onClick={() => openEditor(selected)}
                    >
                      Edit draft
                    </Button>
                    <Button
                      disabled={demo}
                      variant="outline"
                      onClick={() => {
                        setApproval({ entry: selected, type: "entry.post" });
                        setError("");
                        setSelected(null);
                      }}
                    >
                      <Check size={15} />
                      Review posting
                    </Button>
                    <Button
                      disabled={demo}
                      variant="ghost"
                      onClick={() => {
                        setApproval({ entry: selected, type: "draft.discard" });
                        setReason("");
                        setSelected(null);
                      }}
                    >
                      Discard draft
                    </Button>
                  </>
                )}
                {selected.status === "posted" &&
                  !selected.reversed_by_entry_id && (
                    <Button
                      disabled={demo}
                      variant="outline"
                      onClick={() => {
                        setApproval({ entry: selected, type: "entry.reverse" });
                        setReason("");
                        setCorrectionDate(data.to);
                        setError("");
                        setSelected(null);
                      }}
                    >
                      <RotateCcw size={14} />
                      Reverse entry
                    </Button>
                  )}
                <Button
                  disabled={demo}
                  variant="ghost"
                  onClick={() => openEditor(selected, true)}
                >
                  <Copy size={14} />
                  Copy as draft
                </Button>
                <Button
                  disabled={
                    demo ||
                    selected.lines.length < 2 ||
                    selected.lines.reduce(
                      (s, l) => s + BigInt(l.amount_cents),
                      ZERO,
                    ) !== ZERO
                  }
                  variant="ghost"
                  onClick={() => {
                    setSaveTemplate({
                      type: "template.save",
                      id: crypto.randomUUID(),
                      expected_version: 0,
                      name: "",
                      memo: selected.memo,
                      lines: selected.lines.map((l) => ({
                        account_id: l.account_id,
                        amount_cents: l.amount_cents,
                        memo: l.memo,
                      })),
                      is_archived: false,
                    });
                    setSelected(null);
                  }}
                >
                  Save as template
                </Button>
                {selected.status === "posted" &&
                  !selected.reversed_by_entry_id && (
                    <Button
                      variant="ghost"
                      disabled={demo}
                      onClick={() => {
                        setEditor({
                          ...makeEditor(data.to, selected, true),
                          corrects: selected,
                          correctionReason: "",
                          date: selected.entry_date,
                          reversalDate: selected.entry_date,
                        });
                        setSelected(null);
                        setError("");
                      }}
                    >
                      Correct & replace
                    </Button>
                  )}
                {!demo && (
                  <Link
                    className="self-center text-sm text-teal-light"
                    href={`/accounting?${range}&entry=${selected.id}`}
                  >
                    Open entry link
                  </Link>
                )}
              </div>
              {!demo && (
                <AccountingEvidence
                  entryId={selected.id}
                  accounts={data.accounts}
                  parties={manage.parties}
                />
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={editor !== null && replacementReview === null}
        onOpenChange={(open) => {
          if (
            !open &&
            !busy &&
            window.confirm("Discard unsaved journal changes?")
          )
            setEditor(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editor?.corrects
                ? "Prepare replacement"
                : editor?.version
                  ? "Edit journal draft"
                  : "New journal entry"}
            </DialogTitle>
            <DialogDescription>
              {editor?.corrects
                ? "Review the replacement before applying. The original, its reversal, and the corrected entry will stay linked."
                : "Save a draft first. Posting requires a separate review and balanced debits and credits."}
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveDraft();
              }}
              className="space-y-4"
            >
              <Input
                label="Accounting date"
                type="date"
                required
                value={editor.date}
                onChange={(e) => setEditor({ ...editor, date: e.target.value })}
              />
              <Input
                label="Memo"
                required
                maxLength={1000}
                placeholder="What does this entry record?"
                value={editor.memo}
                onChange={(e) => setEditor({ ...editor, memo: e.target.value })}
              />
              {editor.corrects && (
                <div className="space-y-3">
                  <Input
                    label="Reverse original on"
                    type="date"
                    required
                    value={editor.reversalDate ?? editor.corrects.entry_date}
                    onChange={(e) =>
                      setEditor({ ...editor, reversalDate: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    To fix a misdated entry, reverse it on its original date and
                    use the correct accounting date for the replacement. For a
                    current-period adjustment, choose open dates for both.
                  </p>
                  <Input
                    label="Correction reason"
                    required
                    maxLength={1000}
                    value={editor.correctionReason ?? ""}
                    onChange={(e) =>
                      setEditor({ ...editor, correctionReason: e.target.value })
                    }
                  />
                </div>
              )}
              {!editor.corrects && (
                <AccountingContextEditor
                  value={editor.context}
                  manage={manage}
                  onChange={(context) => setEditor({ ...editor, context })}
                />
              )}
              <div className="space-y-3">
                {editor.lines.map((l, index) => (
                  <div
                    key={l.key}
                    className="grid grid-cols-[1fr_1fr_auto] gap-2 border-b border-border pb-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
                  >
                    <label className="col-span-3 text-xs text-muted-foreground sm:col-span-1">
                      Account {index + 1}
                      <select
                        className={`${selectStyle} mt-1`}
                        value={l.account}
                        onChange={(e) =>
                          updateLine(l.key, "account", e.target.value)
                        }
                      >
                        <option value="">Choose account</option>
                        {data.accounts
                          .filter((a) => !a.is_archived)
                          .map((a) => (
                            <option value={a.id} key={a.id}>
                              {a.code} {a.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Debit
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        className="mt-1 font-mono"
                        value={l.debit}
                        onChange={(e) =>
                          updateLine(l.key, "debit", e.target.value)
                        }
                      />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Credit
                      <Input
                        inputMode="decimal"
                        placeholder="0.00"
                        className="mt-1 font-mono"
                        value={l.credit}
                        onChange={(e) =>
                          updateLine(l.key, "credit", e.target.value)
                        }
                      />
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="self-end"
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() =>
                        setEditor({
                          ...editor,
                          lines: editor.lines.filter(
                            (row) => row.key !== l.key,
                          ),
                        })
                      }
                    >
                      <X size={15} />
                    </Button>
                    <Input
                      aria-label={`Line ${index + 1} memo`}
                      placeholder="Line memo (optional)"
                      maxLength={500}
                      className="col-span-3 sm:col-span-4"
                      value={l.memo}
                      onChange={(e) =>
                        updateLine(l.key, "memo", e.target.value)
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={editor.lines.length >= 100}
                  onClick={() =>
                    setEditor({
                      ...editor,
                      lines: [
                        ...editor.lines,
                        {
                          key: crypto.randomUUID(),
                          account: "",
                          debit: "",
                          credit: "",
                          memo: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={15} />
                  Add line
                </Button>
                <p
                  className={cn(
                    "text-sm",
                    debit === credit ? "text-muted-foreground" : "text-warning",
                  )}
                >
                  {amountError || (
                    <>
                      Difference: <Money value={debit - credit} />
                    </>
                  )}
                </p>
              </div>
              {error && (
                <p role="alert" className="text-sm text-error">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Discard unsaved journal changes?"))
                      setEditor(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={busy || Boolean(amountError)}
                  loading={busy}
                >
                  {editor.corrects ? "Review correction" : "Save draft"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={addAccount}
        onOpenChange={(open) => {
          if (!busy) setAddAccount(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add account</DialogTitle>
            <DialogDescription>
              Create a ledger category. Choose the normal side explicitly for
              contra accounts.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              const type = String(
                values.get("account_type"),
              ) as AccountingAccount["account_type"];
              if (
                await mutate({
                  type: "account.create",
                  id: accountId.current,
                  code: String(values.get("code")),
                  name: String(values.get("name")),
                  account_type: type,
                  normal_side: String(values.get("normal_side")) as
                    | "debit"
                    | "credit",
                })
              )
                setAddAccount(false);
            }}
          >
            <Input label="Account name" name="name" required maxLength={120} />
            <Input label="Account code (optional)" name="code" maxLength={20} />
            <label className="block text-sm">
              Type
              <select name="account_type" className={`${selectStyle} mt-1`}>
                {["asset", "liability", "equity", "income", "expense"].map(
                  (t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="block text-sm">
              Normal balance
              <select name="normal_side" className={`${selectStyle} mt-1`}>
                <option value="debit">
                  Debit (usually assets and expenses)
                </option>
                <option value="credit">
                  Credit (usually liabilities, equity and income)
                </option>
              </select>
            </label>
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <Button type="submit" loading={busy} disabled={busy}>
              Create account
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {retainedApproval && (
        <AccountingRetainedPost
          key={retainedApproval.id}
          entry={retainedApproval}
          accounts={data.accounts}
          busy={busy}
          error={error}
          onClose={() => setApproval(null)}
          onSubmit={mutate}
        />
      )}
      <Dialog
        open={approval !== null && !retainedApproval}
        onOpenChange={(open) => {
          if (!open && !busy) setApproval(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {approval?.type === "entry.post"
                ? "Post this entry?"
                : approval?.type === "entry.reverse"
                  ? "Reverse this entry"
                  : "Discard this draft"}
            </DialogTitle>
            <DialogDescription>
              {approval?.entry.memo}.{" "}
              {approval?.type === "entry.post"
                ? "This makes the financial lines immutable and includes them in reports."
                : approval?.type === "entry.reverse"
                  ? "An equal and opposite posted entry will be created. The original remains in the books."
                  : "The draft remains in the audit history and is excluded from the active journal."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!approval) return;
              const common = {
                id: approval.entry.id,
                expected_version: approval.entry.version,
              };
              const command: WorkflowCommand =
                approval.type === "entry.post"
                  ? { ...common, type: "entry.post" }
                  : approval.type === "entry.reverse"
                    ? {
                        ...common,
                        type: "entry.reverse",
                        entry_date: correctionDate,
                        reason,
                      }
                    : { ...common, type: "draft.discard", reason };
              if (await mutate(command)) setApproval(null);
            }}
          >
            {approval?.entry.lines.map((l) => (
              <div key={l.id} className="flex justify-between gap-3 text-sm">
                <span>{accountMap.get(l.account_id)?.name}</span>
                <span>
                  <Money
                    value={
                      approval.type === "entry.reverse"
                        ? -BigInt(l.amount_cents)
                        : l.amount_cents
                    }
                  />
                </span>
              </div>
            ))}
            {approval?.type === "entry.reverse" && (
              <Input
                label="Correction date"
                type="date"
                required
                value={correctionDate}
                onChange={(e) => setCorrectionDate(e.target.value)}
              />
            )}
            {approval?.type !== "entry.post" && (
              <Input
                label="Reason"
                required
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <Button type="submit" loading={busy} disabled={busy}>
              {approval?.type === "entry.post"
                ? "Post entry"
                : approval?.type === "entry.reverse"
                  ? "Create reversal"
                  : "Discard draft"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={replacementReview !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setReplacementReview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply this correction?</DialogTitle>
            <DialogDescription>
              The original stays posted. One transaction creates its reversal
              and the replacement below. If either fails, neither is applied.
            </DialogDescription>
          </DialogHeader>
          {replacementReview && (
            <div className="space-y-4">
              <div className="rounded-lg bg-secondary/50 p-4 text-sm">
                <p className="font-medium">{replacementReview.memo}</p>
                <p className="mt-1 text-muted-foreground">
                  Reverse original: {replacementReview.reversal_date}. Post
                  replacement: {replacementReview.entry_date}.
                </p>
                <p className="mt-1 text-muted-foreground">
                  {replacementReview.reason}
                </p>
              </div>
              {replacementReview.lines.map((l, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span>{accountMap.get(l.account_id)?.name}</span>
                  <Money value={l.amount_cents} />
                </div>
              ))}
              {replacementUsesRetained && (
                <RetainedReviewFields
                  lines={replacementReview.lines}
                  accounts={data.accounts}
                  value={retainedReplacement}
                  onChange={setRetainedReplacement}
                />
              )}
              {error && (
                <p role="alert" className="text-sm text-error">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setReplacementReview(null)}
                >
                  Back to editing
                </Button>
                <Button
                  loading={busy}
                  disabled={
                    busy ||
                    (replacementUsesRetained && !replacementRetainedProof)
                  }
                  onClick={async () => {
                    if (
                      await mutate({
                        ...replacementReview,
                        ...(replacementUsesRetained && replacementRetainedProof
                          ? { retained_review: replacementRetainedProof }
                          : {}),
                      })
                    ) {
                      setReplacementReview(null);
                      setEditor(null);
                    }
                  }}
                >
                  Apply correction
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!saveView || !!saveTemplate}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setSaveView(null);
            setSaveTemplate(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {saveView ? "Save transaction view" : "Save journal template"}
            </DialogTitle>
            <DialogDescription>
              {saveView
                ? "Reuse these filters from the transaction register."
                : "The template opens a fresh draft. Dates and posting approval remain explicit."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const command = saveView ?? saveTemplate;
              if (command && (await mutate(command))) {
                setSaveView(null);
                setSaveTemplate(null);
              }
            }}
          >
            <Input
              label="Name"
              value={(saveView ?? saveTemplate)?.name ?? ""}
              required
              maxLength={120}
              onChange={(e) => {
                if (saveView)
                  setSaveView({ ...saveView, name: e.target.value });
                if (saveTemplate)
                  setSaveTemplate({ ...saveTemplate, name: e.target.value });
              }}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button disabled={busy}>
              Save {saveView ? "view" : "template"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EntryRow({
  entry,
  onSelect,
}: {
  entry: JournalEntry;
  onSelect: () => void;
}) {
  const total = entry.lines.reduce(
    (sum, l) =>
      sum + (BigInt(l.amount_cents) > ZERO ? BigInt(l.amount_cents) : ZERO),
    ZERO,
  );
  return (
    <button
      onClick={onSelect}
      className="flex w-full items-center gap-4 border-b border-border p-4 text-left last:border-0 hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="hidden rounded-lg border border-border p-2 text-muted-foreground sm:block">
        <BookOpen size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{entry.memo}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {entry.entry_date} · {entry.primary_origin} · {entry.status}
        </span>
      </span>
      <span className="text-sm whitespace-nowrap">
        <Money value={total} />
      </span>
      <ArrowUpRight size={15} className="text-muted-foreground" />
    </button>
  );
}
function ReportPanel({
  title,
  rows,
}: {
  title: string;
  rows: [string, string][];
}) {
  return (
    <section className="glass-card p-5">
      <h2 className="mb-4 font-semibold">{title}</h2>
      <dl className="divide-y divide-border">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between gap-4 py-3 text-sm last:font-semibold"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd>
              <Money value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function Empty({
  title,
  description,
  onAdd,
  disabled,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <div className="px-6 py-12 text-center">
      <BookOpen size={28} className="mx-auto mb-3 text-teal-light" />
      <h3 className="font-medium">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {description}
      </p>
      <Button
        className="mt-5"
        variant="outline"
        disabled={disabled}
        onClick={onAdd}
      >
        New journal draft
      </Button>
    </div>
  );
}
