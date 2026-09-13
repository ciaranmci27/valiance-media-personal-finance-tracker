"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { Select } from "@/components/ui/inputs/Select";
import { MaskedValue } from "@/components/ui/masked-value";
import { cn } from "@/lib/utils";
import {
  taxConcepts,
  taxWorkpaperCommandSchema,
  type TaxConcept,
  type TaxSource,
} from "@/lib/accounting/tax-workpapers";
import {
  conceptsFor,
  deductibleBpsFor,
  suggestTreatments,
  type TreatmentSource,
} from "@/lib/accounting/tax-treatment-rules";
import type { AccountProfile, WorkflowCommand } from "@/lib/accounting/workflows";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { money } from "./format";

interface ReviewRow {
  account_id: string;
  name: string;
  code: string;
  account_type: "income" | "expense";
  book_cents: string;
  /** The proposed or chosen concept; null until the owner picks one. */
  concept: TaxConcept | null;
  /** Why the rule proposed it, or why none did. */
  reason: string;
  source: TreatmentSource | "owner" | null;
  confidence: "certain" | "likely" | null;
  selected: boolean;
  /** Minted once so a retry reuses the same idempotency key. */
  commandId: string;
}

/**
 * Rule-based treatment suggestions for the accounts that still need one,
 * with a "needs your pick" group for anything no rule fits. Applying writes
 * the ordinary mapping command per account.
 */
export function TreatmentReview({
  year,
  through,
  onApplied,
  onCancel,
}: {
  year: number;
  through: string;
  onApplied: () => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cmd = useAccountingCommand();

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setReviewed(false);
    Promise.all([
      accountingGet<TaxSource>(
        { view: "tax-workpapers", year: String(year), through },
        abort.signal,
      ),
      accountingGet<{ profiles?: AccountProfile[] }>({ view: "manage" }, abort.signal),
      accountingGet<TaxSource>(
        { view: "tax-workpapers", year: String(year - 1), through: `${year - 1}-12-31` },
        abort.signal,
      ).catch(() => null),
    ])
      .then(([source, manage, prior]) => {
        if (abort.signal.aborted) return;
        const { suggestions, review } = suggestTreatments({
          source,
          profiles: manage.profiles ?? [],
          prior,
        });
        setRows([
          ...suggestions.map<ReviewRow>((s) => ({
            account_id: s.account_id,
            name: s.name,
            code: s.code,
            account_type: s.account_type,
            book_cents: s.book_cents,
            concept: s.concept,
            reason: s.reason,
            source: s.source,
            confidence: s.confidence,
            selected: true,
            commandId: crypto.randomUUID(),
          })),
          ...review.map<ReviewRow>((r) => ({
            account_id: r.account_id,
            name: r.name,
            code: r.code,
            account_type: r.account_type,
            book_cents: r.book_cents,
            concept: null,
            reason: r.reason,
            source: null,
            confidence: null,
            selected: false,
            commandId: crypto.randomUUID(),
          })),
        ]);
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) {
          setError(e instanceof Error && e.message ? e.message : "The books could not be read.");
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [year, through, attempt]);

  const suggested = useMemo(() => rows?.filter((r) => r.source !== null) ?? [], [rows]);
  const needsPick = useMemo(() => rows?.filter((r) => r.source === null) ?? [], [rows]);
  const chosen = useMemo(
    () => rows?.filter((r) => r.selected && r.concept !== null) ?? [],
    [rows],
  );

  const update = (id: string, patch: Partial<ReviewRow>) => {
    setReviewed(false);
    setRows((prev) => prev?.map((r) => (r.account_id === id ? { ...r, ...patch } : r)) ?? prev);
  };

  async function apply() {
    if (!rows || chosen.length === 0) return;
    const commands: WorkflowCommand[] = chosen.map((r) =>
      taxWorkpaperCommandSchema.parse({
        type: "tax.mapping",
        id: r.commandId,
        year,
        expected_version: 0,
        document_id: null,
        reason:
          r.source === "owner"
            ? "Chosen by owner."
            : `Suggested: ${r.reason}. Accepted by owner.`,
        verified: true,
        account_id: r.account_id,
        concept: r.concept,
        deductible_bps: deductibleBpsFor(r.concept as TaxConcept),
      }),
    );
    const result = await cmd.executeMany(commands);
    if (result.failed) {
      // The loop stops at the first failure, so the leading rows landed.
      // Drop them so a retry does not resend what was saved.
      const landed = new Set(chosen.slice(0, result.saved.length).map((r) => r.account_id));
      setRows((prev) => prev?.filter((r) => !landed.has(r.account_id)) ?? prev);
      setReviewed(false);
      return;
    }
    onApplied();
  }

  const conceptOptions = (type: "income" | "expense") =>
    conceptsFor(type).map((c) => ({ value: c, label: taxConcepts[c] }));

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Each account still needing a treatment for {year}, with the rule that
        placed it. Change a pick if it is wrong, untick what you are not sure
        about, and apply.
      </p>

      {loading && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 size={16} aria-hidden="true" className="animate-spin" />
          Reading the books
        </div>
      )}

      {!loading && error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error/40 bg-error/5 px-4 py-3 text-sm text-error"
        >
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && rows && rows.length === 0 && (
        <p className="py-4 text-sm text-muted-foreground">
          Every account with activity in {year} already has a treatment.
        </p>
      )}

      {!loading && suggested.length > 0 && (
        <Group
          title="Suggested"
          hint="From last year, the account's purpose, its name or its report group."
        >
          {suggested.map((row) => (
            <Row
              key={row.account_id}
              row={row}
              busy={cmd.busy}
              options={conceptOptions(row.account_type)}
              onSelect={(selected) => update(row.account_id, { selected })}
              onConcept={(concept) =>
                update(row.account_id, { concept, source: "owner", reason: "Chosen by you" })
              }
            />
          ))}
        </Group>
      )}

      {!loading && needsPick.length > 0 && (
        <Group
          title="Needs your pick"
          hint="No rule fits these. Choose a treatment to include them."
        >
          {needsPick.map((row) => (
            <Row
              key={row.account_id}
              row={row}
              busy={cmd.busy}
              options={conceptOptions(row.account_type)}
              onSelect={(selected) => update(row.account_id, { selected })}
              onConcept={(concept) => update(row.account_id, { concept, selected: true })}
            />
          ))}
        </Group>
      )}

      {cmd.error && (
        <p role="alert" className="text-sm text-error">
          {cmd.error}
        </p>
      )}

      {!loading && rows && rows.length > 0 && (
        <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="font-medium">
            Apply {chosen.length} {chosen.length === 1 ? "treatment" : "treatments"}
          </p>
          <p className="text-sm text-muted-foreground">
            Each becomes this year&apos;s treatment for its account, with the
            rule recorded as the note. You can change any of them later in Tax
            workpapers.
          </p>
          <Checkbox
            className="items-start text-left"
            checked={reviewed}
            onChange={setReviewed}
            label="I reviewed the proposed treatments."
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!reviewed || chosen.length === 0 || cmd.busy}
              loading={cmd.busy}
              onClick={() => void apply()}
            >
              Apply {chosen.length === 1 ? "treatment" : "treatments"}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={cmd.busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!loading && rows && rows.length === 0 && (
        <div>
          <Button variant="ghost" onClick={onCancel}>
            Back
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-2 divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({
  row,
  busy,
  options,
  onSelect,
  onConcept,
}: {
  row: ReviewRow;
  busy: boolean;
  options: { value: string; label: string }[];
  onSelect: (selected: boolean) => void;
  onConcept: (concept: TaxConcept) => void;
}) {
  const tone =
    row.source === null
      ? "text-warning"
      : row.confidence === "certain" || row.source === "owner"
        ? "text-teal-light"
        : "text-muted-foreground";
  return (
    <div className="py-3">
      <div className="flex gap-3">
        <Checkbox
          size="sm"
          className="mt-1 shrink-0"
          ariaLabel={`Include ${row.name}`}
          checked={row.selected}
          disabled={row.concept === null || busy}
          onChange={onSelect}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium">
              {row.name}
              {row.code && (
                <span className="ml-2 text-xs text-muted-foreground">{row.code}</span>
              )}
            </span>
            <MaskedValue className="text-sm tabular-nums" value={money(row.book_cents)} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Choose tax treatment</span>
            <ArrowRight size={13} aria-hidden="true" className="text-muted-foreground" />
            <Select
              ariaLabel={`Treatment for ${row.name}`}
              size="sm"
              compact
              value={row.concept ?? ""}
              placeholder="Pick a treatment"
              options={options}
              disabled={busy}
              onChange={(value) => onConcept(value as TaxConcept)}
            />
          </div>
          <p className={cn("mt-1 text-xs", tone)}>{row.reason}</p>
        </div>
      </div>
    </div>
  );
}
