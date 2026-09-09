"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight, History, Link2, RefreshCw, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { SectionHeader } from "@/components/ui/section-header";
import { useAccountingTaxLink } from "../tax/use-accounting-tax-link";
import {
  taxLinkCommandSchema,
  type TaxLinkView,
  type TaxLinkSnapshot,
} from "@/lib/accounting/tax-links";
import type { TaxSource } from "@/lib/accounting/tax-workpapers";
import { useAccountingCommand } from "./use-accounting-command";
import { InvoiceActions, InvoiceDialog } from "./accounting-dialog";
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
        <p className="text-sm text-muted-foreground">
          Loading the personal estimate...
        </p>
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
                        className="mt-2 block font-mono text-lg tabular-nums"
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
    <InvoiceDialog
      title="Return to manual tax inputs"
      description="The estimator will use the original manual target values again. Retained calculations and link history remain available."
      form
      onClose={onClose}
      busy={command.busy}
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
        className="space-y-4"
      >
        <TextInput
          label="Reason for unlinking"
          value={reason}
          onChange={(nextValue) => setReason(nextValue)}
          required
          maxLength={1000}
        />
        <InvoiceActions
          busy={command.busy}
          error={command.error}
          label="Unlink inputs"
          onClose={onClose}
        />
      </form>
    </InvoiceDialog>
  );
}
function LinkHistory({
  linkId,
  onClose,
}: {
  linkId: string;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0),
    [data, setData] = useState<{
      count: number;
      version_count: number;
      snapshots: Pick<
        TaxLinkSnapshot,
        | "id"
        | "link_version"
        | "financial_revision"
        | "through_date"
        | "created_at"
      >[];
      versions: {
        version: number;
        enabled: boolean;
        reason: string;
        created_at: string;
      }[];
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    setError("");
    fetch(`/api/accounting/tax?history=${linkId}&offset=${offset}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const value = await r.json();
        if (!r.ok) throw new Error(value.error);
        return value;
      })
      .then((value) => {
        // A superseded request is dropped rather than aborted.
        if (!abort.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [linkId, offset]);
  return (
    <InvoiceDialog
      title="Tax calculation history"
      description="Every retained calculation contains its exact source inputs and personal assumptions. Earlier calculations do not change when the books change."
      onClose={onClose}
    >
      <div className="space-y-5">
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">Loading history...</p>
        )}
        {data && (
          <>
            <SectionHeader label="Calculations" count={data.count} />
            <div className="divide-y divide-border">
              {data.snapshots.map((s) => (
                <a
                  key={s.id}
                  href={`/api/accounting/tax?snapshot=${s.id}`}
                  download={`tax-calculation-${s.id}.json`}
                  className="flex flex-wrap justify-between gap-2 py-3 text-sm hover:text-teal-light"
                >
                  <span>
                    {timestampLabel(s.created_at)}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Through {dateLabel(s.through_date)}, books revision{" "}
                      {s.financial_revision}, link version {s.link_version}
                    </span>
                  </span>
                  <span>Download inputs & results</span>
                </a>
              ))}
            </div>
            <SectionHeader label="Link changes" count={data.version_count} />
            <div className="divide-y divide-border">
              {data.versions.map((v) => (
                <div key={v.version} className="py-3 text-sm">
                  <p>
                    Version {v.version}: {v.enabled ? "Linked" : "Unlinked"}
                  </p>
                  <p className="mt-1 text-muted-foreground">{v.reason}</p>
                </div>
              ))}
            </div>
            <Pagination
              offset={offset}
              limit={50}
              total={Math.max(data.count, data.version_count)}
              onChange={setOffset}
              className="px-0"
            />
          </>
        )}
      </div>
    </InvoiceDialog>
  );
}
