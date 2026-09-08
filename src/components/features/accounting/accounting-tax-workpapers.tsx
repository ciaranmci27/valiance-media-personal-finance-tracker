"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Check,
  History,
  Pencil,
  Plus,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { MaskedValue } from "@/components/ui/masked-value";
import { Pagination } from "@/components/ui/pagination";
import { CustomSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { centsToDecimal, parseUsd } from "@/lib/accounting/money";
import {
  taxConcepts,
  taxScopeSchema,
  taxWorkpaperCommandSchema,
  type TaxSource,
  type TaxConcept,
  type TaxAdjustment,
  type TaxWorkpaperRevision,
} from "@/lib/accounting/tax-workpapers";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { AccountingTaxLink } from "./accounting-tax-link";
import {
  InvoiceActions,
  InvoiceDialog,
  InvoiceEvidence,
} from "./accounting-dialog";
import { dateLabel, money, timestampLabel, todayInBooks } from "./format";

type Editor =
  | { kind: "basis" }
  | { kind: "mapping"; account: TaxSource["accounts"][number] }
  | { kind: "adjustment"; adjustment?: TaxAdjustment };
type HistoryScope = {
  kind: "basis" | "mapping" | "adjustment";
  key?: string;
  title: string;
};
type TaxAccount = TaxSource["accounts"][number];
const basisFields = [
  ["opening_stock_cents", "Opening stock basis"],
  ["opening_debt_cents", "Opening debt basis"],
  ["ending_stock_cents", "Ending stock basis"],
  ["ending_debt_cents", "Ending debt basis"],
  ["allowed_loss_cents", "Supported allowable business loss"],
] as const;
const classifications = {
  s_corp: "S corporation",
  sole_prop: "Sole proprietor",
  disregarded: "Disregarded entity",
  partnership: "Partnership",
  c_corp: "C corporation",
} as const;
export function AccountingTaxWorkpapers({
  demo,
  onRefresh,
}: {
  demo: boolean;
  onRefresh: () => Promise<void>;
}) {
  const today = todayInBooks();
  const params = useSearchParams();
  const parsed = taxScopeSchema.safeParse({
    year: Number(params.get("tax_year") ?? today.slice(0, 4)),
    through: params.get("tax_through") ?? today,
  });
  const applied =
    parsed.success && parsed.data.through <= today
      ? parsed.data
      : { year: Number(today.slice(0, 4)), through: today };
  const signature = JSON.stringify(applied);
  const [draft, setDraft] = useState(applied),
    [data, setData] = useState<TaxSource | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0);
  const [query, setQuery] = useState(""),
    [onlyMissing, setOnlyMissing] = useState(false),
    [editor, setEditor] = useState<Editor | null>(null),
    [history, setHistory] = useState<HistoryScope | null>(null);
  const tab = ["accounts", "adjustments", "basis", "estimator"].includes(
    params.get("tax_tab") ?? "",
  )
    ? params.get("tax_tab")!
    : "accounts";
  useEffect(() => setDraft(JSON.parse(signature)), [signature]);
  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    const scope: typeof applied = JSON.parse(signature);
    accountingGet<TaxSource>(
      {
        view: "tax-workpapers",
        year: String(scope.year),
        through: scope.through,
      },
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [signature, tick, demo]);
  async function refresh() {
    await onRefresh();
    setTick((n) => n + 1);
  }
  function navigate(nextTab?: string) {
    const url = new URL(window.location.href);
    if (nextTab) url.searchParams.set("tax_tab", nextTab);
    else {
      url.searchParams.set("tax_year", String(draft.year));
      url.searchParams.set("tax_through", draft.through);
    }
    window.history.pushState(null, "", url);
  }
  const rows =
    data?.accounts.filter(
      (a) =>
        (!onlyMissing || (!a.current && a.line_count > 0)) &&
        `${a.name} ${a.code} ${a.mapping ? taxConcepts[a.mapping.concept] : ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Tax workpapers</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Connect book profit to reviewed tax treatment. Keep adjustments,
            source documents and shareholder basis together.
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-teal-light">
          <a
            href={`/accounting?view=reports&report=tax-workpapers&support_filter=${encodeURIComponent(JSON.stringify({ report_id: "tax-workpapers", from: `${applied.year}-01-01`, to: applied.through, offset: 0 }))}`}
          >
            Workpaper report
          </a>
          <a href="/tax-payments" className="inline-flex items-center gap-2">
            Tax estimator <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
      </header>
      <form
        className="glass-card flex flex-wrap items-end gap-3 rounded-xl p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !taxScopeSchema.safeParse(draft).success ||
            draft.through > today
          ) {
            setError("Choose a valid year and cutoff through today.");
            return;
          }
          navigate();
          setTick((n) => n + 1);
        }}
      >
        <Input
          id="workpaper-year"
          label="Tax year"
          type="number"
          min={1900}
          max={Number(today.slice(0, 4))}
          value={draft.year}
          onChange={(e) => {
            const year = Number(e.target.value);
            setDraft({
              year,
              through:
                year === Number(today.slice(0, 4)) ? today : `${year}-12-31`,
            });
          }}
          className="w-28"
        />
        <Input
          id="workpaper-through"
          label="Through"
          type="date"
          value={draft.through}
          min={`${draft.year}-01-01`}
          max={
            draft.year === Number(today.slice(0, 4))
              ? today
              : `${draft.year}-12-31`
          }
          onChange={(e) => setDraft({ ...draft, through: e.target.value })}
        />
        <Button type="submit" variant="outline" disabled={loading || demo}>
          {loading ? "Loading..." : "Update workpapers"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {demo && (
        <p className="text-sm text-muted-foreground">
          Workpapers are available in your configured company books.
        </p>
      )}
      {data && !loading && (
        <>
          <nav aria-label="Tax workpapers" className="overflow-x-auto">
            <div className="seg-track">
              {[
                ["accounts", "Account treatment"],
                ["adjustments", "Adjustments"],
                ["basis", "Shareholder basis"],
                ["estimator", "Estimator link"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={tab === id ? "page" : undefined}
                  onClick={() => navigate(id)}
                  className={cn(
                    "seg-item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tab === id && "is-active",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>
          {tab !== "estimator" && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  ["Book profit", data.book_profit_cents],
                  ["Book-to-tax difference", data.book_to_tax_cents],
                  ["Ordinary business income", data.adjusted_ordinary_cents],
                ].map(([label, cents]) => (
                  <div key={label} className="glass-card rounded-xl p-4">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    {label !== "Book profit" &&
                    (data.unmapped_accounts > 0 ||
                      data.unavailable_adjustments > 0) ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        Review incomplete
                      </p>
                    ) : (
                      <MaskedValue
                        value={money(cents)}
                        className="mt-2 block font-mono text-xl tabular-nums"
                      />
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Recorded amounts through {dateLabel(data.through)}.{" "}
                {data.unmapped_accounts} active accounts need treatment review;{" "}
                {data.drafts} draft transactions and {data.incomplete_imports}{" "}
                incomplete imports remain.{" "}
                {data.unavailable_adjustments > 0
                  ? `${data.unavailable_adjustments} active adjustments have unavailable evidence. `
                  : ""}
                Amounts remain provisional until coverage and source reviews are
                complete.
              </p>
            </>
          )}

          {tab === "estimator" && (
            <AccountingTaxLink source={data} onRefresh={refresh} />
          )}
          {tab === "accounts" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Input
                  aria-label="Search tax account treatment"
                  placeholder="Find an account or treatment"
                  icon={<Search size={16} aria-hidden="true" />}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Checkbox
                  checked={onlyMissing}
                  onChange={setOnlyMissing}
                  label="Needs review only"
                />
              </div>
              <AccountTreatmentTable
                source={data}
                rows={rows}
                onHistory={(a) =>
                  setHistory({
                    kind: "mapping",
                    key: a.account_id,
                    title: a.name,
                  })
                }
                onReview={(a) => setEditor({ kind: "mapping", account: a })}
              />
            </>
          )}
          {tab === "adjustments" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-xl text-sm text-muted-foreground">
                  Record a supported tax difference once. Positive ordinary
                  adjustments increase income; negative amounts decrease it.
                  Separately stated items stay outside ordinary business income.
                </p>
                <Button
                  size="sm"
                  onClick={() => setEditor({ kind: "adjustment" })}
                >
                  <Plus size={14} aria-hidden="true" /> Add adjustment
                </Button>
              </div>
              <div className="glass-card divide-y divide-border rounded-xl">
                {data.adjustments.map((a) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                    key={a.adjustment_key}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {a.concept === "ordinary_adjustment"
                          ? "Ordinary income adjustment"
                          : taxConcepts[a.concept]}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dateLabel(a.effective_date)} · Version {a.version} ·{" "}
                        {a.active
                          ? a.current
                            ? "Reviewed"
                            : "Evidence unavailable"
                          : "Removed"}
                      </p>
                      <p className="mt-2 max-w-xl break-words text-sm text-muted-foreground">
                        {a.reason}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <MaskedValue
                        value={money(a.amount_cents)}
                        className="font-mono tabular-nums"
                      />
                      <Tooltip content="Adjustment history">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Adjustment history"
                          onClick={() =>
                            setHistory({
                              kind: "adjustment",
                              key: a.adjustment_key,
                              title: "Adjustment history",
                            })
                          }
                        >
                          <History size={14} aria-hidden="true" />
                        </Button>
                      </Tooltip>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditor({ kind: "adjustment", adjustment: a })
                        }
                      >
                        Revise
                      </Button>
                    </div>
                  </div>
                ))}
                {!data.adjustments.length && (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    No adjustments through this date.
                  </p>
                )}
              </div>
              {Object.keys(data.separately_stated).length > 0 && (
                <div className="glass-card rounded-xl p-4">
                  <h3 className="text-sm font-medium">
                    Separately stated contributions
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    These require their own personal-return treatment. They are
                    excluded from the ordinary income total above.
                  </p>
                  <dl className="mt-4 space-y-3">
                    {Object.entries(data.separately_stated).map(
                      ([concept, cents]) => (
                        <div
                          key={concept}
                          className="flex justify-between gap-4 text-sm"
                        >
                          <dt>{taxConcepts[concept as TaxConcept]}</dt>
                          <dd>
                            <MaskedValue
                              value={money(cents!)}
                              className="font-mono tabular-nums"
                            />
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </div>
              )}
            </div>
          )}
          {tab === "basis" && (
            <div className="glass-card space-y-4 rounded-xl p-5">
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h3 className="font-medium">
                    Supported stock and debt basis
                  </h3>
                  <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                    Keep your reviewed worksheet here. Book equity does not
                    establish tax basis, and this app does not calculate basis
                    or loss limitations.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setHistory({
                        kind: "basis",
                        title: "Basis worksheet history",
                      })
                    }
                  >
                    <History size={14} aria-hidden="true" /> History
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditor({ kind: "basis" })}
                  >
                    {data.basis ? "Update worksheet" : "Add worksheet"}
                  </Button>
                </div>
              </div>
              {data.basis ? (
                <>
                  <p
                    className={`text-sm ${data.basis.current ? "text-teal-light" : "text-warning"}`}
                  >
                    {data.basis.current
                      ? `Supported through ${dateLabel(data.basis.through_date)}`
                      : "Books, treatment or supporting evidence changed. Review the worksheet again."}
                  </p>
                  <dl className="grid gap-5 sm:grid-cols-2">
                    {basisFields.map(([key, label]) => (
                      <div key={key}>
                        <dt className="text-xs text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="mt-1 text-sm">
                          {data.basis!.body[key] === null ? (
                            "Not supplied"
                          ) : (
                            <MaskedValue
                              value={money(data.basis!.body[key])}
                              className="font-mono tabular-nums"
                            />
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-sm text-muted-foreground">
                    {data.basis.body.distribution_reviewed
                      ? "Distribution consequences reviewed against source support."
                      : "Distribution consequences still need review."}
                  </p>
                  {data.basis.body.limitations && (
                    <p className="rounded-lg bg-secondary/30 p-3 text-sm">
                      {data.basis.body.limitations}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Opening basis and allowable losses are unverified. Keep loss
                  and distribution conclusions manual until the supporting
                  worksheet is reviewed.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {editor && data && (
        <TaxWorkpaperEditor
          key={`${editor.kind}-${"account" in editor ? editor.account.account_id : "adjustment" in editor ? editor.adjustment?.id : ""}`}
          source={data}
          editor={editor}
          onClose={() => setEditor(null)}
          onSaved={refresh}
        />
      )}
      {history && (
        <TaxWorkpaperHistory
          scope={history}
          year={applied.year}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

function AccountTreatmentTable({
  source,
  rows,
  onHistory,
  onReview,
}: {
  source: TaxSource;
  rows: TaxAccount[];
  onHistory: (account: TaxAccount) => void;
  onReview: (account: TaxAccount) => void;
}) {
  const journalHref = (a: TaxAccount) =>
    `/accounting?view=journal&transactions=${encodeURIComponent(JSON.stringify({ status: "posted", account: a.account_id, from: `${source.year}-01-01`, to: source.through, offset: 0, limit: 50 }))}`;
  const treatment = (a: TaxAccount) =>
    a.mapping
      ? `${taxConcepts[a.mapping.concept]}${["ordinary_expense", "meals", "travel", "officer_wages"].includes(a.mapping.concept) ? ` · ${a.mapping.deductible_bps / 100}% deductible` : ""}`
      : a.line_count
        ? "Choose tax treatment"
        : "No recorded activity";
  const account = (a: TaxAccount) => (
    <>
      <a className="font-medium hover:text-teal-light" href={journalHref(a)}>
        {a.name}
      </a>
      <p className="mt-1 text-xs text-muted-foreground">{treatment(a)}</p>
    </>
  );
  const ordinary = (a: TaxAccount) =>
    !a.current && a.line_count > 0 ? (
      <span className="text-xs text-muted-foreground">Needs review</span>
    ) : (
      <MaskedValue
        value={money(a.ordinary_cents)}
        className="font-mono tabular-nums"
      />
    );
  const actions = (a: TaxAccount) => (
    <div className="flex justify-end gap-1">
      <Tooltip content={`History for ${a.name}`}>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`History for ${a.name}`}
          onClick={() => onHistory(a)}
        >
          <History size={14} aria-hidden="true" />
        </Button>
      </Tooltip>
      <Button size="sm" variant="ghost" onClick={() => onReview(a)}>
        {a.current ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Pencil size={14} aria-hidden="true" />
        )}{" "}
        {a.current ? "Reviewed" : "Review"}
      </Button>
    </div>
  );
  return (
    <DataTable<TaxAccount>
      columns={[
        { key: "account", header: "Account / treatment", render: account },
        {
          key: "book",
          header: "Book contribution",
          align: "right",
          numeric: true,
          render: (a) => (
            <MaskedValue
              value={money(a.book_cents)}
              className="font-mono tabular-nums"
            />
          ),
        },
        {
          key: "ordinary",
          header: "Ordinary income",
          align: "right",
          numeric: true,
          render: ordinary,
        },
        { key: "review", header: "Review", align: "right", render: actions },
      ]}
      data={rows}
      keyExtractor={(a) => a.account_id}
      emptyState="No accounts match this filter."
      mobileCard={(a) => (
        <div className="glass-card rounded-xl p-4">
          <div className="min-w-0">{account(a)}</div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">
                Book contribution
              </dt>
              <dd className="mt-0.5">
                <MaskedValue
                  value={money(a.book_cents)}
                  className="font-mono tabular-nums"
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Ordinary income</dt>
              <dd className="mt-0.5">{ordinary(a)}</dd>
            </div>
          </dl>
          <div className="mt-3 border-t border-border pt-3">{actions(a)}</div>
        </div>
      )}
    />
  );
}

function TaxWorkpaperEditor({
  source,
  editor,
  onClose,
  onSaved,
}: {
  source: TaxSource;
  editor: Editor;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing =
    editor.kind === "mapping"
      ? editor.account.mapping
      : editor.kind === "adjustment"
        ? editor.adjustment
        : source.basis;
  const [id] = useState(() => crypto.randomUUID()),
    [adjustmentKey] = useState(() =>
      editor.kind === "adjustment"
        ? (editor.adjustment?.adjustment_key ?? crypto.randomUUID())
        : "",
    );
  const [document, setDocument] = useState(existing?.document_id ?? ""),
    [reason, setReason] = useState(existing?.reason ?? ""),
    [verified, setVerified] = useState(false);
  const [concept, setConcept] = useState(
    editor.kind === "mapping"
      ? (editor.account.mapping?.concept ?? "")
      : editor.kind === "adjustment"
        ? (editor.adjustment?.concept ?? "ordinary_adjustment")
        : "",
  );
  const [percentage, setPercentage] = useState(
    editor.kind === "mapping" && editor.account.mapping
      ? centsToDecimal(String(editor.account.mapping.deductible_bps))
      : "",
  );
  const [amount, setAmount] = useState(
      editor.kind === "adjustment" && editor.adjustment
        ? centsToDecimal(editor.adjustment.amount_cents)
        : "",
    ),
    [effectiveDate, setEffectiveDate] = useState(
      editor.kind === "adjustment"
        ? (editor.adjustment?.effective_date ?? source.through)
        : source.through,
    ),
    [active, setActive] = useState(
      editor.kind === "adjustment" ? (editor.adjustment?.active ?? true) : true,
    );
  const [basis, setBasis] = useState(
      Object.fromEntries(
        basisFields.map(([key]) => [
          key,
          source.basis?.body[key] != null
            ? centsToDecimal(source.basis.body[key]!)
            : "",
        ]),
      ) as Record<(typeof basisFields)[number][0], string>,
    ),
    [limitations, setLimitations] = useState(
      source.basis?.body.limitations ?? "",
    ),
    [distributions, setDistributions] = useState(
      source.basis?.body.distribution_reviewed ?? false,
    );
  const command = useAccountingCommand(onSaved),
    deductible = [
      "ordinary_expense",
      "officer_wages",
      "meals",
      "travel",
    ].includes(concept);
  const title =
    editor.kind === "mapping"
      ? editor.account.name
      : editor.kind === "basis"
        ? "Shareholder basis worksheet"
        : editor.adjustment
          ? "Revise tax adjustment"
          : "Add tax adjustment";
  async function submit() {
    try {
      const common = {
        id,
        year: source.year,
        expected_version: existing?.version ?? 0,
        document_id: document || null,
        reason,
        verified,
      };
      let raw: unknown;
      if (editor.kind === "mapping")
        raw = {
          ...common,
          type: "tax.mapping",
          account_id: editor.account.account_id,
          concept,
          deductible_bps: deductible
            ? Number(parseUsd(percentage))
            : concept === "ordinary_income"
              ? 10000
              : 0,
        };
      else if (editor.kind === "adjustment")
        raw = {
          ...common,
          type: "tax.adjustment",
          adjustment_key: adjustmentKey,
          effective_date: effectiveDate,
          concept,
          amount_cents: parseUsd(amount).toString(),
          active,
        };
      else
        raw = {
          ...common,
          type: "tax.basis",
          through: source.through,
          source_fingerprint: source.fingerprint,
          body: {
            ...Object.fromEntries(
              basisFields.map(([key]) => [
                key,
                basis[key].trim() === ""
                  ? null
                  : parseUsd(basis[key]).toString(),
              ]),
            ),
            distribution_reviewed: distributions,
            limitations,
          },
        };
      const parsed = taxWorkpaperCommandSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues[0]?.message ?? "Complete the review fields.",
        );
      if (await command.execute(parsed.data)) onClose();
    } catch (e) {
      command.setError(
        e instanceof Error ? e.message : "Check the workpaper fields.",
      );
    }
  }
  return (
    <InvoiceDialog
      form
      title={title}
      description={`Tax year ${source.year}. Saving retains the prior version and leaves journal amounts unchanged.`}
      busy={command.busy}
      onClose={onClose}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {editor.kind === "mapping" && (
          <>
            <div data-form-change>
              <CustomSelect
                label="Tax treatment"
                required
                placeholder="Choose reviewed treatment"
                value={concept}
                onChange={(value) => {
                  setConcept(value);
                  setPercentage("");
                }}
                options={Object.entries(taxConcepts)
                  .filter(([id]) =>
                    editor.account.account_type === "income"
                      ? [
                          "ordinary_income",
                          "interest",
                          "qualified_dividend",
                          "short_gain",
                          "long_gain",
                          "tax_exempt",
                          "excluded_book",
                        ].includes(id)
                      : [
                          "ordinary_expense",
                          "officer_wages",
                          "meals",
                          "travel",
                          "nondeductible",
                          "charity",
                          "excluded_book",
                        ].includes(id),
                  )
                  .map(([id, label]) => ({ value: id, label }))}
              />
            </div>
            {deductible && (
              <Input
                label="Deductible percentage"
                inputMode="decimal"
                placeholder="Enter reviewed percentage, e.g. 100"
                required
                value={percentage}
                onChange={(e) => setPercentage(e.target.value)}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Amounts are rounded per journal line to exact cents. Separate
              meals from travel and confirm the treatment applicable to this
              year.
            </p>
          </>
        )}
        {editor.kind === "adjustment" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Effective date"
                type="date"
                min={`${source.year}-01-01`}
                max={source.through}
                required
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
              <Input
                label="Signed adjustment (USD)"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div data-form-change>
              <CustomSelect
                label="Tax concept"
                value={concept}
                onChange={setConcept}
                options={[
                  {
                    value: "ordinary_adjustment",
                    label: "Ordinary business income adjustment",
                  },
                  ...[
                    "interest",
                    "qualified_dividend",
                    "short_gain",
                    "long_gain",
                    "charity",
                    "tax_exempt",
                  ].map((id) => ({
                    value: id,
                    label: taxConcepts[id as TaxConcept],
                  })),
                ]}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Positive adds to the concept; negative subtracts. A charitable
              deduction is a negative contribution. Do not repeat an expense
              already reflected in mapped income.
            </p>
            {editor.adjustment && (
              <Checkbox
                data-form-change
                checked={active}
                onChange={setActive}
                className="items-start text-left"
                label="Include this adjustment (clear to remove, preserving history)"
              />
            )}
          </>
        )}
        {editor.kind === "basis" && (
          <>
            <p className="text-sm text-muted-foreground">
              Copy supported values from the reviewed worksheet through{" "}
              {dateLabel(source.through)}. Leave unavailable amounts blank.
              Allowable loss must include all applicable externally reviewed
              limitations.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {basisFields.map(([key, label]) => (
                <Input
                  key={key}
                  label={`${label} (USD)`}
                  inputMode="decimal"
                  placeholder="Not supplied"
                  value={basis[key]}
                  onChange={(e) =>
                    setBasis({ ...basis, [key]: e.target.value })
                  }
                />
              ))}
            </div>
            <Checkbox
              data-form-change
              checked={distributions}
              onChange={setDistributions}
              className="items-start text-left"
              label="Distribution tax consequences reviewed against the supporting worksheet"
            />
            <Textarea
              label="Unresolved limitations"
              className="h-24"
              maxLength={2000}
              value={limitations}
              placeholder="Missing opening support, at-risk or passive-loss restrictions, or other unresolved items"
              onChange={(e) => setLimitations(e.target.value)}
            />
          </>
        )}
        <InvoiceEvidence
          required={editor.kind !== "mapping"}
          value={document}
          onChange={setDocument}
        />
        <Textarea
          label="Review notes"
          required
          maxLength={1000}
          className="h-24"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Describe the supported treatment and any changes from the prior version."
        />
        <Checkbox
          data-form-change
          checked={verified}
          onChange={setVerified}
          className="items-start text-left"
          label="I reviewed the year, amounts, treatment and supporting evidence."
        />
        <InvoiceActions
          busy={command.busy}
          error={command.error}
          label="Save reviewed version"
          onClose={onClose}
        />
      </form>
    </InvoiceDialog>
  );
}

function TaxWorkpaperHistory({
  scope,
  year,
  onClose,
}: {
  scope: HistoryScope;
  year: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
      count: number;
      rows: (TaxWorkpaperRevision & {
        concept?: TaxConcept | "ordinary_adjustment";
        classification?: string;
        amount_cents?: string;
        through_date?: string;
        effective_date?: string;
        deductible_bps?: number;
        body?: NonNullable<TaxSource["basis"]>["body"];
      })[];
    } | null>(null),
    [offset, setOffset] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setData(null);
    accountingGet<NonNullable<typeof data>>(
      {
        view: "tax-history",
        kind: scope.kind,
        year: String(year),
        ...(scope.key ? { key: scope.key } : {}),
        offset: String(offset),
      },
      abort.signal,
    )
      .then(setData)
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [scope.kind, scope.key, year, offset]);
  return (
    <InvoiceDialog
      title={scope.title}
      description={`Retained reviewed versions for ${year}.`}
      onClose={onClose}
    >
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="divide-y divide-border">
        {data?.rows.map((r) => (
          <article key={r.id} className="space-y-2 py-4">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="font-medium">Version {r.version}</span>
              <time
                dateTime={r.created_at}
                className="text-xs text-muted-foreground"
              >
                {timestampLabel(r.created_at)}
              </time>
            </div>
            <p className="text-sm">
              {r.classification
                ? classifications[
                    r.classification as keyof typeof classifications
                  ]
                : r.concept
                  ? r.concept === "ordinary_adjustment"
                    ? "Ordinary business income adjustment"
                    : taxConcepts[r.concept]
                  : `Worksheet through ${dateLabel(r.through_date)}`}
              {r.deductible_bps !== undefined
                ? ` · ${r.deductible_bps / 100}%`
                : ""}
              {r.amount_cents !== undefined && (
                <>
                  {" "}
                  ·{" "}
                  <MaskedValue
                    value={money(r.amount_cents)}
                    className="font-mono tabular-nums"
                  />
                </>
              )}
            </p>
            <p className="break-words text-sm text-muted-foreground">
              {r.reason}
            </p>
            {r.body && (
              <>
                <dl className="grid gap-3 sm:grid-cols-2">
                  {basisFields.map(([key, label]) => (
                    <div key={key}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-sm">
                        {r.body![key] === null ? (
                          "Not supplied"
                        ) : (
                          <MaskedValue
                            value={money(r.body![key])}
                            className="font-mono tabular-nums"
                          />
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-sm text-muted-foreground">
                  {r.body.distribution_reviewed
                    ? "Distribution review recorded."
                    : "Distribution review unresolved."}{" "}
                  {r.body.limitations}
                </p>
              </>
            )}
            {r.document_id && (
              <a
                className="text-xs text-teal-light"
                href={`/api/accounting/documents?id=${r.document_id}`}
                target="_blank"
                rel="noreferrer"
              >
                Open supporting document
              </a>
            )}
          </article>
        ))}
      </div>
      {data?.count === 0 && (
        <p className="py-5 text-sm text-muted-foreground">
          No reviewed versions yet.
        </p>
      )}
      {data && (
        <Pagination
          offset={offset}
          limit={50}
          total={data.count}
          onChange={setOffset}
          noun="versions"
          className="px-0 pt-3"
        />
      )}
    </InvoiceDialog>
  );
}
