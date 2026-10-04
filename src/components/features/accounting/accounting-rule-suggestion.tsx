"use client";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { MaskedValue } from "@/components/ui/masked-value";
import { TableSkeleton } from "@/components/ui/skeleton";
import { getAccountingDemoRuleEvidence } from "@/lib/accounting/demo";
import {
  ruleEvidenceLine,
  ruleNoun,
  ruleOutcomeSentence,
  type AccountingRule,
  type RuleEvidenceRow,
} from "@/lib/accounting/rules";
import { absMoney, dateLabel } from "./format";
import { useAccountingRead } from "./use-accounting-read";

/** How many past matches a card lists before "and N more". */
const SHOWN = 5;

export interface RuleNames {
  category: string | null;
  bank: string | null;
  contact: string | null;
}

/** Initials for the suggester's avatar: "Alex A." reads as "AA". */
function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  );
}

/**
 * One rule an agent suggested, as a self-contained review: what happens from
 * now on, the past transactions it matches and where they sit today, the
 * agent's reasoning behind a disclosure, and the owner's three answers.
 */
export function RuleSuggestionCard({
  rule,
  names,
  accountName,
  isUncategorized,
  from,
  to,
  demo,
  busy,
  onTurnOn,
  onEdit,
  onDismiss,
}: {
  rule: AccountingRule;
  names: RuleNames;
  accountName: (id: string) => string;
  isUncategorized: (id: string) => boolean;
  from: string;
  to: string;
  demo: boolean;
  busy: boolean;
  onTurnOn: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}) {
  const evidenceRead = useAccountingRead<{
    total: number;
    rows: RuleEvidenceRow[];
  }>(
    { view: "rules-preview", from, to, rule: rule.id, offset: "0" },
    { enabled: !demo },
  );
  const evidence = demo
    ? getAccountingDemoRuleEvidence(rule.id)
    : evidenceRead.data;
  // Newest first; the preview reads oldest first.
  const rows = [...(evidence?.rows ?? [])]
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date))
    .slice(0, SHOWN);
  const more = Math.max(0, (evidence?.total ?? 0) - rows.length);
  const agent = rule.suggested_by_name ?? "An agent";
  const titleId = `rule-suggestion-${rule.id}`;
  const noun = ruleNoun(rule.direction as string | null);

  /** Where a past match sits today, against the category the rule would use. */
  function where(row: RuleEvidenceRow) {
    const categories = row.lines.filter(
      (l) => l.account_id !== row.bank_account_id,
    );
    if (categories.length !== 1)
      return <span className="text-muted-foreground">Split</span>;
    const id = categories[0].account_id;
    if (id === rule.category_account_id)
      return (
        <span className="flex items-center gap-1.5">
          <Check size={13} aria-hidden="true" className="text-success" />
          <span className="sr-only">Already in </span>
          {accountName(id)}
        </span>
      );
    if (isUncategorized(id))
      return <span className="text-muted-foreground">Not categorized yet</span>;
    return (
      <span className="flex items-center gap-1.5">
        {accountName(id)}
        <Badge size="sm">Different</Badge>
      </span>
    );
  }

  return (
    <article
      aria-labelledby={titleId}
      className="glass-card relative overflow-hidden rounded-xl p-4 lg:p-5"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 z-[1] w-[3px] bg-primary"
      />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/14 text-[10px] font-semibold text-teal-light"
        >
          {initials(agent)}
        </span>
        Suggested by {agent}
      </p>
      <h4
        id={titleId}
        tabIndex={-1}
        className="mt-2.5 rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {rule.name}
      </h4>
      <p className="mt-1 text-sm">{ruleOutcomeSentence(rule, names)}</p>

      <div className="mt-4">
        <p className="text-xs text-muted-foreground">
          {ruleEvidenceLine(rule, names.category)}
        </p>
        {!demo && evidenceRead.loading ? (
          <div className="mt-2">
            <TableSkeleton rows={3} />
          </div>
        ) : !demo && evidenceRead.error ? (
          <p className="mt-2 text-xs text-muted-foreground">
            The past {noun.many} it matches could not load. Reload the page to
            see them.
          </p>
        ) : (
          rows.length > 0 && (
            <>
              <ul
                aria-label={`Past ${noun.many} this rule matches`}
                className="mt-2 divide-y divide-border rounded-lg bg-[rgba(var(--ink),0.03)] shadow-[inset_0_0_0_1px_rgba(var(--ink),0.08)]"
              >
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
                  >
                    <span className="flex items-baseline gap-3">
                      <span className="w-24 text-xs tabular-nums text-muted-foreground">
                        {dateLabel(row.entry_date)}
                      </span>
                      <MaskedValue
                        className="tabular-nums"
                        value={absMoney(row.bank_amount_cents)}
                      />
                    </span>
                    <span className="text-xs">{where(row)}</span>
                  </li>
                ))}
              </ul>
              {more > 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  and {more} more
                </p>
              )}
            </>
          )
        )}
      </div>

      {rule.suggestion?.note && (
        <Disclosure
          summary={`Why ${agent} suggested this`}
          className="-mx-4 mt-2 border-transparent"
          contentClassName="border-t-0 px-4 pb-1 pt-0 text-xs leading-relaxed text-muted-foreground"
        >
          {rule.suggestion.note}
        </Disclosure>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={demo || busy}
          aria-label={`Turn on ${rule.name}`}
          onClick={onTurnOn}
        >
          Turn on
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={demo || busy}
          aria-label={`Edit ${rule.name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={demo || busy}
          aria-label={`Dismiss ${rule.name}`}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </article>
  );
}
