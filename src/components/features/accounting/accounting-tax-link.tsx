"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight, History, Link2, RefreshCw, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { useAccountingTaxLink } from "../tax/use-accounting-tax-link";
import {
  taxLinkCommandSchema,
  type TaxLinkView,
} from "@/lib/accounting/tax-links";
import type { TaxSource } from "@/lib/accounting/tax-workpapers";
import { useAccountingCommand } from "./use-accounting-command";
import { WorkflowActions, WorkflowDialog } from "./accounting-dialog";
import { AccountingTaxLinkEditor } from "./accounting-tax-link-editor";
import { dateLabel, money, timestampLabel } from "./format";

export function AccountingTaxLink({
  source,
  onRefresh,
}: {
  source: TaxSource;
  onRefresh: () => Promise<void>;
}) {
  const state = useAccountingTaxLink(source.year, true),
    [editor, setEditor] = useState(false),
    [unlink, setUnlink] = useState(false),
    [history, setHistory] = useState(false);
  const view = state.view;
  async function saved() {
    setEditor(false);
    setUnlink(false);
    await onRefresh();
    await state.refresh();
  }
  const calc = view?.snapshot?.payload.calculation;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">Books to tax estimator</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Choose which existing personal inputs use your company books.
            Reviewed actuals and your remaining-year assumptions form the
            estimate. Original manual values are kept for unlinking.
          </p>
        </div>
        <a
          href={`/tax-payments?year=${source.year}`}
          className="inline-flex items-center gap-2 text-sm text-teal-light"
        >
          Open estimator <ArrowUpRight size={15} aria-hidden="true" />
        </a>
      </div>
      {(state.error || view?.job?.last_error) && (
        <p
          role="alert"
          className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm"
        >
          {state.error || view?.job?.last_error}
        </p>
      )}
      {!view && !state.error && (
        <div
          role="status"
          aria-label="Loading the personal estimate..."
          className="glass-card flex flex-wrap items-center justify-between gap-4 rounded-xl p-5"
        >
          <div className="space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-3 w-72" />
          </div>
          <Skeleton className="h-9 w-40 rounded-lg" />
        </div>
      )}
      {view && !view.estimate && (
        <div className="glass-card rounded-xl p-5">
          <p className="font-medium">
            Create your {source.year} personal estimate first.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add the business, wage or withholding rows you want to use. Then
            return here to select them.
          </p>
        </div>
      )}
      {view?.estimate && (
        <>
          <div className="glass-card flex flex-wrap items-center justify-between gap-4 rounded-xl p-5">
            <div className="flex items-start gap-3">
              <Link2
                size={20}
                aria-hidden="true"
                className="mt-0.5 text-teal-light"
              />
              <div>
                <p className="font-medium">
                  {view.link?.enabled
                    ? view.current
                      ? calc?.issues.some((i) => i.severity === "blocking")
                        ? "Current calculation, source review needed"
                        : "Linked inputs are current"
                      : "Linked inputs need a refresh"
                    : "Manual estimate"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {view.link?.enabled
                    ? `Source through ${view.snapshot?.through_date ? dateLabel(view.snapshot.through_date) : "pending"}. ${view.current ? `Books revision ${view.snapshot?.financial_revision}.` : "The last snapshot is retained as history."}`
                    : "Your personal values remain the calculation inputs until you explicitly link them."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {view.link?.enabled && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setUnlink(true)}
                >
                  <Unlink size={14} aria-hidden="true" /> Unlink
                </Button>
              )}
              {view.link && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setHistory(true)}
                >
                  <History size={14} aria-hidden="true" /> History
                </Button>
              )}
              {view.link?.enabled && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.loading}
                  onClick={() => void state.refresh(true)}
                >
                  <RefreshCw
                    size={14}
                    aria-hidden="true"
                    className={state.loading ? "animate-spin" : ""}
                  />{" "}
                  Refresh
                </Button>
              )}
              <Button size="sm" onClick={() => setEditor(true)}>
                {view.link?.enabled
                  ? "Review link & forecast"
                  : "Link selected inputs"}
              </Button>
            </div>
          </div>
          {view.link?.enabled && calc && (
            <>
              {calc.projection && (
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    ["Recorded ordinary income", calc.projection.actual_cents],
                    ["Remaining forecast", calc.projection.remaining_cents],
                    [
                      "Projected annual ordinary income",
                      calc.projection.annual_cents,
                    ],
                  ].map(([label, value]) => (
                    <div key={label} className="glass-card rounded-xl p-4">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <MaskedValue
                        value={money(value)}
                        className="mt-2 block text-lg tabular-nums"
                      />
                    </div>
                  ))}
                </div>
              )}
              {calc.issues.length > 0 && (
                <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
                  <p className="text-sm font-medium">
                    Review before relying on this estimate
                  </p>
                  <ul className="mt-2 space-y-2 pl-4 text-sm text-muted-foreground list-disc">
                    {calc.issues.map((issue) => (
                      <li key={issue.key}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {view.snapshot && (
                <a
                  className="text-sm text-teal-light"
                  href={`/api/accounting/tax?snapshot=${view.snapshot.id}`}
                  download={`tax-estimate-${source.year}-${view.snapshot.id}.json`}
                >
                  Download this calculation and its source inputs
                </a>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {view.worker_enabled
              ? "The private refresh endpoint is enabled. Your deployment scheduler must call it regularly; job history shows completed runs."
              : "Scheduled refresh is off. Opening this workspace or the estimator refreshes changed inputs, and an open page checks every 30 seconds."}
          </p>
        </>
      )}
      {editor && view?.estimate && (
        <AccountingTaxLinkEditor
          view={view}
          source={source}
          onClose={() => setEditor(false)}
          onSaved={saved}
        />
      )}
      {unlink && view?.link && (
        <UnlinkDialog
          view={view}
          onClose={() => setUnlink(false)}
          onSaved={saved}
        />
      )}
      {history && view?.link && (
        <LinkHistory linkId={view.link.id} onClose={() => setHistory(false)} />
      )}
    </section>
  );
}
function UnlinkDialog({
  view,
  onClose,
  onSaved,
}: {
  view: TaxLinkView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const command = useAccountingCommand(onSaved),
    [reason, setReason] = useState("");
  return (
    <WorkflowDialog
      title="Use manual inputs"
      form
      onClose={onClose}
      busy={command.busy}
      size="sm"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await command.execute(
            taxLinkCommandSchema.parse({
              type: "tax.link.save",
              id: view.link!.id,
              estimate_id: view.estimate!.id,
              expected_version: view.link!.version,
              enabled: false,
              body: view.link!.body,
              reason,
              verified: true,
            }),
          );
        }}
        className="space-y-5"
      >
        <TextInput
          label="Reason"
          value={reason}
          onChange={(nextValue) => setReason(nextValue)}
          required
          maxLength={1000}
        />
        <WorkflowActions
          busy={command.busy}
          error={command.error}
          label="Unlink"
          onClose={onClose}
        />
      </form>
    </WorkflowDialog>
  );
}
/**
 * The books link's own audit trail. The server returns audit rows for the
 * tax tables, so this lists what changed and when rather than inventing a
 * snapshot history the schema does not keep. The current calculation is
 * downloadable from the link card itself.
 */
type TaxHistoryRow = {
  id: string;
  table_name: string;
  action: string;
  actor_kind: string | null;
  recorded_at: string;
};

/** Plain-English subject for an audited tax table. */
function historySubject(table: string) {
  if (table === "tax_links") return "Books link";
  if (table === "tax_mappings") return "Account mapping";
  if (table === "tax_adjustments") return "Adjustment";
  return table.replace(/_/g, " ");
}

/** Plain-English verb for an audited action, falling back to the raw name. */
function historyAction(action: string) {
  const known: Record<string, string> = {
    tax_refresh: "Recalculated",
    "tax.link.save": "Link settings saved",
    "tax.link.unlink": "Unlinked",
    "tax.mapping.save": "Treatment saved",
    "tax.adjustment.save": "Adjustment saved",
    insert: "Created",
    update: "Updated",
    delete: "Removed",
  };
  if (known[action]) return known[action];
  const words = action.replace(/[._]/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Changed";
}

const HISTORY_LIMIT = 100;

function LinkHistory({
  linkId,
  onClose,
}: {
  linkId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TaxHistoryRow[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setRows(null);
    setError("");
    fetch(`/api/accounting/tax?history=${linkId}&offset=0`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const value = await r.json();
        if (!r.ok) throw new Error(value.error);
        return value as { rows?: TaxHistoryRow[] };
      })
      .then((value) => {
        // A superseded request is dropped rather than aborted.
        if (!abort.signal.aborted) setRows(value.rows ?? []);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [linkId]);
  return (
    <WorkflowDialog title="Change history" onClose={onClose} size="md">
      <div className="space-y-5">
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {!rows && !error && (
          <div role="status" aria-label="Loading history...">
            <TableSkeleton rows={4} />
          </div>
        )}
        {rows && rows.length > 0 && (
          <div className="divide-y divide-border rounded-xl border border-border">
            {rows.map((row) => (
              <div key={row.id} className="px-4 py-3 text-sm">
                <p>{historySubject(row.table_name)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {timestampLabel(row.recorded_at)} ·{" "}
                  {historyAction(row.action)}
                </p>
              </div>
            ))}
          </div>
        )}
        {rows && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No changes yet.</p>
        )}
        {rows && rows.length === HISTORY_LIMIT && (
          <p className="text-xs text-muted-foreground">
            Showing the {HISTORY_LIMIT} most recent changes.
          </p>
        )}
      </div>
    </WorkflowDialog>
  );
}
