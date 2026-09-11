"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Landmark, Search, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/inputs/Select";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import { defaultChart } from "@/lib/accounting/chart";
import type {
  AccountingAccount,
  AccountingWorkspace,
  BalanceRow,
} from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { AccountingBankPanel } from "./accounting-bank-panel";
import { AccountingPicker } from "./accounting-picker";
import { AccountingReconciliation } from "./accounting-reconciliation";
import { dateLabel, enumLabel, money } from "./format";

const accountTypeFilters: [string, string][] = [
  ["all", "All accounts"],
  ["asset", "Assets"],
  ["liability", "Liabilities"],
  ["income", "Income"],
  ["expense", "Expenses"],
  ["equity", "Equity"],
];
const linkClass =
  "rounded text-left transition-colors hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const LEDGER_PAGE = 100;

function bookBalance(a: BalanceRow) {
  return money(
    a.normal_side === "credit" ? -BigInt(a.ending_cents) : a.ending_cents,
  );
}

export function AccountingAccounts({
  data,
  profiles,
  demo,
  onRefresh,
  onAdd,
  onEntry,
  onFeeds,
}: {
  data: AccountingWorkspace;
  profiles: AccountProfile[];
  demo: boolean;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  onEntry: (id: string) => void;
  onFeeds: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<BalanceRow | null>(null);
  const [editingProfile, setEditingProfile] = useState<
    AccountProfile | undefined
  >();
  const [type, setType] = useState("all");
  const [archived, setArchived] = useState(false);
  const [asOf, setAsOf] = useState(data.to);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const [ledger, setLedger] = useState<BalanceRow | null>(null);
  const [seed, setSeed] = useState(false);
  const [localReconcile, setReconcile] = useState<BalanceRow | null>(null);
  const params = useSearchParams();
  const requested = params.get("reconcile");
  const reconcile =
    data.balances.find(
      (a) =>
        a.id === requested &&
        ["bank", "cash", "card"].includes(
          profiles.find((p) => p.account_id === a.id)?.cash_kind ?? "",
        ),
    ) ?? localReconcile;
  const command = useAccountingCommand(onRefresh);
  const profileMap = new Map(profiles.map((p) => [p.account_id, p]));
  const cashAccounts = data.balances.filter((a) =>
    ["bank", "cash", "card"].includes(profileMap.get(a.id)?.cash_kind ?? ""),
  );
  const filtered = data.balances.filter(
    (a) =>
      (type === "all" || a.account_type === type) &&
      (archived || !a.is_archived) &&
      `${a.code} ${a.name}`.toLowerCase().includes(query.toLowerCase()),
  );
  const startEdit = (a: BalanceRow) => {
    command.setError("");
    setEditingProfile(profileMap.get(a.id));
    setEditing(a);
  };
  const editButton = (a: BalanceRow, size: "icon" | "icon-sm") => (
    <Tooltip content={`Edit ${a.name}`}>
      <Button
        variant="ghost"
        size={size}
        aria-label={`Edit ${a.name}`}
        disabled={demo}
        onClick={() => startEdit(a)}
      >
        <Pencil size={14} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
  const columns: DataTableColumn<BalanceRow>[] = [
    {
      key: "account",
      header: "Account",
      render: (a) => (
        <button
          type="button"
          onClick={() => setLedger(a)}
          className={linkClass}
        >
          <span className="mr-3 font-mono text-xs text-muted-foreground">
            {a.code}
          </span>
          {a.name}
          {a.is_archived && (
            <Badge size="sm" className="ml-2">
              Archived
            </Badge>
          )}
        </button>
      ),
    },
    {
      key: "type",
      header: "Type",
      render: (a) => (
        <span className="text-muted-foreground">
          {enumLabel(a.account_type)}
        </span>
      ),
    },
    {
      key: "balance",
      header: "Book balance",
      align: "right",
      numeric: true,
      render: (a) => (
        <MaskedValue className="tabular-nums" value={bookBalance(a)} />
      ),
    },
    {
      key: "edit",
      header: <span className="sr-only">Edit</span>,
      align: "right",
      width: "w-12",
      render: (a) => editButton(a, "icon"),
    },
  ];
  if (reconcile)
    return (
      <AccountingReconciliation
        account={reconcile}
        onBack={() => {
          setReconcile(null);
          const url = new URL(window.location.href);
          url.searchParams.delete("reconcile");
          url.searchParams.delete("statement");
          window.history.replaceState(null, "", url);
        }}
        onEntry={onEntry}
        onRefresh={onRefresh}
      />
    );
  return (
    <div className="space-y-5">
      <AccountingBankPanel
        accounts={cashAccounts}
        bookBalance={(a) =>
          profileMap.get(a.id)?.cash_kind === "card"
            ? -BigInt(a.ending_cents)
            : BigInt(a.ending_cents)
        }
        isCard={(a) => profileMap.get(a.id)?.cash_kind === "card"}
        demo={demo}
        onFeeds={onFeeds}
        onLedger={setLedger}
        onReconcile={setReconcile}
        onRefresh={onRefresh}
      />
      <section className="glass-card overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 className="font-semibold">Chart of accounts</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your categories, balances, and account history.
            </p>
          </div>
          <Button size="sm" disabled={demo} onClick={onAdd}>
            <Plus size={14} aria-hidden="true" />
            Add account
          </Button>
        </div>
        {data.accounts.length > 0 ? (
          <>
            <div className="space-y-4 p-4">
              <div
                role="group"
                aria-label="Account types"
                className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-[rgba(var(--ink),0.05)] p-1 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.06)]"
              >
                {accountTypeFilters.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={type === id}
                    onClick={() => setType(id)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      type === id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <TextInput
                  aria-label="Search accounts"
                  placeholder="Search by name or code"
                  value={query}
                  onChange={(nextValue) => setQuery(nextValue)}
                  prefix={<Search size={16} aria-hidden="true" />}
                />
                <Checkbox
                  checked={archived}
                  onChange={setArchived}
                  label="Include archived"
                  className="py-2"
                />
                <form action="/accounting" className="flex items-end gap-2">
                  <input type="hidden" name="view" value="accounts" />
                  <input type="hidden" name="from" value={yearStart} />
                  <DateInput
                    name="to"
                    label="Balances as of"
                    value={asOf}
                    onChange={(nextValue) => setAsOf(nextValue)}
                    minDate="1900-01-01"
                    maxDate="2100-12-31"
                    required
                    disabled={demo}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={demo}
                  >
                    Update
                  </Button>
                </form>
              </div>
            </div>
            <div className="border-t border-border p-4 lg:p-0">
              <DataTable<BalanceRow>
                framed={false}
                columns={columns}
                data={filtered}
                keyExtractor={(a) => a.id}
                emptyState="No accounts match these filters."
                mobileCard={(a) => (
                  <div className="glass-card rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setLedger(a)}
                        className={cn(linkClass, "min-w-0 text-sm")}
                      >
                        <span className="block font-mono text-xs text-muted-foreground">
                          {a.code}
                        </span>
                        <span className="mt-0.5 block font-medium">
                          {a.name}
                        </span>
                      </button>
                      {editButton(a, "icon-sm")}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        {enumLabel(a.account_type)}
                        {a.is_archived && <Badge size="sm">Archived</Badge>}
                      </span>
                      <MaskedValue
                        className="tabular-nums"
                        value={bookBalance(a)}
                      />
                    </div>
                  </div>
                )}
              />
            </div>
          </>
        ) : (
          <div className="mx-auto max-w-lg px-6 py-14 text-center">
            <Landmark
              size={28}
              aria-hidden="true"
              className="mx-auto mb-4 text-teal"
            />
            <h3 className="text-lg font-semibold">Set up your company chart</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Start with the standard company accounts, or create accounts
              individually. When bringing in Wave history, map its original
              chart before posting.
            </p>
            <Button
              className="mt-6"
              disabled={demo}
              onClick={() => setSeed(true)}
            >
              Review standard chart
            </Button>
          </div>
        )}
      </section>
      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o && !command.busy) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription className="sr-only">
              Change the name, use and grouping of {editing?.name}.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <AccountEditForm
              key={editing.id}
              account={editing}
              profile={editingProfile}
              accounts={data.accounts}
              profileMap={profileMap}
              command={command}
              onSaved={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={seed}
        onOpenChange={(o) => {
          if (!command.busy) setSeed(o);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create standard chart</DialogTitle>
            <DialogDescription className="sr-only">
              {defaultChart.length} standard accounts with zero balances.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 max-h-64 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {defaultChart.map((a) => (
              <p
                key={a.id}
                className="flex justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span>
                  <span className="mr-3 font-mono text-xs text-muted-foreground">
                    {a.code}
                  </span>
                  {a.name}
                </span>
                <span className="text-muted-foreground">
                  {enumLabel(a.account_type)}
                </span>
              </p>
            ))}
          </div>
          {command.error && (
            <p role="alert" className="mt-4 text-sm text-error">
              {command.error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={command.busy}
              onClick={() => setSeed(false)}
            >
              Cancel
            </Button>
            <Button
              loading={command.busy}
              onClick={async () => {
                if (
                  await command.execute({
                    type: "chart.seed",
                    id: crypto.randomUUID(),
                    accounts: defaultChart,
                  })
                )
                  setSeed(false);
              }}
            >
              Create {defaultChart.length} accounts
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={ledger !== null}
        onOpenChange={(o) => {
          if (!o) setLedger(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ledger?.name}</DialogTitle>
            <DialogDescription className="sr-only">
              Posted activity and running balance for {ledger?.name}.
            </DialogDescription>
          </DialogHeader>
          {ledger && (
            <div className="mt-4">
              <AccountLedger
                account={ledger.id}
                from={data.from}
                to={data.to}
                onEntry={onEntry}
                demo={demo}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The edit dialog body. Keyed by account id from the parent so the select
 * state re-initializes per account, exactly as the uncontrolled form did.
 */
function AccountEditForm({
  account,
  profile,
  accounts,
  profileMap,
  command,
  onSaved,
  onCancel,
}: {
  account: BalanceRow;
  profile: AccountProfile | undefined;
  accounts: AccountingAccount[];
  profileMap: Map<string, AccountProfile>;
  command: ReturnType<typeof useAccountingCommand>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [cashKind, setCashKind] = useState<AccountProfile["cash_kind"]>(
    profile?.cash_kind ?? "none",
  );
  const [purpose, setPurpose] = useState(profile?.purpose ?? "");
  const [parent, setParent] = useState(profile?.parent_account_id ?? "");
  const [archived, setArchived] = useState(account.is_archived);
  const customPurpose =
    profile?.purpose &&
    !defaultChart.some(
      (a) =>
        a.purpose === profile.purpose &&
        a.account_type === account.account_type,
    )
      ? profile.purpose
      : null;
  // Only assets and liabilities can be a bank, cash or card account.
  const useOptions = [
    { value: "none", label: "General ledger account" },
    ...(account.account_type === "asset"
      ? [
          { value: "bank", label: "Bank account" },
          { value: "cash", label: "Cash / undeposited funds" },
        ]
      : []),
    ...(account.account_type === "liability"
      ? [{ value: "card", label: "Credit card" }]
      : []),
  ];
  return (
    <form
      className="mt-4 space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = new FormData(e.currentTarget);
        if (
          await command.execute({
            type: "account.update",
            id: account.id,
            expected_version: profile?.version ?? 0,
            name: String(values.get("name")),
            code: String(values.get("code")),
            cash_kind: cashKind,
            purpose: purpose || null,
            parent_account_id: parent || null,
            subtype: String(values.get("subtype") ?? ""),
            is_archived: archived,
          })
        )
          onSaved();
      }}
    >
      <TextInput
        label="Name"
        name="name"
        defaultValue={account.name}
        required
        maxLength={120}
      />
      {/* The type is fixed once an account exists; it is shown, not edited. */}
      <Select
        label="Type"
        value={account.account_type}
        disabled
        options={[
          {
            value: account.account_type,
            label: enumLabel(account.account_type),
          },
        ]}
      />
      {useOptions.length > 1 && (
        <Select
          label="Account use"
          value={cashKind}
          options={useOptions}
          onChange={(value) =>
            setCashKind(value as AccountProfile["cash_kind"])
          }
        />
      )}
      <details className="group rounded-xl border border-border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
          Advanced
        </summary>
        <div className="space-y-4 border-t border-border p-4">
          <TextInput
            label="Account code"
            name="code"
            defaultValue={account.code}
            maxLength={20}
          />
          <AccountingPicker
            label="Purpose"
            visibleLabel="Purpose"
            value={purpose}
            options={[
              { value: "", label: "General category" },
              ...(customPurpose
                ? [{ value: customPurpose, label: enumLabel(customPurpose) }]
                : []),
              ...defaultChart
                .filter((a) => a.account_type === account.account_type)
                .map((a) => ({ value: a.purpose!, label: a.name })),
            ]}
            onChange={setPurpose}
          />
          <TextInput
            label="Report group"
            name="subtype"
            maxLength={100}
            defaultValue={profile?.subtype ?? ""}
            placeholder="For example: Operating expenses"
          />
          <AccountingPicker
            label="Parent account"
            visibleLabel="Parent account"
            value={parent}
            options={[
              { value: "", label: "No parent" },
              ...accounts
                .filter(
                  (a) =>
                    a.id !== account.id &&
                    a.account_type === account.account_type &&
                    !a.is_archived &&
                    !profileMap.get(a.id)?.parent_account_id,
                )
                .map((a) => ({ value: a.id, label: a.name })),
            ]}
            onChange={setParent}
          />
          <Checkbox
            checked={archived}
            onChange={setArchived}
            label="Archive this account"
          />
        </div>
      </details>
      {command.error && (
        <p role="alert" className="text-sm text-error">
          {command.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={command.busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" loading={command.busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

function AccountLedger({
  account,
  from,
  to,
  onEntry,
  demo,
}: {
  account: string;
  from: string;
  to: string;
  onEntry: (id: string) => void;
  demo: boolean;
}) {
  type LedgerRow = {
    id: string;
    entry_id: string;
    entry_date: string;
    memo: string;
    amount_cents: string;
    running_cents: string;
  };
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{
    opening_cents: string;
    total: number;
    rows: LedgerRow[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    accountingGet<NonNullable<typeof data>>(
      { view: "account-ledger", account, from, to, offset: String(offset) },
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [account, from, to, offset, demo]);
  if (demo)
    return (
      <p className="text-sm text-muted-foreground">
        Account drill-down is available in the configured books.
      </p>
    );
  if (error)
    return (
      <p role="alert" className="text-sm text-error">
        {error}
      </p>
    );
  if (!data)
    return (
      <p className="text-sm text-muted-foreground">
        Loading account history...
      </p>
    );
  const entryLink = (r: LedgerRow) => (
    <button
      type="button"
      onClick={() => onEntry(r.entry_id)}
      className={linkClass}
    >
      {r.memo}
      <span className="mt-1 block text-xs text-muted-foreground">
        {dateLabel(r.entry_date)}
      </span>
    </button>
  );
  const columns: DataTableColumn<LedgerRow>[] = [
    { key: "entry", header: "Date / entry", render: entryLink },
    {
      key: "movement",
      header: "Movement",
      align: "right",
      numeric: true,
      render: (r) => (
        <MaskedValue className="font-mono" value={money(r.amount_cents)} />
      ),
    },
    {
      key: "running",
      header: "Running balance",
      align: "right",
      numeric: true,
      render: (r) => (
        <MaskedValue className="font-mono" value={money(r.running_cents)} />
      ),
    },
  ];
  return (
    <div>
      <div className="mb-4 flex justify-between rounded-lg bg-secondary/50 p-3 text-sm">
        <span>Opening balance · {dateLabel(from)}</span>
        <MaskedValue
          className="font-mono tabular-nums"
          value={money(data.opening_cents)}
        />
      </div>
      <DataTable<LedgerRow>
        columns={columns}
        data={data.rows}
        keyExtractor={(r) => r.id}
        mobileCard={(r) => (
          <div className="glass-card rounded-xl p-4 text-sm">
            {entryLink(r)}
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Movement</span>
              <MaskedValue
                className="font-mono tabular-nums"
                value={money(r.amount_cents)}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                Running balance
              </span>
              <MaskedValue
                className="font-mono tabular-nums"
                value={money(r.running_cents)}
              />
            </div>
          </div>
        )}
        after={
          <Pagination
            offset={offset}
            limit={LEDGER_PAGE}
            total={data.total}
            onChange={setOffset}
          />
        }
      />
    </div>
  );
}
