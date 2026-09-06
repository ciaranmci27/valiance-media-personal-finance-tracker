"use client";
import { useState, useEffect } from "react";
import {
  Landmark,
  CreditCard,
  ArrowUpRight,
  Search,
  Pencil,
  Plus,
  ChevronLeft,
  ChevronRight,
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
import { defaultChart } from "@/lib/accounting/chart";
import type {
  AccountingWorkspace,
  BalanceRow,
} from "@/lib/accounting/contracts";
import type { AccountProfile } from "@/lib/accounting/workflows";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { AccountingReconciliation } from "./accounting-reconciliation";

const selectStyle =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";
export function AccountingAccounts({
  data,
  profiles,
  demo,
  onRefresh,
  onAdd,
  onEntry,
}: {
  data: AccountingWorkspace;
  profiles: AccountProfile[];
  demo: boolean;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  onEntry: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<BalanceRow | null>(null);
  const [ledger, setLedger] = useState<BalanceRow | null>(null);
  const [seed, setSeed] = useState(false);
  const [reconcile, setReconcile] = useState<BalanceRow | null>(null);
  const command = useAccountingCommand(onRefresh);
  const profileMap = new Map(profiles.map((p) => [p.account_id, p]));
  const cashAccounts = data.balances.filter((a) =>
    ["bank", "cash", "card"].includes(profileMap.get(a.id)?.cash_kind ?? ""),
  );
  const filtered = data.balances.filter((a) =>
    `${a.code} ${a.name}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (reconcile)
    return (
      <AccountingReconciliation
        account={reconcile}
        onBack={() => setReconcile(null)}
        onEntry={onEntry}
        onRefresh={onRefresh}
      />
    );
  return (
    <div className="space-y-5">
      {cashAccounts.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cashAccounts.map((a) => {
            const card = profileMap.get(a.id)?.cash_kind === "card";
            return (
              <div key={a.id} className="glass-card overflow-hidden">
                <button
                  onClick={() => setLedger(a)}
                  className="w-full p-5 text-left transition-colors hover:bg-secondary/40"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      {card ? <CreditCard size={17} /> : <Landmark size={17} />}{" "}
                      {a.name}
                    </span>
                    <ArrowUpRight size={15} className="text-muted-foreground" />
                  </div>
                  <p className="mt-5 text-2xl font-mono tracking-tight">
                    <MaskedValue
                      value={formatCents(
                        card ? -BigInt(a.ending_cents) : a.ending_cents,
                      )}
                    />
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Book {card ? "liability" : "balance"} · {data.to}
                  </p>
                </button>
                {!demo && (
                  <div className="border-t border-border px-4 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setReconcile(a)}
                    >
                      Reconcile statements
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <section className="glass-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 className="font-semibold">Chart of accounts</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your categories, balances, and account history.
            </p>
          </div>
          <Button size="sm" disabled={demo} onClick={onAdd}>
            <Plus size={14} />
            Add account
          </Button>
        </div>
        {data.accounts.length > 0 ? (
          <>
            <div className="p-4">
              <Input
                aria-label="Search accounts"
                placeholder="Search by name or code"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                icon={<Search size={16} />}
                className="sm:w-80"
              />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-border bg-secondary/20 text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 text-left font-medium">Account</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-right font-medium">
                      Book balance
                    </th>
                    <th className="w-12">
                      <span className="sr-only">Edit</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-5 py-4">
                        <button
                          onClick={() => setLedger(a)}
                          className="text-left hover:text-teal"
                        >
                          <span className="mr-3 font-mono text-xs text-muted-foreground">
                            {a.code}
                          </span>
                          {a.name}
                          {a.is_archived && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              Archived
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-4 capitalize text-muted-foreground">
                        {a.account_type}
                      </td>
                      <td className="px-4 py-4 text-right font-mono">
                        <MaskedValue
                          value={formatCents(
                            a.normal_side === "credit"
                              ? -BigInt(a.ending_cents)
                              : a.ending_cents,
                          )}
                        />
                      </td>
                      <td className="pr-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${a.name}`}
                          disabled={demo}
                          onClick={() => {
                            command.setError("");
                            setEditing(a);
                          }}
                        >
                          <Pencil size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="mx-auto max-w-lg px-6 py-14 text-center">
            <Landmark size={28} className="mx-auto mb-4 text-teal" />
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
            <DialogDescription>
              Historical entries keep this account identity. Archiving requires
              a zero balance and no unfinished activity.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <form
              key={editing.id}
              className="space-y-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                const p = profileMap.get(editing.id);
                if (
                  await command.execute({
                    type: "account.update",
                    id: editing.id,
                    expected_version: p?.version ?? 0,
                    name: String(values.get("name")),
                    code: String(values.get("code")),
                    cash_kind: String(
                      values.get("cash_kind"),
                    ) as AccountProfile["cash_kind"],
                    purpose: p?.purpose ?? null,
                    parent_account_id: p?.parent_account_id ?? null,
                    subtype: p?.subtype ?? "",
                    is_archived: values.get("archived") === "on",
                  })
                )
                  setEditing(null);
              }}
            >
              <Input
                label="Account name"
                name="name"
                defaultValue={editing.name}
                required
                maxLength={120}
              />
              <Input
                label="Account code"
                name="code"
                defaultValue={editing.code}
                maxLength={20}
              />
              <label className="block text-sm">
                Account use
                <select
                  name="cash_kind"
                  className={selectStyle}
                  defaultValue={profileMap.get(editing.id)?.cash_kind ?? "none"}
                >
                  <option value="none">General ledger account</option>
                  {editing.account_type === "asset" && (
                    <>
                      <option value="bank">Bank account</option>
                      <option value="cash">Cash / undeposited funds</option>
                    </>
                  )}
                  {editing.account_type === "liability" && (
                    <option value="card">Credit card</option>
                  )}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="archived"
                  defaultChecked={editing.is_archived}
                />
                Archive this account
              </label>
              {command.error && (
                <p role="alert" className="text-sm text-error">
                  {command.error}
                </p>
              )}
              <Button type="submit" loading={command.busy}>
                Save account
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={seed}
        onOpenChange={(o) => {
          if (!command.busy) setSeed(o);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Standard company chart</DialogTitle>
            <DialogDescription>
              {defaultChart.length} accounts for banks, equity, income,
              operating costs, and payroll. This creates categories with zero
              balances.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            {defaultChart.map((a) => (
              <p
                key={a.id}
                className="flex justify-between gap-3 border-b border-border px-3 py-2 text-sm"
              >
                <span>
                  {a.code} {a.name}
                </span>
                <span className="text-muted-foreground capitalize">
                  {a.account_type}
                </span>
              </p>
            ))}
          </div>
          {command.error && (
            <p role="alert" className="text-sm text-error">
              {command.error}
            </p>
          )}
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
        </DialogContent>
      </Dialog>
      <Dialog
        open={ledger !== null}
        onOpenChange={(o) => {
          if (!o) setLedger(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ledger?.name}</DialogTitle>
            <DialogDescription>
              Posted account activity, with an exact running debit balance.
              Credits appear negative.
            </DialogDescription>
          </DialogHeader>
          {ledger && (
            <AccountLedger
              account={ledger.id}
              from={data.from}
              to={data.to}
              onEntry={onEntry}
              demo={demo}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
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
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{
    opening_cents: string;
    total: number;
    rows: {
      id: string;
      entry_id: string;
      entry_date: string;
      memo: string;
      amount_cents: string;
      running_cents: string;
    }[];
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
  return (
    <div>
      <div className="mb-4 flex justify-between rounded-lg bg-secondary/50 p-3 text-sm">
        <span>Opening balance · {from}</span>
        <MaskedValue value={formatCents(data.opening_cents)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              {["Date / entry", "Movement", "Running balance"].map((h) => (
                <th key={h} className="p-3 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-3">
                  <button
                    onClick={() => onEntry(r.entry_id)}
                    className="text-left hover:text-teal"
                  >
                    {r.memo}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {r.entry_date}
                    </span>
                  </button>
                </td>
                <td className="p-3 font-mono">
                  <MaskedValue value={formatCents(r.amount_cents)} />
                </td>
                <td className="p-3 font-mono">
                  <MaskedValue value={formatCents(r.running_cents)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={!offset}
          onClick={() => setOffset(offset - 100)}
        >
          <ChevronLeft size={14} />
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={offset + 100 >= data.total}
          onClick={() => setOffset(offset + 100)}
        >
          Next
          <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}
