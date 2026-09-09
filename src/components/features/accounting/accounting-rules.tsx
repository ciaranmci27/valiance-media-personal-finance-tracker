"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { NumberInput } from "@/components/ui/inputs/NumberInput";
import { useEffect, useState } from "react";
import { Plus, ArrowRight, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/inputs/Select";
import { Toggle } from "@/components/ui/inputs/Toggle";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { AccountingWorkspace } from "@/lib/accounting/contracts";
import type { BooksMetadata } from "./types";
import type {
  AccountingRule,
  PayeeAlias,
  RulesView,
  RulesPreview,
} from "@/lib/accounting/rules";
import { parseUsd, centsToDecimal } from "@/lib/accounting/money";
import { AccountingPicker } from "./accounting-picker";
import { dateLabel, enumLabel, money, timestampLabel } from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

const PREVIEW_PAGE = 100;
const linkClass =
  "rounded text-left transition-colors hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AccountingRules({
  data,
  manage,
  demo,
  onRefresh,
  onEntry,
}: {
  data: AccountingWorkspace;
  manage: BooksMetadata;
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
          offset: String(offset * PREVIEW_PAGE),
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
  const aliasStatus = (a: PayeeAlias) => (
    <Badge variant={a.enabled ? "success" : "default"} size="sm">
      {a.enabled ? "Enabled" : "Paused"}
    </Badge>
  );
  const aliasColumns: DataTableColumn<PayeeAlias>[] = [
    {
      key: "description",
      header: "Bank description",
      render: (a) => (
        <button
          type="button"
          className={linkClass}
          onClick={(e) => {
            e.stopPropagation();
            setAlias(a);
          }}
        >
          {a.description}
        </button>
      ),
    },
    {
      key: "match",
      header: "Match",
      render: (a) => (
        <span className="text-muted-foreground">{enumLabel(a.match_mode)}</span>
      ),
    },
    { key: "status", header: "Status", render: aliasStatus },
    { key: "payee", header: "Payee", render: (a) => a.party_name },
  ];
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
          <Plus size={15} aria-hidden="true" />
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
            <SlidersHorizontal className="mb-3" size={22} aria-hidden="true" />
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
                  <Badge
                    variant={r.enabled ? "success" : "default"}
                    size="sm"
                    className="ml-2"
                  >
                    {r.enabled ? "Enabled for drafts" : "Paused"}
                  </Badge>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Priority {r.priority} · {accountName(r.bank_account_id)} ·{" "}
                  {enumLabel(r.description_mode)}: {r.description}
                </p>
                <p className="mt-1 text-xs">
                  {accountName(r.category_account_id)} ·{" "}
                  <MaskedValue value={money(r.min_cents)} /> to{" "}
                  <MaskedValue value={money(r.max_cents)} />
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
                          {timestampLabel(h.created_at)}
                        </p>
                        <p className="mt-1 text-muted-foreground">{h.reason}</p>
                        <p className="mt-1">
                          Priority {h.priority} ·{" "}
                          {enumLabel(h.description_mode)}: {h.description} ·{" "}
                          {accountName(h.bank_account_id)} →{" "}
                          {accountName(h.category_account_id)}
                        </p>
                        <p>
                          <MaskedValue value={money(h.min_cents)} /> to{" "}
                          <MaskedValue value={money(h.max_cents)} />
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
          <DateInput
            label="Preview from"
            disabled={loading || cmd.busy}
            value={from}
            onChange={(nextValue) => {
              setFrom(nextValue);
              invalidate();
            }}
          />
          <DateInput
            label="Preview through"
            disabled={loading || cmd.busy}
            value={to}
            minDate={from}
            onChange={(nextValue) => {
              setTo(nextValue);
              invalidate();
            }}
          />
          <AccountingPicker
            label="Rule"
            visibleLabel="Rule"
            value={ruleId}
            disabled={loading || cmd.busy}
            options={[
              { value: "", label: "All enabled rules" },
              ...(state?.rules.map((r) => ({
                value: r.id,
                label: `${r.name}${!r.enabled ? " (paused)" : ""}`,
              })) ?? []),
            ]}
            onChange={(value) => {
              setRuleId(value);
              invalidate();
            }}
          />
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
                    <Checkbox
                      size="sm"
                      className="mt-1 shrink-0"
                      ariaLabel={`Select ${row.memo}`}
                      checked={selected.has(row.id)}
                      disabled={
                        !row.eligible || !row.winner?.enabled || cmd.busy
                      }
                      onChange={(checked) => {
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(row.id);
                          else next.delete(row.id);
                          return next;
                        });
                        setReviewed(false);
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap justify-between gap-2">
                        <button
                          type="button"
                          className="rounded text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onEntry(row.id)}
                        >
                          {row.memo}
                        </button>
                        <MaskedValue
                          className="font-mono text-sm tabular-nums"
                          value={money(row.bank_amount_cents)}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dateLabel(row.entry_date)} ·{" "}
                        {accountName(row.bank_account_id)} ·{" "}
                        {enumLabel(row.status)}
                      </p>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        {accountName(row.category_account_id)}
                        <ArrowRight size={13} aria-hidden="true" />
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
                                className="tabular-nums"
                                value={money(l.amount_cents)}
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
            <Pagination
              offset={page * PREVIEW_PAGE}
              limit={PREVIEW_PAGE}
              total={preview.total}
              busy={loading || cmd.busy}
              onChange={(offset) => void inspect(ruleId, offset / PREVIEW_PAGE)}
            />
            {currentRule && !currentRule.enabled && (
              <div className="space-y-3 glass-card rounded-xl p-4">
                <p className="text-sm">
                  Enable “{currentRule.name}” for draft suggestions after
                  reviewing its conditions and matches.
                </p>
                <TextInput
                  label="Rule approval note"
                  value={reason}
                  onChange={(nextValue) => setReason(nextValue)}
                  maxLength={1000}
                />
                <Checkbox
                  className="items-start text-left"
                  checked={reviewed}
                  onChange={setReviewed}
                  label="I reviewed these conditions and the matching transactions."
                />
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
                  {dateLabel(chosen[0].entry_date)} to{" "}
                  {dateLabel(chosen[chosen.length - 1].entry_date)} · Increases{" "}
                  <MaskedValue value={money(totals.increase)} /> · Decreases{" "}
                  <MaskedValue value={money(totals.decrease)} />
                </p>
                <Checkbox
                  className="items-start text-left"
                  checked={reviewed}
                  onChange={setReviewed}
                  label="I reviewed the proposed categories and payees."
                />
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
            <Plus size={14} aria-hidden="true" />
            Add alias
          </Button>
        </div>
        <div className="p-4 lg:p-0">
          <DataTable<PayeeAlias>
            framed={false}
            columns={aliasColumns}
            data={state?.aliases ?? []}
            keyExtractor={(a) => a.id}
            onRowClick={(a) => setAlias(a)}
            emptyState="No aliases yet. Add a payee in Payees & customers first."
            mobileCard={(a) => (
              <div className="glass-card rounded-xl p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className={`${linkClass} min-w-0 font-medium`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAlias(a);
                    }}
                  >
                    {a.description}
                  </button>
                  {aliasStatus(a)}
                </div>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {enumLabel(a.match_mode)}
                  </span>
                  <span>{a.party_name}</span>
                </div>
              </div>
            )}
          />
        </div>
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
  manage: BooksMetadata;
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
  const payees = manage.parties
    .filter((p) => !p.is_archived)
    .map((p) => ({ value: p.id, label: p.name }));
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
          <TextInput
            label="Rule name"
            required
            maxLength={120}
            value={value.name}
            onChange={(nextValue) => set("name", nextValue)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberInput
              step={1}
              label="Priority (lower wins)"
              min={1}
              max={10000}
              required
              value={value.priority}
              onChange={(nextValue) =>
                set("priority", Number(String(nextValue)))
              }
            />
            <AccountingPicker
              label="Bank or card account"
              visibleLabel="Bank or card account"
              required
              placeholder="Choose account"
              value={value.bank_account_id}
              options={banks.map((a) => ({ value: a.id, label: a.name }))}
              onChange={(v) => set("bank_account_id", v)}
            />
            <Select
              label="Description comparison"
              value={value.description_mode}
              options={[
                { value: "exact", label: "Exact normalized description" },
                { value: "prefix", label: "Starts with" },
                { value: "contains", label: "Contains" },
              ]}
              onChange={(v) => set("description_mode", v)}
            />
            <TextInput
              label="Description text"
              required
              maxLength={250}
              value={value.description}
              onChange={(nextValue) => set("description", nextValue)}
            />
            <Select
              label="Movement direction"
              value={value.direction}
              options={[
                { value: "decrease", label: "Withdrawal / card charge" },
                { value: "increase", label: "Deposit / card payment" },
              ]}
              onChange={(v) => set("direction", v)}
            />
            <AccountingPicker
              label="Only this payee"
              visibleLabel="Only this payee"
              value={value.match_payee_id ?? ""}
              options={[{ value: "", label: "Any payee" }, ...payees]}
              onChange={(v) => set("match_payee_id", v || null)}
            />
            <TextInput
              label="Minimum absolute amount"
              required
              inputMode="decimal"
              value={min}
              onChange={(nextValue) => setMin(nextValue)}
            />
            <TextInput
              label="Maximum absolute amount"
              required
              inputMode="decimal"
              value={max}
              onChange={(nextValue) => setMax(nextValue)}
            />
            <AccountingPicker
              label="Category to assign"
              visibleLabel="Category to assign"
              required
              placeholder="Choose category"
              value={value.category_account_id}
              options={categories.map((a) => ({ value: a.id, label: a.name }))}
              onChange={(v) => set("category_account_id", v)}
            />
            <AccountingPicker
              label="Payee to assign"
              visibleLabel="Payee to assign"
              value={value.assign_payee_id ?? ""}
              options={[
                { value: "", label: "Keep current or resolved alias" },
                ...payees,
              ]}
              onChange={(v) => set("assign_payee_id", v || null)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Descriptions ignore case and repeated spaces. Amount bounds include
            both endpoints. Transfers, split entries, and already reviewed
            categories require their own review.
          </p>
          <TextInput
            label="Reason for this rule or change"
            required
            maxLength={1000}
            value={reason}
            onChange={(nextValue) => setReason(nextValue)}
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
            disabled={
              cmd.busy || !value.bank_account_id || !value.category_account_id
            }
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
  manage: BooksMetadata;
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
          <AccountingPicker
            label="Payee"
            visibleLabel="Payee"
            required
            placeholder="Choose payee"
            value={value.party_id}
            options={manage.parties
              .filter((p) => !p.is_archived)
              .map((p) => ({ value: p.id, label: p.name }))}
            onChange={(party_id) => setValue((v) => ({ ...v, party_id }))}
          />
          <Select
            label="Match"
            value={value.match_mode}
            options={[
              { value: "exact", label: "Exact normalized description" },
              { value: "prefix", label: "Starts with" },
            ]}
            onChange={(mode) =>
              setValue((v) => ({
                ...v,
                match_mode: mode as PayeeAlias["match_mode"],
              }))
            }
          />
          <TextInput
            label="Bank description"
            required
            maxLength={250}
            value={value.description}
            onChange={(nextValue) =>
              setValue((v) => ({ ...v, description: nextValue }))
            }
          />
          <Toggle
            checked={value.enabled}
            onChange={(enabled) => setValue((v) => ({ ...v, enabled }))}
            label="Enable this alias"
          />
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={cmd.busy || !value.party_id}
            loading={cmd.busy}
          >
            Save alias
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
