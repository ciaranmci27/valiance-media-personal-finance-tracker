"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import {
  WorkflowActions,
  WorkflowDialog,
} from "@/components/features/accounting/accounting-dialog";
import { dateLabel, money } from "@/components/features/accounting/format";
import { TreatmentReview } from "@/components/features/accounting/tax-treatment-review";
import { accountingReadJson } from "@/lib/accounting/read-json";
import type { BooksFigure, BooksFigures } from "@/lib/accounting/tax-books-figures";
import { isDemoMode } from "@/lib/demo";
import { TAX_CLASSIFICATION_LABELS } from "./tax-setup-card";
import { booksFiguresUrl } from "./use-books-refresh";
import type { TaxClassification } from "@/types/database";

const GROUPS: { key: BooksFigure["group"]; title: string; hint: string }[] = [
  { key: "business", title: "Business", hint: "From the ledger, after tax treatment." },
  { key: "investments", title: "Investments", hint: "Separately stated income and gains." },
  { key: "payroll", title: "Payroll", hint: "From the verified register, or posted runs until one exists." },
];

/**
 * The figures the books can supply for the year, as a checklist. Ticked
 * figures become rows; the page decides how they are typed.
 */
export function BooksFiguresModal({
  open,
  year,
  state,
  taxClassification,
  existingKeys,
  onAdd,
  onClose,
}: {
  open: boolean;
  year: number;
  state: string | null;
  taxClassification: TaxClassification | null;
  existingKeys: ReadonlySet<string>;
  onAdd: (figures: BooksFigure[]) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <BooksFiguresDialog
      year={year}
      state={state}
      taxClassification={taxClassification}
      existingKeys={existingKeys}
      onAdd={onAdd}
      onClose={onClose}
    />
  );
}

function BooksFiguresDialog({
  year,
  state,
  taxClassification,
  existingKeys,
  onAdd,
  onClose,
}: {
  year: number;
  state: string | null;
  taxClassification: TaxClassification | null;
  existingKeys: ReadonlySet<string>;
  onAdd: (figures: BooksFigure[]) => void;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<BooksFigures | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [ticked, setTicked] = React.useState<Set<string>>(new Set());
  const [attempt, setAttempt] = React.useState(0);
  const [step, setStep] = React.useState<"figures" | "treatments">("figures");

  React.useEffect(() => {
    if (isDemoMode()) {
      setLoading(false);
      setError("The demo has no books to read from.");
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError("");
    accountingReadJson<BooksFigures>(booksFiguresUrl(year), abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setData(result);
        setTicked(
          new Set(
            result.figures
              .filter((f) => f.available && !existingKeys.has(f.key) && offerable(f, state))
              .map((f) => f.key),
          ),
        );
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(e instanceof Error && e.message ? e.message : "The books could not be read.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
    // existingKeys only seeds the default ticks; a changing set must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, attempt]);

  const figures = data?.figures ?? [];
  const selected = figures.filter((f) => ticked.has(f.key));
  const booksClassification = data?.classification ?? null;
  const classificationNote =
    booksClassification &&
    taxClassification &&
    booksClassification !== taxClassification
      ? `The books treat ${year} as ${labelFor(booksClassification)}; this estimate is set to ${TAX_CLASSIFICATION_LABELS[taxClassification]}. Rows are typed from the estimate.`
      : null;

  // Business profit held back for missing treatments: the rules can propose
  // them here, and the figures reload once they are applied.
  const profit = figures.find((f) => f.key === "business_profit");
  const treatmentGap =
    profit && !profit.available && /need a tax treatment/.test(profit.reason ?? "")
      ? Number(/^(\d+)/.exec(profit.reason ?? "")?.[1] ?? 0)
      : 0;

  if (step === "treatments" && data) {
    return (
      <WorkflowDialog title="Suggest treatments" size="md" onClose={onClose}>
        <TreatmentReview
          year={year}
          through={data.through}
          onApplied={() => {
            setStep("figures");
            setAttempt((n) => n + 1);
          }}
          onCancel={() => setStep("figures")}
        />
      </WorkflowDialog>
    );
  }

  const toggle = (key: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <WorkflowDialog title="From your books" size="md" onClose={onClose}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (selected.length === 0) return;
          onAdd(selected);
          onClose();
        }}
      >
        {data && (
          <p className="text-sm text-muted-foreground">
            Figures through {dateLabel(data.through)}. Each becomes a row you can
            top up with what you expect for the rest of the year.
          </p>
        )}

        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={16} aria-hidden="true" className="animate-spin" />
            Reading the books
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-error/40 bg-error/5 px-4 py-3 text-sm text-error">
            <span>{error}</span>
            {!isDemoMode() && (
              <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            )}
          </div>
        )}

        {!loading && !error && figures.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">
            Nothing to offer for {year} yet. Post entries and map their tax
            treatment in Tax workpapers, or post a verified payroll run.
          </p>
        )}

        {!loading &&
          GROUPS.map((group) => {
            const rows = figures.filter((f) => f.group === group.key);
            if (rows.length === 0) return null;
            return (
              <fieldset key={group.key} className="space-y-2">
                <legend className="mb-1">
                  <span className="block text-sm font-medium">{group.title}</span>
                  <span className="block text-xs text-muted-foreground">{group.hint}</span>
                </legend>
                {rows.map((figure) => {
                  const added = existingKeys.has(figure.key);
                  const needsState = !offerable(figure, state);
                  const disabled = added || !figure.available || needsState;
                  const description = added
                    ? "Already added"
                    : !figure.available
                      ? figure.reason
                      : needsState
                        ? "Set your state in the profile first"
                        : `${figure.detail} Through ${dateLabel(figure.through)}.`;
                  return (
                    <div
                      key={figure.key}
                      className="rounded-xl border border-border px-3 py-2.5"
                    >
                      <Checkbox
                        checked={ticked.has(figure.key)}
                        disabled={disabled}
                        onChange={(on) => toggle(figure.key, on)}
                        label={
                          <span className="flex items-center justify-between gap-3">
                            <span>{figure.label}</span>
                            <span className="tabular-nums">{money(figure.amount_cents)}</span>
                          </span>
                        }
                        description={description}
                      />
                      {figure.key === "business_profit" && treatmentGap > 0 && (
                        <div className="mt-2 pl-7">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setStep("treatments")}
                          >
                            Suggest treatments for {treatmentGap}{" "}
                            {treatmentGap === 1 ? "account" : "accounts"}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            );
          })}

        {(classificationNote || (data && data.notes.length > 0)) && (
          <div role="status" className="space-y-1 text-xs text-muted-foreground">
            {classificationNote && <p>{classificationNote}</p>}
            {data?.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}

        <WorkflowActions
          busy={false}
          error=""
          disabled={selected.length === 0}
          label={`Add ${selected.length} ${selected.length === 1 ? "figure" : "figures"}`}
          onClose={onClose}
        />
      </form>
    </WorkflowDialog>
  );
}

/** State withholding needs a state on the estimate to land on. */
function offerable(figure: BooksFigure, state: string | null): boolean {
  return figure.jurisdiction !== "state" || !!state;
}

function labelFor(classification: string): string {
  return (
    TAX_CLASSIFICATION_LABELS[classification as TaxClassification] ??
    classification.replace(/_/g, " ")
  );
}
