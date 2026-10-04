"use client";
import { Disclosure } from "@/components/ui/disclosure";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { NumberInput } from "@/components/ui/inputs/NumberInput";
import { useRef, useState } from "react";
import { Plus, ArrowRight } from "lucide-react";
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
import { isOpenAccount } from "@/lib/accounting/account-close";
import type { BooksMetadata } from "./types";
import {
  ruleAmountBounds,
  ruleMoney,
  ruleOutcomeSentence,
  type AccountingRule,
  type PayeeAlias,
  type RulesView,
  type RulesPreview,
  type RulePause,
  type RuleForm,
  ruleForm,
  ruleMatchesCleaned,
  ruleSaveCommand,
} from "@/lib/accounting/rules";
import { getAccountingDemoRules } from "@/lib/accounting/demo";
import { AccountingPicker } from "./accounting-picker";
import { RuleSuggestionCard } from "./accounting-rule-suggestion";
import {
  booksToday,
  dateLabel,
  enumLabel,
  money,
  timestampLabel,
} from "./format";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { useAccountingRead } from "./use-accounting-read";
import { TableSkeleton } from "@/components/ui/skeleton";

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
  const rulesRead = useAccountingRead<RulesView>(
    { view: "rules" },
    { enabled: !demo },
  );
  // The demo books have no rules table; fixed rules show every state.
  const [demoRules] = useState(() => (demo ? getAccountingDemoRules() : null));
  const state = demoRules ?? rulesRead.data ?? null;
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState(""),
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
    await rulesRead.reload();
    setPreview(null);
    setSelected(new Set());
    setReviewed(false);
    await onRefresh();
  }
  const cmd = useAccountingCommand(refresh);
  function invalidate() {
    setPreview(null);
    setSelected(new Set());
    setReviewed(false);
    setPage(0);
  }
  async function inspect(
    id = ruleId,
    offset = 0,
    range: { from: string; to: string } = { from, to },
  ) {
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
          from: range.from,
          to: range.to,
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
  const bankName = (id: string | null) =>
    id ? accountName(id) : "Any bank or card account";
  const suggestions =
    state?.rules.filter((r) => r.review_status === "suggested") ?? [];
  const ownRules =
    state?.rules.filter((r) => r.review_status !== "suggested") ?? [];
  // A suggestion is judged on everything it matches, not only the selected period.
  const evidenceRange = {
    from: manage.preferences?.history_start ?? "2000-01-01",
    to: booksToday(),
  };
  const [turningOn, setTurningOn] = useState<AccountingRule | null>(null),
    [followUp, setFollowUp] = useState<{
      rule: AccountingRule;
      count: number;
    } | null>(null),
    [filling, setFilling] = useState(false);
  const isUncategorized = (id: string) =>
    manage.profiles.some(
      (p) =>
        p.account_id === id &&
        ["uncategorized_income", "uncategorized_expense"].includes(
          p.purpose ?? "",
        ),
    );
  const ruleNames = (r: AccountingRule) => ({
    category: r.category_account_id ? accountName(r.category_account_id) : null,
    bank: r.bank_account_id ? accountName(r.bank_account_id) : null,
    contact: r.assign_payee_id
      ? (manage.parties.find((p) => p.id === r.assign_payee_id)?.name ?? null)
      : null,
  });
  function newRule(): AccountingRule {
    return {
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
    };
  }
  /**
   * Turning a suggestion on is the owner's approval. The books ask for a
   * note and a fresh version; both are filled here, read just before.
   */
  async function turnOn(r: AccountingRule) {
    cmd.setError("");
    let fresh: RulesView;
    try {
      fresh = await accountingGet<RulesView>({ view: "rules" });
    } catch (e) {
      cmd.setError(e instanceof Error ? e.message : "Unable to read the rule.");
      return;
    }
    const current = fresh.rules.find((x) => x.id === r.id);
    if (!current || current.review_status !== "suggested") {
      cmd.setError("This suggestion changed. Close this and look again.");
      return;
    }
    const ready = current.suggestion?.ready ?? 0;
    if (
      await cmd.execute({
        type: "rule.activate",
        id: current.id,
        expected_version: current.version,
        expected_revision: fresh.revision,
        reviewed: true,
        enabled: true,
        reason: current.suggested_by_name
          ? `Approved ${current.suggested_by_name}'s suggestion`
          : "Approved the suggestion",
      })
    ) {
      setTurningOn(null);
      setNotice(
        `"${current.name}" is on. ${ruleOutcomeSentence(current, ruleNames(current))}`,
      );
      setFollowUp(ready > 0 ? { rule: current, count: ready } : null);
    }
  }
  /** After turning a rule on: fill the uncategorized drafts it matches, as Preview & apply would. */
  async function fillWaiting(r: AccountingRule) {
    setFilling(true);
    setError("");
    try {
      const p = await accountingGet<RulesPreview>({
        view: "rules-preview",
        ...evidenceRange,
        rule: r.id,
        offset: "0",
      });
      const rows = p.rows
        .filter((row) => row.eligible && row.winner?.enabled)
        .slice(0, 100);
      if (!rows.length) {
        setFollowUp(null);
        setNotice("No waiting drafts match it now.");
        return;
      }
      if (
        await cmd.execute({
          type: "rule.apply",
          id: crypto.randomUUID(),
          expected_revision: p.revision,
          entries: rows.map((row) => ({
            id: row.id,
            expected_version: row.version,
            rule_id: row.winner!.rule_id,
            rule_version: row.winner!.version,
          })),
        })
      ) {
        setFollowUp(null);
        setNotice(
          `${rows.length} ${rows.length === 1 ? "draft" : "drafts"} filled. Review them in Transactions before posting.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to fill the drafts.");
    } finally {
      setFilling(false);
    }
  }
  async function dismiss(r: AccountingRule) {
    if (
      await cmd.execute({
        type: "rule.dismiss",
        id: r.id,
        expected_version: r.version,
        reason: r.suggested_by_name
          ? `Dismissed ${r.suggested_by_name}'s suggestion`
          : "Dismissed the suggestion",
      })
    )
      setNotice(`Suggestion "${r.name}" dismissed.`);
  }
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
    { key: "payee", header: "Contact", render: (a) => a.party_name },
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Rules</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use consistent treatment for recurring bank movements. Review the
            proposed categories before filling drafts.
          </p>
        </div>
        <Button disabled={demo || !state} onClick={() => setEditor(newRule())}>
          <Plus size={15} aria-hidden="true" />
          New rule
        </Button>
      </div>
      {(error || (cmd.error && !turningOn)) && (
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
          These are sample rules. Preview, edit and switch on work in your own
          books.
        </p>
      )}
      {followUp && (
        <div className="glass-card flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
          <p className="text-sm">
            {followUp.count === 1
              ? "1 uncategorized draft is waiting that this rule can fill."
              : `${followUp.count} uncategorized drafts are waiting that this rule can fill.`}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={filling}
              onClick={() => setFollowUp(null)}
            >
              Not now
            </Button>
            <Button
              size="sm"
              loading={filling}
              disabled={filling || cmd.busy}
              onClick={() => void fillWaiting(followUp.rule)}
            >
              Fill {followUp.count} waiting{" "}
              {followUp.count === 1 ? "draft" : "drafts"} now
            </Button>
          </div>
        </div>
      )}
      {suggestions.length > 0 && (
        <section aria-labelledby="rule-suggestions-title" className="space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <h3
                id="rule-suggestions-title"
                className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
              >
                Suggested rules
              </h3>
              <span className="rounded-full bg-[rgba(var(--ink),0.06)] px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums text-muted-foreground">
                {suggestions.length}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing changes until you turn one on.
            </p>
          </div>
          {suggestions.map((r) => (
            <RuleSuggestionCard
              key={r.id}
              rule={r}
              names={ruleNames(r)}
              accountName={accountName}
              isUncategorized={isUncategorized}
              from={evidenceRange.from}
              to={evidenceRange.to}
              demo={demo}
              busy={cmd.busy}
              onTurnOn={() => {
                cmd.setError("");
                setTurningOn(r);
              }}
              onEdit={() => setEditor(r)}
              onDismiss={() => void dismiss(r)}
            />
          ))}
        </section>
      )}
      <section className="glass-card overflow-hidden rounded-xl">
        <div className="border-b border-border p-4">
          <h3 className="font-medium">Your rules</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Lower priority numbers win. Equal-priority matches and conflicting
            aliases need review. Saving an edit pauses a rule until you preview
            it and switch it back on.
          </p>
        </div>
        {rulesRead.loading && !demo ? (
          <div className="p-6">
            <TableSkeleton rows={4} />
          </div>
        ) : !ownRules.length ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              No rules of your own yet.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={demo || !state}
              onClick={() => setEditor(newRule())}
            >
              <Plus size={14} aria-hidden="true" />
              New rule
            </Button>
          </div>
        ) : (
          ownRules.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 last:border-0"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="min-w-0 break-words">{r.name}</span>
                  <Badge variant={r.enabled ? "success" : "default"} size="sm">
                    {r.enabled
                      ? "On"
                      : r.paused?.cause === "never_on"
                        ? "Not on yet"
                        : "Paused"}
                  </Badge>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Priority {r.priority} · {bankName(r.bank_account_id)} ·{" "}
                  {enumLabel(
                    r.description_mode === ("equals" as string)
                      ? "exact"
                      : r.description_mode,
                  )}
                  : {r.description}
                </p>
                <p className="mt-1 text-xs">
                  {r.category_account_id
                    ? accountName(r.category_account_id)
                    : "Split categories"}{" "}
                  · <RuleAmount min={r.min_cents} max={r.max_cents} />
                </p>
                {!r.enabled && r.paused && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pausedLine(r.paused)}
                  </p>
                )}
                {!!r.history?.length && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Version history ({r.history.length})
                    </summary>
                    <div className="mt-2 max-h-64 space-y-3 overflow-auto rounded-lg bg-secondary/30 p-3">
                      {r.history?.map((h) => (
                        <div key={h.version}>
                          <p>
                            Version {h.version} · {h.enabled ? "On" : "Paused"}{" "}
                            · {timestampLabel(h.created_at)}
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            {h.reason}
                          </p>
                          <p className="mt-1">
                            Priority {h.priority} ·{" "}
                            {enumLabel(h.description_mode)}: {h.description} ·{" "}
                            {bankName(h.bank_account_id)} →{" "}
                            {accountName(h.category_account_id)}
                          </p>
                          <p>
                            <RuleAmount min={h.min_cents} max={h.max_cents} />
                          </p>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={demo || loading || cmd.busy}
                  onClick={() => {
                    setReason("");
                    void inspect(r.id).then(() =>
                      previewHeading.current?.focus(),
                    );
                  }}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={demo || cmd.busy}
                  onClick={() => setEditor(r)}
                >
                  Edit
                </Button>
                {r.enabled && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={demo || cmd.busy}
                    onClick={async () => {
                      if (
                        await cmd.execute({
                          type: "rule.activate",
                          id: r.id,
                          expected_version: r.version,
                          expected_revision: state!.revision,
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
      <section className="glass-card space-y-4 rounded-xl p-5">
        <div>
          <h3
            ref={previewHeading}
            tabIndex={-1}
            className="rounded font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Preview & apply
          </h3>
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
              { value: "", label: "All rules that are on" },
              ...(state?.rules.map((r) => ({
                value: r.id,
                label: `${r.name}${r.review_status === "suggested" ? " (suggested)" : !r.enabled ? " (paused)" : ""}`,
              })) ?? []),
            ]}
            onChange={(value) => {
              setRuleId(value);
              setReason("");
              invalidate();
            }}
          />
        </div>
        {currentRule?.review_status === "suggested" && (
          <p className="text-sm text-muted-foreground">
            This is {currentRule.suggested_by_name ?? "an agent"}&rsquo;s
            suggestion. Turn it on from{" "}
            <button
              type="button"
              className={`${linkClass} underline underline-offset-2`}
              onClick={() =>
                document
                  .getElementById(`rule-suggestion-${currentRule.id}`)
                  ?.focus()
              }
            >
              its card above
            </button>
            .
          </p>
        )}
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
                          className="text-sm tabular-nums"
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
                            : "Switch the rule on first"
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
                          {row.aliases.conflict && (
                            <p className="text-error">
                              Two contact aliases match this movement. Choose
                              the contact by hand.
                            </p>
                          )}
                          {row.aliases.aliases.map((a) => (
                            <p key={a.id}>
                              Contact alias: {a.description} → {a.name}
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
            {currentRule &&
              !currentRule.enabled &&
              currentRule.review_status !== "suggested" && (
                <div className="space-y-3 rounded-xl border border-border p-4">
                  <p className="text-sm">
                    {`Switch "${currentRule.name}" on once these matches look right.`}
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
                          "Rule switched on. Compare again to fill matching drafts.",
                        );
                      }
                    }}
                  >
                    Switch on
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
                  label="I reviewed the proposed categories and contacts."
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
      <section className="glass-card overflow-hidden rounded-xl">
        <div className="flex flex-wrap justify-between gap-3 border-b border-border p-4">
          <div>
            <h3 className="font-medium">Contact aliases</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Normalize bank descriptions to a known contact. Different contacts
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
        <div>
          <DataTable<PayeeAlias>
            framed={false}
            columns={aliasColumns}
            data={state?.aliases ?? []}
            skeletonRows={rulesRead.loading ? 3 : 0}
            keyExtractor={(a) => a.id}
            onRowClick={(a) => setAlias(a)}
            emptyState="No aliases yet. Add a contact under Contacts first."
            mobileCard={(a) => (
              <div className="text-sm">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className={`${linkClass} min-w-0 truncate font-medium`}
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
      {turningOn && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !cmd.busy) setTurningOn(null);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Turn on this rule</DialogTitle>
              <DialogDescription>
                {ruleOutcomeSentence(turningOn, ruleNames(turningOn))} Nothing
                already in the books changes.
              </DialogDescription>
            </DialogHeader>
            {cmd.error && (
              <p role="alert" className="mt-3 text-sm text-error">
                {cmd.error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                disabled={cmd.busy}
                onClick={() => setTurningOn(null)}
              >
                Cancel
              </Button>
              <Button
                loading={cmd.busy}
                disabled={cmd.busy}
                onClick={() => void turnOn(turningOn)}
              >
                Turn on
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {editor && (
        <RuleEditor
          rule={editor}
          data={data}
          manage={manage}
          onClose={() => setEditor(null)}
          onSaved={async (id) => {
            const wasSuggestion = editor.review_status === "suggested";
            setEditor(null);
            setRuleId(id);
            await refresh();
            setNotice(
              wasSuggestion
                ? "Saved as your rule. It stays paused until you preview it and switch it on."
                : "Rule saved and paused. Preview it to switch it on.",
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
              "Contact alias saved. Refresh the preview to see its matches.",
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
  const banks = data.accounts.filter(
      (a) =>
        isOpenAccount(a) &&
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
  // With one bank or card account the condition is implied, so it starts
  // filled and lives under Advanced. With several it stays visible.
  // A rule without an account, a direction or an amount bound matches any;
  // editing keeps it that way instead of narrowing it to a default. Fields
  // left as they were are saved exactly as stored (ruleSaveCommand).
  const suggested = rule.version > 0 && rule.review_status === "suggested";
  const cleaned = rule.version > 0 && ruleMatchesCleaned(rule);
  const splits = !!rule.actions && "splits" in rule.actions;
  const [initial] = useState(() => {
    const start = ruleForm(rule);
    if (rule.version === 0 && !start.bank_account_id)
      start.bank_account_id = banks[0]?.id ?? "";
    return start;
  });
  const [value, setValue] = useState(initial),
    [changingMatch, setChangingMatch] = useState(!cleaned),
    [reason, setReason] = useState("");
  const cmd = useAccountingCommand();
  const set = <K extends keyof RuleForm>(key: K, v: RuleForm[K]) =>
    setValue((previous) => ({ ...previous, [key]: v }));
  const modeLabel = {
    contains: "Contains",
    prefix: "Starts with",
    exact: "Is exactly",
  };
  const bankPicker = (
    <AccountingPicker
      label="Bank or card account"
      visibleLabel="Bank or card account"
      value={value.bank_account_id}
      options={[
        { value: "", label: "Any bank or card account" },
        ...banks.map((a) => ({ value: a.id, label: a.name })),
      ]}
      onChange={(v) => set("bank_account_id", v)}
    />
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !cmd.busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {suggested
              ? "Edit suggestion"
              : rule.version
                ? "Edit rule"
                : "New rule"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Match bank descriptions to a category. Saving pauses the rule until
            its preview is approved.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await cmd.execute(
                ruleSaveCommand(rule, initial, value, reason) as Parameters<
                  typeof cmd.execute
                >[0],
              );
              if (r) await onSaved(r.id);
            } catch (e) {
              cmd.setError(
                e instanceof Error ? e.message : "Check the rule conditions.",
              );
            }
          }}
        >
          <TextInput
            label="Name"
            required
            maxLength={120}
            value={value.name}
            onChange={(nextValue) => set("name", nextValue)}
          />
          {changingMatch ? (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_1fr]">
              <Select
                label="Match"
                value={value.description_mode}
                options={(["contains", "prefix", "exact"] as const).map(
                  (mode) => ({ value: mode, label: modeLabel[mode] }),
                )}
                onChange={(v) =>
                  set("description_mode", v as RuleForm["description_mode"])
                }
              />
              <TextInput
                label={
                  cleaned ? "Bank description (cleaned)" : "Bank description"
                }
                required
                maxLength={250}
                autoFocus={cleaned}
                value={value.description}
                onChange={(nextValue) => set("description", nextValue)}
              />
            </div>
          ) : (
            // A rule on the cleaned description stays exactly as stored until the owner changes it.
            <div>
              <p id={`${rule.id}-match`} className="text-sm font-medium">
                Bank description (cleaned)
              </p>
              <div className="mt-1.5 flex items-center justify-between gap-3 rounded-lg bg-[rgba(var(--ink),0.03)] px-3 py-2 shadow-[inset_0_0_0_1px_rgba(var(--ink),0.08)]">
                <p
                  aria-labelledby={`${rule.id}-match`}
                  className="min-w-0 break-words text-sm"
                >
                  {modeLabel[value.description_mode]}: {value.description}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Change the bank description this rule matches"
                  onClick={() => setChangingMatch(true)}
                >
                  Change
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Matched without dates and reference numbers. It stays as it is
                unless you change it.
              </p>
            </div>
          )}
          <AccountingPicker
            label="Category"
            visibleLabel="Category"
            required={!splits}
            placeholder={
              splits ? "Split across categories (unchanged)" : "Choose category"
            }
            value={value.category_account_id}
            options={categories.map((a) => ({ value: a.id, label: a.name }))}
            onChange={(v) => set("category_account_id", v)}
          />
          {banks.length > 1 && bankPicker}
          <TextInput
            label="Reason"
            required
            maxLength={1000}
            value={reason}
            onChange={(nextValue) => setReason(nextValue)}
          />
          <Disclosure summary="Advanced" contentClassName="space-y-4">
            {banks.length <= 1 && bankPicker}
            <Select
              label="Direction"
              value={value.direction}
              options={[
                { value: "", label: "Money in or out" },
                { value: "decrease", label: "Withdrawal or card charge" },
                { value: "increase", label: "Deposit or card payment" },
              ]}
              onChange={(v) => set("direction", v as RuleForm["direction"])}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Minimum amount"
                placeholder="No minimum"
                inputMode="decimal"
                value={value.min}
                onChange={(nextValue) => set("min", nextValue)}
              />
              <TextInput
                label="Maximum amount"
                placeholder="No maximum"
                inputMode="decimal"
                value={value.max}
                onChange={(nextValue) => set("max", nextValue)}
              />
            </div>
            <NumberInput
              step={1}
              label="Priority"
              description="Lower wins."
              min={1}
              max={10000}
              required
              value={value.priority}
              onChange={(nextValue) =>
                set("priority", Number(String(nextValue)))
              }
            />
            <AccountingPicker
              label="Only this contact"
              visibleLabel="Only this contact"
              value={value.match_payee_id}
              options={[{ value: "", label: "Any contact" }, ...payees]}
              onChange={(v) => set("match_payee_id", v)}
            />
            <AccountingPicker
              label="Assign contact"
              visibleLabel="Assign contact"
              value={value.assign_payee_id}
              options={[
                { value: "", label: "Keep current or resolved alias" },
                ...payees,
              ]}
              onChange={(v) => set("assign_payee_id", v)}
            />
          </Disclosure>
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={cmd.busy}
              disabled={cmd.busy || (!value.category_account_id && !splits)}
            >
              {suggested ? "Save as my rule" : "Save"}
            </Button>
          </div>
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {alias.version ? "Edit alias" : "New alias"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Match a bank description to a contact.
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-5"
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
            label="Contact"
            visibleLabel="Contact"
            required
            placeholder="Choose contact"
            value={value.party_id}
            options={manage.parties
              .filter((p) => !p.is_archived)
              .map((p) => ({ value: p.id, label: p.name }))}
            onChange={(party_id) => setValue((v) => ({ ...v, party_id }))}
          />
          <TextInput
            label="Bank description"
            description="Case and extra spaces are ignored."
            required
            maxLength={250}
            value={value.description}
            onChange={(nextValue) =>
              setValue((v) => ({ ...v, description: nextValue }))
            }
          />
          <Disclosure summary="Advanced" contentClassName="space-y-4">
            <Select
              label="Match"
              value={value.match_mode}
              options={[
                { value: "exact", label: "Is exactly" },
                { value: "prefix", label: "Starts with" },
              ]}
              onChange={(mode) =>
                setValue((v) => ({
                  ...v,
                  match_mode: mode as PayeeAlias["match_mode"],
                }))
              }
            />
            <Toggle
              checked={value.enabled}
              onChange={(enabled) => setValue((v) => ({ ...v, enabled }))}
              label="Enabled"
            />
          </Disclosure>
          {cmd.error && (
            <p role="alert" className="text-sm text-error">
              {cmd.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={cmd.busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={cmd.busy || !value.party_id}
              loading={cmd.busy}
            >
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
/** A rule's amount range in words, with the amounts masked in privacy mode. */
function RuleAmount({
  min,
  max,
}: {
  min: string | null | undefined;
  max: string | null | undefined;
}) {
  const b = ruleAmountBounds(min, max);
  if (b.min && b.max)
    return (
      <>
        <MaskedValue value={ruleMoney(b.min)} /> to{" "}
        <MaskedValue value={ruleMoney(b.max)} />
      </>
    );
  if (b.min)
    return (
      <>
        <MaskedValue value={ruleMoney(b.min)} /> or more
      </>
    );
  if (b.max)
    return (
      <>
        up to <MaskedValue value={ruleMoney(b.max)} />
      </>
    );
  return <>any amount</>;
}
/** Why one of the owner's rules is off, and how to switch it back on. */
function pausedLine(p: RulePause): string {
  const day = dateLabel(booksToday(new Date(p.at)));
  switch (p.cause) {
    case "never_on":
      return "Not switched on yet. Preview it to switch it on.";
    case "edited":
      return `Paused after an edit on ${day}. Preview it to switch it back on.`;
    case "paused":
      return `Paused by you on ${day}. Preview it to switch it back on.`;
    default:
      return `Paused since ${day}. Preview it to switch it back on.`;
  }
}
