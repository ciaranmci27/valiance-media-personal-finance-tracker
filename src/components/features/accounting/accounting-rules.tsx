"use client";
import { useEffect, useState } from "react";
import {
  Plus,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
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
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type { ManageData } from "@/lib/accounting/workflows";
import type {
  AccountingRule,
  PayeeAlias,
  RulesView,
  RulesPreview,
} from "@/lib/accounting/rules";
import { parseUsd, centsToDecimal, formatCents } from "@/lib/accounting/money";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
const selectStyle =
  "mt-1 h-10 w-full rounded-lg border border-border bg-input px-3 text-sm";

export function AccountingRules({
  data,
  manage,
  demo,
  onRefresh,
  onEntry,
}: {
  data: AccountingWorkspace;
  manage: ManageData;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry: (id: string) => void;
}) {
  const [state, setState] = useState<RulesView | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [applicationId] = useState(() => crypto.randomUUID());
  const [editor, setEditor] = useState<AccountingRule | null>(null),
    [alias, setAlias] = useState<PayeeAlias | null>(null);
  const [from, setFrom] = useState(data.from),
    [to, setTo] = useState(data.to),
    [ruleId, setRuleId] = useState(""),
    [page, setPage] = useState(0);
  const [preview, setPreview] = useState<RulesPreview | null>(null),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [reviewed, setReviewed] = useState(false),
    [reason, setReason] = useState("");
  async function refresh() {
    setState(await accountingGet<RulesView>({ view: "rules" }));
    setPreview(null);
    setSelected(new Set());
    setReviewed(false);
    await onRefresh();
  }
  const cmd = useAccountingCommand(refresh);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    accountingGet<RulesView>({ view: "rules" }, abort.signal)
      .then(setState)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [demo]);
  function invalidate() {
    setPreview(null);
    setSelected(new Set());
    setReviewed(false);
    setPage(0);
  }
  async function inspect(id = ruleId, offset = 0) {
    setLoading(true);
    setError("");
    setSelected(new Set());
    setReviewed(false);
    setRuleId(id);
    setPage(offset);
    try {
      setPreview(
        await accountingGet<RulesPreview>({
          view: "rules-preview",
          from,
          to,
          ...(id ? { rule: id } : {}),
          offset: String(offset * 100),
        }),
      );
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : "Unable to preview rules.");
    } finally {
      setLoading(false);
    }
  }
  const currentRule = state?.rules.find((r) => r.id === ruleId),
    chosen = preview?.rows.filter((r) => selected.has(r.id)) ?? [];
  const totals = chosen.reduce(
    (v, r) => {
      const n = BigInt(r.bank_amount_cents);
      if (n > BigInt(0)) v.increase += n;
      else v.decrease -= n;
      return v;
    },
    { increase: BigInt(0), decrease: BigInt(0) },
  );
  const accountName = (id: string) =>
    data.accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Rules & payee aliases</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use consistent treatment for recurring bank movements. Review the
            proposed categories before filling drafts.
          </p>
        </div>
        <Button
          disabled={demo || !state}
          onClick={() =>
            setEditor({
              id: crypto.randomUUID(),
              version: 0,
              name: "",
              priority: 10,
              enabled: false,
              description_mode: "contains",
              description: "",
              bank_account_id: "",
              direction: "decrease",
              min_cents: "0",
              max_cents: "100000",
              match_payee_id: null,
              category_account_id: "",
              assign_payee_id: null,
              reason: "",
            })
          }
        >
          <Plus size={15} />
          New rule
        </Button>
      </div>
      {(error || cmd.error) && (
        <p
          role="alert"
          className="rounded-lg border border-error/30 bg-error/5 p-3 text-sm text-error"
        >
          {error || cmd.error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-teal-light">
          {notice}
        </p>
      )}
      {demo && (
        <p className="text-sm text-muted-foreground">
          Rules are available in your configured company books.
        </p>
      )}
      <section className="glass-card overflow-hidden">
        <div className="border-b border-border p-4">
          <h3 className="font-medium">Categorization rules</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Lower priority numbers win. Equal-priority matches and conflicting
            aliases need review. Saving edits pauses a rule until its next
            preview is approved.
          </p>
        </div>
        {!state?.rules.length ? (
          <div className="p-6 text-sm text-muted-foreground">
            <SlidersHorizontal className="mb-3" size={22} />
            Create a rule for a recurring description, bank account, direction,
            and amount range.
          </div>
        ) : (
          state.rules.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 last:border-0"
            >
              <div>
                <p className="font-medium">
                  {r.name}
                  <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs font-normal">
                    {r.enabled ? "Enabled for drafts" : "Paused"}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Priority {r.priority} · {accountName(r.bank_account_id)} ·{" "}
                  {r.description_mode}: {r.description}
                </p>
                <p className="mt-1 text-xs">
                  {accountName(r.category_account_id)} ·{" "}
                  <MaskedValue value={formatCents(r.min_cents)} /> to{" "}
                  <MaskedValue value={formatCents(r.max_cents)} />
                </p>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Version history ({r.history?.length ?? 0})
                  </summary>
                  <div className="mt-2 max-h-64 space-y-3 overflow-auto rounded-lg bg-secondary/30 p-3">
                    {r.history?.map((h) => (
                      <div key={h.version}>
                        <p>
                          Version {h.version} ·{" "}
                          {h.enabled ? "Enabled for drafts" : "Paused"} ·{" "}
                          {new Date(h.created_at).toLocaleString()}
                        </p>
                        <p className="mt-1 text-muted-foreground">{h.reason}</p>
                        <p className="mt-1">
                          Priority {h.priority} · {h.description_mode}:{" "}
                          {h.description} · {accountName(h.bank_account_id)} →{" "}
                          {accountName(h.category_account_id)}
                        </p>
                        <p>
                          <MaskedValue value={formatCents(h.min_cents)} /> to{" "}
                          <MaskedValue value={formatCents(h.max_cents)} />
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || cmd.busy}
                  onClick={() => void inspect(r.id)}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={cmd.busy}
                  onClick={() => setEditor(r)}
                >
                  Edit
                </Button>
                {r.enabled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cmd.busy}
                    onClick={async () => {
                      if (
                        await cmd.execute({
                          type: "rule.activate",
                          id: r.id,
                          expected_version: r.version,
                          expected_revision: state.revision,
                          reviewed: true,
                          enabled: false,
                          reason: "Owner paused draft suggestions",
                        })
                      )
                        setNotice(
                          "Rule paused. Existing transactions are unchanged.",
                        );
                    }}
                  >
                    Pause
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </section>
      <section className="glass-card p-5 space-y-4">
        <div>
          <h3 className="font-semibold">Preview & apply</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Posted history is shown for comparison. Rules fill only balanced,
            uncategorized drafts with one bank movement. Posting remains a
            separate review.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Preview from"
            disabled={loading || cmd.busy}
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              invalidate();
            }}
          />
          <Input
            label="Preview through"
            disabled={loading || cmd.busy}
            type="date"
            value={to}
            min={from}
            onChange={(e) => {
              setTo(e.target.value);
              invalidate();
            }}
          />
          <label className="text-sm">
            Rule
            <select
              className={selectStyle}
              value={ruleId}
              disabled={loading || cmd.busy}
              onChange={(e) => {
                setRuleId(e.target.value);
                invalidate();
              }}
            >
              <option value="">All enabled rules</option>
              {state?.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {!r.enabled ? " (paused)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Button
          variant="outline"
          disabled={demo || loading || cmd.busy || !from || !to || from > to}
          loading={loading}
          onClick={() => void inspect()}
        >
          Compare transactions
        </Button>
        {preview && (
          <>
            <div className="flex flex-wrap justify-between gap-3 text-xs text-muted-foreground">
              <p>
                {preview.total} matching transactions · Page {page + 1}
              </p>
              <p>Only selected drafts on this page will change.</p>
            </div>
            {!preview.rows.length && (
              <p className="rounded-lg bg-secondary/30 p-4 text-sm">
                No matching transactions in this range. Check the date,
                description, and amount bounds.
              </p>
            )}
            <div className="divide-y divide-border">
              {preview.rows.map((row) => (
                <div key={row.id} className="py-4">
                  <div className="flex gap-3">
                    <input
                      className="mt-1 h-4 w-4 shrink-0"
                      type="checkbox"
                      aria-label={`Select ${row.memo}`}
                      checked={selected.has(row.id)}
                      disabled={
                        !row.eligible || !row.winner?.enabled || cmd.busy
                      }
                      onChange={(e) => {
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (e.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        });
                        setReviewed(false);
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap justify-between gap-2">
                        <button
                          className="text-left text-sm font-medium hover:underline"
                          onClick={() => onEntry(row.id)}
                        >
                          {row.memo}
                        </button>
                        <MaskedValue
                          className="font-mono text-sm"
                          value={formatCents(row.bank_amount_cents)}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.entry_date} · {accountName(row.bank_account_id)} ·{" "}
                        {row.status}
                      </p>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        {accountName(row.category_account_id)}
                        <ArrowRight size={13} />
                        {row.winner?.category_name ?? "No proposed category"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Proposed payee:{" "}
                        {manage.parties.find(
                          (p) =>
                            p.id ===
                            (row.winner?.assign_payee_id ?? row.payee_id),
                        )?.name ?? "Keep unassigned"}
                      </p>
                      <p
                        className={`mt-1 text-xs ${row.eligible ? "text-teal-light" : "text-warning"}`}
                      >
                        {row.eligible
                          ? row.winner?.enabled
                            ? "Ready to fill draft"
                            : "Enable the reviewed rule first"
                          : row.reason}
                      </p>
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer text-muted-foreground">
                          Matched rules and journal details
                        </summary>
                        <div className="mt-2 space-y-2 rounded-lg bg-secondary/30 p-3">
                          {row.matches.map((m) => (
                            <p key={m.rule_id}>
                              Priority {m.priority}: {m.name} · version{" "}
                              {m.version} · {m.category_name}
                            </p>
                          ))}
                          {row.aliases.aliases.map((a) => (
                            <p key={a.id}>
                              Payee alias: {a.description} → {a.name}
                            </p>
                          ))}
                          {row.lines.map((l, i) => (
                            <p key={i} className="flex justify-between gap-3">
                              <span>
                                {accountName(l.account_id)}
                                {l.account_id === row.category_account_id &&
                                row.winner
                                  ? ` → ${row.winner.category_name}`
                                  : ""}
                              </span>
                              <MaskedValue
                                value={formatCents(l.amount_cents)}
                              />
                            </p>
                          ))}
                        </div>
                      </details>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="icon"
                variant="outline"
                aria-label="Previous rule preview page"
                disabled={!page || loading || cmd.busy}
                onClick={() => void inspect(ruleId, page - 1)}
              >
                <ChevronLeft size={15} />
              </Button>
              <Button
                size="icon"
                variant="outline"
                aria-label="Next rule preview page"
                disabled={
                  (page + 1) * 100 >= preview.total || loading || cmd.busy
                }
                onClick={() => void inspect(ruleId, page + 1)}
              >
                <ChevronRight size={15} />
              </Button>
            </div>
            {currentRule && !currentRule.enabled && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <p className="text-sm">
                  Enable “{currentRule.name}” for draft suggestions after
                  reviewing its conditions and matches.
                </p>
                <Input
                  label="Rule approval note"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={1000}
                />
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed these conditions and the matching transactions.
                </label>
                <Button
                  disabled={!reviewed || !reason.trim() || cmd.busy}
                  onClick={async () => {
                    if (
                      await cmd.execute({
                        type: "rule.activate",
                        id: currentRule.id,
                        expected_version: currentRule.version,
                        expected_revision: preview.revision,
                        reviewed: true,
                        enabled: true,
                        reason,
                      })
                    ) {
                      setReason("");
                      setNotice(
                        "Rule enabled for draft suggestions. Compare again to select drafts.",
                      );
                    }
                  }}
                >
                  Enable for drafts
                </Button>
              </div>
            )}
            {!!chosen.length && (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                <p className="font-medium">
                  Fill {chosen.length} selected{" "}
                  {chosen.length === 1 ? "draft" : "drafts"}
                </p>
                <p className="text-sm">
                  {chosen[0].entry_date} to{" "}
                  {chosen[chosen.length - 1].entry_date} · Increases{" "}
                  <MaskedValue value={formatCents(totals.increase)} /> ·
                  Decreases <MaskedValue value={formatCents(totals.decrease)} />
                </p>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed the proposed categories and payees.
                </label>
                <Button
                  disabled={!reviewed || cmd.busy}
                  loading={cmd.busy}
                  onClick={async () => {
                    const n = chosen.length;
                    if (
                      await cmd.execute({
                        type: "rule.apply",
                        id: applicationId,
                        expected_revision: preview.revision,
                        entries: chosen.map((r) => ({
                          id: r.id,
                          expected_version: r.version,
                          rule_id: r.winner!.rule_id,
                          rule_version: r.winner!.version,
                        })),
                      })
                    )
                      setNotice(
                        `${n} ${n === 1 ? "draft updated" : "drafts updated"}. Review them in Transactions before posting.`,
                      );
                  }}
                >
                  Fill selected drafts
                </Button>
              </div>
            )}
          </>
        )}
      </section>
      <section className="glass-card overflow-hidden">
        <div className="flex flex-wrap justify-between gap-3 border-b border-border p-4">
          <div>
            <h3 className="font-medium">Payee aliases</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Normalize bank descriptions to a known payee. Different payees
              matching the same movement create an exception.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={demo || !state}
            onClick={() =>
              setAlias({
                id: crypto.randomUUID(),
                version: 0,
                party_id: "",
                party_name: "",
                match_mode: "exact",
                description: "",
                enabled: true,
              })
            }
          >
            <Plus size={14} />
            Add alias
          </Button>
        </div>
        {!state?.aliases.length && (
          <p className="p-5 text-sm text-muted-foreground">
            No aliases yet. Add a payee in Payees & customers first.
          </p>
        )}
        {state?.aliases.map((a) => (
          <button
            key={a.id}
            className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-border p-4 text-left text-sm last:border-0 hover:bg-secondary/30"
            onClick={() => setAlias(a)}
          >
            <span>
              {a.description}
              <span className="mt-1 block text-xs text-muted-foreground">
                {a.match_mode} · {a.enabled ? "Enabled" : "Paused"}
              </span>
            </span>
            <span>{a.party_name}</span>
          </button>
        ))}
      </section>
      {editor && (
        <RuleEditor
          rule={editor}
          data={data}
          manage={manage}
          onClose={() => setEditor(null)}
          onSaved={async (id) => {
            setEditor(null);
            setRuleId(id);
            await refresh();
            setNotice(
              "Rule saved and paused. Preview it before enabling draft suggestions.",
            );
          }}
        />
      )}
      {alias && (
        <AliasEditor
          alias={alias}
          manage={manage}
          onClose={() => setAlias(null)}
          onSaved={async () => {
            setAlias(null);
            await refresh();
            setNotice(
              "Payee alias saved. Refresh the preview to see its matches.",
            );
          }}
        />
      )}
    </div>
  );
}
function RuleEditor({
  rule,
  data,
  manage,
  onClose,
  onSaved,
}: {
  rule: AccountingRule;
  data: AccountingWorkspace;
  manage: ManageData;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [value, setValue] = useState(rule),
    [min, setMin] = useState(centsToDecimal(rule.min_cents)),
    [max, setMax] = useState(centsToDecimal(rule.max_cents)),
    [reason, setReason] = useState("");
  const cmd = useAccountingCommand();
  const set = (key: keyof AccountingRule, v: string | number | null) =>
    setValue((previous) => ({ ...previous, [key]: v }));
  const banks = data.accounts.filter(
      (a) =>
        !a.is_archived &&
        manage.profiles.some(
          (p) =>
            p.account_id === a.id &&
            ["bank", "cash", "card"].includes(p.cash_kind),
        ),
    ),
    categories = data.accounts.filter(
      (a) =>
        !a.is_archived &&
        ["income", "expense"].includes(a.account_type) &&
        !manage.profiles.some(
          (p) =>
            p.account_id === a.id &&
            ["uncategorized_income", "uncategorized_expense"].includes(
              p.purpose ?? "",
            ),
        ),
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {rule.version ? "Edit rule" : "Create a categorization rule"}
          </DialogTitle>
          <DialogDescription>
            All conditions must match. The rule changes only the uncategorized
            side of a draft. Save, preview, then enable.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const minimum = parseUsd(min),
                maximum = parseUsd(max);
              if (
                minimum < BigInt(0) ||
                maximum <= BigInt(0) ||
                minimum > maximum
              )
                throw new Error("Enter a valid positive amount range.");
              const r = await cmd.execute({
                type: "rule.save",
                id: value.id,
                expected_version: value.version,
                name: value.name,
                priority: value.priority,
                description_mode: value.description_mode,
                description: value.description,
                bank_account_id: value.bank_account_id,
                direction: value.direction,
                min_cents: minimum.toString(),
                max_cents: maximum.toString(),
                match_payee_id: value.match_payee_id,
                category_account_id: value.category_account_id,
                assign_payee_id: value.assign_payee_id,
                reason,
              });
              if (r) await onSaved(r.id);
            } catch (e) {
              cmd.setError(
                e instanceof Error ? e.message : "Check the rule conditions.",
              );
            }
          }}
        >
          <Input
            label="Rule name"
            required
            maxLength={120}
            value={value.name}
            onChange={(e) => set("name", e.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Priority (lower wins)"
              type="number"
              min={1}
              max={10000}
              required
              value={value.priority}
              onChange={(e) => set("priority", Number(e.target.value))}
            />
            <label className="text-sm">
              Bank or card account
              <select
                required
                className={selectStyle}
                value={value.bank_account_id}
                onChange={(e) => set("bank_account_id", e.target.value)}
              >
                <option value="">Choose account</option>
                {banks.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Description comparison
              <select
                className={selectStyle}
                value={value.description_mode}
                onChange={(e) => set("description_mode", e.target.value)}
              >
                <option value="exact">Exact normalized description</option>
                <option value="prefix">Starts with</option>
                <option value="contains">Contains</option>
              </select>
            </label>
            <Input
              label="Description text"
              required
              maxLength={250}
              value={value.description}
              onChange={(e) => set("description", e.target.value)}
            />
            <label className="text-sm">
              Movement direction
              <select
                className={selectStyle}
                value={value.direction}
                onChange={(e) => set("direction", e.target.value)}
              >
                <option value="decrease">Withdrawal / card charge</option>
                <option value="increase">Deposit / card payment</option>
              </select>
            </label>
            <label className="text-sm">
              Only this payee
              <select
                className={selectStyle}
                value={value.match_payee_id ?? ""}
                onChange={(e) => set("match_payee_id", e.target.value || null)}
              >
                <option value="">Any payee</option>
                {manage.parties
                  .filter((p) => !p.is_archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <Input
              label="Minimum absolute amount"
              required
              inputMode="decimal"
              value={min}
              onChange={(e) => setMin(e.target.value)}
            />
            <Input
              label="Maximum absolute amount"
              required
              inputMode="decimal"
              value={max}
              onChange={(e) => setMax(e.target.value)}
            />
            <label className="text-sm">
              Category to assign
              <select
                required
                className={selectStyle}
                value={value.category_account_id}
                onChange={(e) => set("category_account_id", e.target.value)}
              >
                <option value="">Choose category</option>
                {categories.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Payee to assign
              <select
                className={selectStyle}
                value={value.assign_payee_id ?? ""}
                onChange={(e) => set("assign_payee_id", e.target.value || null)}
              >
                <option value="">Keep current or resolved alias</option>
                {manage.parties
                  .filter((p) => !p.is_archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Descriptions ignore case and repeated spaces. Amount bounds include
            both endpoints. Transfers, split entries, and already reviewed
            categories require their own review.
          </p>
          <Input
            label="Reason for this rule or change"
            required
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            loading={cmd.busy}
            disabled={cmd.busy}
          >
            Save for preview
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function AliasEditor({
  alias,
  manage,
  onClose,
  onSaved,
}: {
  alias: PayeeAlias;
  manage: ManageData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState(alias);
  const cmd = useAccountingCommand(onSaved);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Payee alias</DialogTitle>
          <DialogDescription>
            Match a normalized description to a payee. Aliases are suggestions
            until a reviewed draft rule uses them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await cmd.execute({
              type: "alias.save",
              id: value.id,
              expected_version: value.version,
              party_id: value.party_id,
              match_mode: value.match_mode,
              description: value.description,
              enabled: value.enabled,
            });
          }}
        >
          <label className="block text-sm">
            Payee
            <select
              required
              className={selectStyle}
              value={value.party_id}
              onChange={(e) =>
                setValue((v) => ({ ...v, party_id: e.target.value }))
              }
            >
              <option value="">Choose payee</option>
              {manage.parties
                .filter((p) => !p.is_archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-sm">
            Match
            <select
              className={selectStyle}
              value={value.match_mode}
              onChange={(e) =>
                setValue((v) => ({
                  ...v,
                  match_mode: e.target.value as PayeeAlias["match_mode"],
                }))
              }
            >
              <option value="exact">Exact normalized description</option>
              <option value="prefix">Starts with</option>
            </select>
          </label>
          <Input
            label="Bank description"
            required
            maxLength={250}
            value={value.description}
            onChange={(e) =>
              setValue((v) => ({ ...v, description: e.target.value }))
            }
          />
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) =>
                setValue((v) => ({ ...v, enabled: e.target.checked }))
              }
            />
            Enable this alias
          </label>
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={cmd.busy}
            loading={cmd.busy}
          >
            Save alias
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
