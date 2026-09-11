"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Copy,
  FileText,
  Plus,
  Search,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Select } from "@/components/ui/inputs/Select";
import { MaskedValue } from "@/components/ui/masked-value";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { TableSkeleton } from "@/components/ui/skeleton";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { centsToDecimal } from "@/lib/accounting/money";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import type { WorkflowCommand } from "@/lib/accounting/workflows";
import type { BooksMetadata } from "./types";
import {
  payrollKinds,
  type PayrollComponent,
  type PayrollDetail,
  type PayrollList,
  type PayrollRun,
} from "@/lib/accounting/payroll";
import { AccountingPicker, type AccountingOption } from "./accounting-picker";
import { AccountingDocumentPicker } from "./accounting-document-picker";
import { WorkflowActions, WorkflowDialog, usdCents } from "./accounting-dialog";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";
import { absMoney, dateLabel, enumLabel, money } from "./format";

/** Matches the LIMIT in acct_payroll_view. */
const PAGE = 50;

/** What the void dialog needs; built from the list row or the open detail. */
type VoidTarget = Pick<
  PayrollRun,
  "id" | "version" | "pay_date" | "provider_run_id"
>;

/**
 * How a run posts. Cash credits the bank account the run was paid from for
 * net pay and taxes; accrual books each component to its liability account.
 */
type PostingTemplate = "cash" | "accrual";
const CASH_COMPONENTS = new Set([
  "officer_wages",
  "other_wages",
  "net_pay",
  "employee_tax",
  "employer_tax",
]);
/** Deductions, reimbursements and fees only post through the accrual template. */
const needsAccrual = (detail: PayrollDetail) =>
  detail.register.body.components.some((c) => !CASH_COMPONENTS.has(c.kind));

const STATUS: Record<
  PayrollRun["status"],
  { label: string; variant: BadgeVariant }
> = {
  draft: { label: "Draft", variant: "warning" },
  posted: { label: "Recorded", variant: "success" },
  linked: { label: "Linked to history", variant: "info" },
  voided: { label: "Voided", variant: "default" },
};

/** Which chart account each register line posts to, by system purpose or name. */
const LIABILITY_PURPOSE: Record<string, string> = {
  net_pay: "net_salary_payable",
  employee_tax: "payroll_taxes_payable",
  employer_tax: "payroll_taxes_payable",
  retirement_deferral: "retirement_payable",
  other_deduction: "payroll_deductions",
  provider_fee: "payroll_deductions",
};

type FormState = {
  providerId: string;
  payDate: string;
  from: string;
  to: string;
  gross: string;
  net: string;
  withholding: string;
  employer: string;
  retirement: string;
  deduction: string;
  reimbursement: string;
  fee: string;
  document: string;
  employeeName: string;
  accounts: Record<string, string>;
  facts: Record<string, string>;
};

const FACT_FIELDS: [string, string][] = [
  ["federal_taxable_cents", "Federal taxable wages"],
  ["federal_withheld_cents", "Federal income tax withheld"],
  ["state_taxable_cents", "State taxable wages"],
  ["state_withheld_cents", "State income tax withheld"],
  ["social_security_wages_cents", "Social Security wages"],
  ["medicare_wages_cents", "Medicare wages"],
];

function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Sticky dialog footer for what WorkflowActions cannot express: a destructive
 * primary, or a primary that is not a form submit. Cancel goes through
 * DialogClose so the WorkflowDialog discard guard still runs.
 */
function ActionFooter({
  busy,
  error,
  children,
}: {
  busy: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="sticky -bottom-5 z-10 -mx-6 -mb-5 space-y-3 border-t border-border bg-[var(--background-subtle)] px-6 py-4">
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button type="button" variant="ghost" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        {children}
      </div>
    </div>
  );
}

/**
 * Payroll runs from Patriot, recorded the way a one-owner S corporation
 * actually experiences them: one register per pay date, the totals from the
 * register, and one journal entry. The Patriot debits that hit the bank are
 * matched to it from Transactions.
 */
export function AccountingPayrollRuns({
  accounts,
  manage,
  today,
  demo,
  onRefresh,
  onEntry,
}: {
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  today: string;
  demo: boolean;
  onRefresh: () => Promise<void>;
  onEntry?: (id: string) => void;
}) {
  const [year, setYear] = useState(today.slice(0, 4));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<PayrollList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PayrollDetail | null>(null);
  const [form, setForm] = useState<{
    record?: PayrollDetail;
    copy?: PayrollDetail;
  } | null>(null);
  const [voiding, setVoiding] = useState<VoidTarget | null>(null);
  // Cash payroll credits the account the run was paid from. The owner picks
  // it once per session; a single bank account is chosen automatically.
  const profileMap = useMemo(
    () => new Map(manage.profiles.map((p) => [p.account_id, p])),
    [manage.profiles],
  );
  const bankOptions = useMemo<AccountingOption[]>(
    () =>
      accounts
        .filter(
          (a) =>
            !a.is_archived &&
            ["bank", "cash"].includes(profileMap.get(a.id)?.cash_kind ?? ""),
        )
        .map((a) => ({ value: a.id, label: a.name, detail: a.code })),
    [accounts, profileMap],
  );
  const [paidFrom, setPaidFrom] = useState("");
  const [template, setTemplate] = useState<PostingTemplate>("cash");
  const bank =
    paidFrom || (bankOptions.length === 1 ? bankOptions[0].value : "");
  const cmd = useAccountingCommand(async () => {
    setTick((t) => t + 1);
    await onRefresh();
  });
  const { confirm, dialog } = useConfirmationDialog();
  const names = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );

  useEffect(() => {
    if (query === search) return;
    const t = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [query, search]);

  useEffect(() => {
    if (demo) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    accountingGet<PayrollList>(
      {
        view: "payroll",
        filter: JSON.stringify({
          year: Number(year),
          as_of: today,
          query: search,
          offset,
        }),
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
  }, [year, today, search, offset, tick, demo]);

  useEffect(() => {
    if (!detailId || demo) return;
    const abort = new AbortController();
    accountingGet<PayrollDetail>(
      { view: "payroll-detail", id: detailId, offset: "0" },
      abort.signal,
    )
      .then((d) => {
        setDetail(d);
        if (d.status === "draft")
          setTemplate(needsAccrual(d) ? "accrual" : "cash");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [detailId, tick, demo]);

  async function approve(run: PayrollRun | PayrollDetail) {
    const accrual = template === "accrual";
    if (!accrual && !bank) {
      setDetailId(run.id);
      setError("Choose the bank account this payroll was paid from.");
      return;
    }
    const ok = await confirm({
      title: "Record payroll?",
      description: accrual
        ? "Posts one entry with a liability per component."
        : "Posts one entry against the bank account.",
      confirmLabel: "Record",
    });
    if (!ok) return;
    // `template` and `bank_account_id` are the step 6 payroll.approve fields;
    // the shared command type catches up when the schema port merges.
    const command = {
      type: "payroll.approve",
      id: run.id,
      expected_version: run.version,
      mode: "new",
      verified: true,
      reason: "Recorded from the payroll screen",
      template,
      ...(accrual ? {} : { bank_account_id: bank }),
    } as unknown as WorkflowCommand;
    if (await cmd.execute(command)) {
      toast("success", "Payroll run recorded.");
      setDetailId(null);
    }
  }

  const years = useMemo(() => {
    const current = Number(today.slice(0, 4));
    return Array.from({ length: 6 }, (_, i) => String(current - i));
  }, [today]);

  const columns: DataTableColumn<PayrollRun>[] = [
    {
      key: "pay_date",
      header: "Pay date",
      width: "w-32",
      render: (r) => (
        <span className="font-medium">{dateLabel(r.pay_date)}</span>
      ),
    },
    {
      key: "run",
      header: "Run",
      render: (r) => (
        <button
          type="button"
          onClick={() => setDetailId(r.id)}
          className="text-left transition-colors hover:text-teal-light focus-visible:outline-none focus-visible:underline"
        >
          <span className="block truncate">{r.provider_run_id}</span>
          {r.document_id && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <FileText size={11} aria-hidden="true" /> Register attached
            </span>
          )}
        </button>
      ),
    },
    {
      key: "gross",
      header: "Gross",
      align: "right",
      numeric: true,
      render: (r) => <MaskedValue value={money(r.gross_cents)} />,
    },
    {
      key: "net",
      header: "Net pay",
      align: "right",
      numeric: true,
      render: (r) => <MaskedValue value={money(r.net_cents)} />,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={STATUS[r.status].variant}>
            {STATUS[r.status].label}
          </Badge>
        </div>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "w-16",
      render: (r) => (
        <RowActionsMenu
          label={`Actions for payroll ${r.provider_run_id}`}
          actions={[
            {
              label: "Open",
              icon: <FileText />,
              onSelect: () => setDetailId(r.id),
            },
            ...(r.status === "draft"
              ? [
                  {
                    label: "Record payroll",
                    icon: <CheckCircle2 />,
                    onSelect: () => void approve(r),
                    disabled: demo || cmd.busy || !r.document_id,
                  },
                ]
              : []),
            {
              label: "Copy as new run",
              icon: <Copy />,
              disabled: demo,
              onSelect: async () => {
                try {
                  const d = await accountingGet<PayrollDetail>({
                    view: "payroll-detail",
                    id: r.id,
                    offset: "0",
                  });
                  setForm({ copy: d });
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Unable to load this run.",
                  );
                }
              },
            },
            ...(r.status === "posted" || r.status === "linked"
              ? [
                  {
                    label: "Void run",
                    icon: <Undo2 />,
                    variant: "danger" as const,
                    separator: true,
                    disabled: demo,
                    onSelect: () => setVoiding(r),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  const totals = data?.totals;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Payroll</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Record each Patriot register as one entry. Bank debits for net pay
            and taxes match to it from Transactions.
          </p>
        </div>
        <Button disabled={demo} onClick={() => setForm({})}>
          <Plus size={15} aria-hidden="true" />
          Record payroll run
        </Button>
      </div>

      {totals && (
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ["Gross wages", money(totals.gross_cents)],
              ["Net pay", money(totals.net_cents)],
              ["Drafts", String(totals.drafts)],
            ] as const
          ).map(([label, value], i) => (
            <div
              key={label}
              className={cn("glass-card rounded-xl p-4", `stagger-${i + 1}`)}
            >
              <p className="text-xs font-medium text-muted-foreground">
                {label} {label !== "Drafts" ? year : ""}
              </p>
              <p className="currency mt-1 text-2xl font-bold tracking-tight">
                {label === "Drafts" ? value : <MaskedValue value={value} />}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="glass-card overflow-hidden rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="w-28">
            <label htmlFor="payroll-year" className="sr-only">
              Tax year
            </label>
            <Select
              id="payroll-year"
              value={year}
              onChange={(v) => {
                setYear(v);
                setOffset(0);
              }}
              options={years.map((y) => ({ value: y, label: y }))}
              size="sm"
            />
          </div>
          <TextInput
            aria-label="Search payroll runs"
            placeholder="Search runs"
            prefix={<Search size={15} aria-hidden="true" />}
            value={query}
            onChange={(nextValue) => setQuery(nextValue)}
          />
        </div>
        {(error || cmd.error) && (
          <p
            role="alert"
            className="border-b border-border bg-error/5 px-4 py-3 text-sm text-error"
          >
            {error || cmd.error}
          </p>
        )}
        <DataTable<PayrollRun>
          framed={false}
          columns={columns}
          data={data?.runs ?? []}
          keyExtractor={(r) => r.id}
          busy={loading && !!data}
          emptyState={
            demo ? (
              "Payroll runs appear here once the books are connected."
            ) : loading ? (
              <div role="status" aria-label="Loading payroll...">
                <TableSkeleton rows={4} />
              </div>
            ) : (
              `No payroll runs in ${year}.`
            )
          }
          mobileCard={(r) => (
            <article className="glass-card space-y-2 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  className="text-left text-sm font-medium"
                  onClick={() => setDetailId(r.id)}
                >
                  {dateLabel(r.pay_date)}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {r.provider_run_id}
                  </span>
                </button>
                <Badge variant={STATUS[r.status].variant}>
                  {STATUS[r.status].label}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Gross</span>
                <MaskedValue value={money(r.gross_cents)} />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Net pay</span>
                <MaskedValue value={money(r.net_cents)} />
              </div>
            </article>
          )}
          after={
            <Pagination
              offset={offset}
              limit={PAGE}
              total={data?.count ?? 0}
              onChange={setOffset}
              noun="runs"
              busy={loading}
            />
          }
        />
      </div>

      {detailId && detail && detail.id === detailId && (
        <RunDetail
          detail={detail}
          names={names}
          busy={cmd.busy}
          error={cmd.error}
          onClose={() => setDetailId(null)}
          onEdit={() => setForm({ record: detail })}
          bankOptions={bankOptions}
          paidFrom={bank}
          onPaidFrom={setPaidFrom}
          template={template}
          onTemplate={setTemplate}
          onApprove={() => void approve(detail)}
          onVoid={() =>
            setVoiding({
              id: detail.id,
              version: detail.version,
              pay_date: detail.register.body.pay_date,
              provider_run_id: detail.provider_run_id,
            })
          }
          onEntry={onEntry}
        />
      )}

      {form && (
        <RunForm
          record={form.record}
          copy={form.copy}
          accounts={accounts}
          manage={manage}
          today={today}
          onClose={() => setForm(null)}
          onSaved={async (id) => {
            setForm(null);
            setTick((t) => t + 1);
            await onRefresh();
            setDetailId(id);
          }}
        />
      )}

      {voiding && (
        <VoidDialog
          run={voiding}
          today={today}
          onClose={() => setVoiding(null)}
          onSaved={async () => {
            setVoiding(null);
            setDetailId(null);
            setTick((t) => t + 1);
            await onRefresh();
          }}
        />
      )}
      {dialog}
    </div>
  );
}

function RunDetail({
  detail,
  names,
  busy,
  error,
  onClose,
  onEdit,
  bankOptions,
  paidFrom,
  onPaidFrom,
  template,
  onTemplate,
  onApprove,
  onVoid,
  onEntry,
}: {
  detail: PayrollDetail;
  names: Map<string, string>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onEdit: () => void;
  bankOptions: AccountingOption[];
  paidFrom: string;
  onPaidFrom: (accountId: string) => void;
  template: PostingTemplate;
  onTemplate: (template: PostingTemplate) => void;
  onApprove: () => void;
  onVoid: () => void;
  onEntry?: (id: string) => void;
}) {
  const body = detail.register.body;
  const status = STATUS[detail.status];
  const draft = detail.status === "draft";
  const hasRegister = !!detail.register.document_id;
  const accrualOnly = needsAccrual(detail);
  const missingBank = template === "cash" && !paidFrom;
  return (
    <WorkflowDialog
      title={`Payroll ${dateLabel(body.pay_date)}`}
      onClose={onClose}
      size="md"
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <Badge variant={status.variant} dot>
            {status.label}
          </Badge>
          <span className="text-muted-foreground">
            {detail.provider_run_id} · {dateLabel(body.period_from)} to{" "}
            {dateLabel(body.period_to)}
          </span>
          {detail.posting?.entry_id && onEntry && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => onEntry(detail.posting!.entry_id)}
            >
              Open journal entry
            </Button>
          )}
          {draft && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={busy}
              onClick={onEdit}
            >
              Edit register
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {(
            [
              ["Gross", detail.preview.totals.gross_cents],
              ["Net pay", detail.preview.totals.net_cents],
              ["Withheld", detail.preview.totals.deductions_cents],
              ["Employer cost", detail.preview.totals.employer_cents],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-0.5 font-medium tabular-nums">
                <MaskedValue value={money(value)} />
              </p>
            </div>
          ))}
        </div>
        {detail.preview.issues.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
            {detail.preview.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <Caption>Journal lines</Caption>
          <div className="divide-y divide-border rounded-xl border border-border">
            {detail.preview.lines.map((l, i) => {
              const cents = BigInt(l.amount_cents);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {names.get(l.account_id) ?? "Unknown account"}
                    {l.memo && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {l.memo}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      cents < BigInt(0) && "text-muted-foreground",
                    )}
                  >
                    {cents < BigInt(0) ? "Cr " : "Dr "}
                    <MaskedValue value={absMoney(cents)} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {draft && (
          <>
            <AccountingPicker
              label="Paid from"
              visibleLabel="Paid from"
              value={paidFrom}
              options={bankOptions}
              onChange={onPaidFrom}
              placeholder="Choose the bank account"
              disabled={template === "accrual"}
              required={template === "cash"}
              helperText={
                template === "accrual"
                  ? "Not used for accrual posting."
                  : undefined
              }
            />
            <details className="group rounded-xl border border-border">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
                Advanced
              </summary>
              <div className="space-y-4 border-t border-border p-4">
                <Select
                  label="Posting"
                  value={template}
                  onChange={(v) => {
                    // A register with accrual-only components cannot post as cash.
                    if (v === "cash" && accrualOnly) return;
                    onTemplate(v as PostingTemplate);
                  }}
                  options={[
                    { value: "cash", label: "Cash", disabled: accrualOnly },
                    { value: "accrual", label: "Accrual" },
                  ]}
                  helperText={
                    accrualOnly
                      ? "This register needs accrual posting."
                      : "Cash credits the bank now; accrual books a liability per component."
                  }
                />
              </div>
            </details>
            {!hasRegister && (
              <p className="text-sm text-muted-foreground">
                Attach the Patriot register to record this run.
              </p>
            )}
          </>
        )}
        <ActionFooter busy={busy} error={error}>
          {draft && (
            <Button
              type="button"
              disabled={
                busy || !detail.preview.ready || !hasRegister || missingBank
              }
              onClick={onApprove}
            >
              <CheckCircle2 size={15} aria-hidden="true" />
              Record
            </Button>
          )}
          {(detail.status === "posted" || detail.status === "linked") && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={onVoid}
            >
              <Undo2 size={15} aria-hidden="true" />
              Void
            </Button>
          )}
        </ActionFooter>
      </div>
    </WorkflowDialog>
  );
}

function RunForm({
  record,
  copy,
  accounts,
  manage,
  today,
  onClose,
  onSaved,
}: {
  record?: PayrollDetail;
  copy?: PayrollDetail;
  accounts: AccountingAccount[];
  manage: BooksMetadata;
  today: string;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const previous = (record ?? copy)?.register.body;
  const profiles = useMemo(
    () => new Map(manage.profiles.map((p) => [p.account_id, p])),
    [manage.profiles],
  );
  const usable = useMemo(
    () =>
      accounts.filter(
        (a) =>
          !a.is_archived &&
          (profiles.get(a.id)?.cash_kind ?? "none") === "none" &&
          ![
            "uncategorized_expense",
            "uncategorized_income",
            "opening_balance_equity",
            "opening_retained_earnings",
          ].includes(profiles.get(a.id)?.purpose ?? ""),
      ),
    [accounts, profiles],
  );
  const expenses = usable.filter((a) => a.account_type === "expense");
  const liabilityFor = (kind: string) =>
    usable.find(
      (a) =>
        a.account_type === "liability" &&
        profiles.get(a.id)?.purpose === LIABILITY_PURPOSE[kind],
    )?.id ?? "";
  const expenseBy = (pattern: RegExp) =>
    expenses.find((a) => pattern.test(a.name))?.id ?? "";
  const previousAccount = (kind: string, offset = false) => {
    const c = previous?.components.find((x) => x.kind === kind);
    return (offset ? c?.offset_account_id : c?.account_id) ?? "";
  };
  const previousAmount = (kind: string) => {
    const c = previous?.components.find((x) => x.kind === kind);
    return c ? centsToDecimal(c.amount_cents) : "";
  };

  const [id] = useState(() => record?.id ?? crypto.randomUUID());
  const [state, setState] = useState<FormState>(() => ({
    providerId: record?.provider_run_id ?? "",
    payDate: record ? previous!.pay_date : today,
    from: record ? previous!.period_from : today.slice(0, 8) + "01",
    to: record ? previous!.period_to : today,
    gross: previous ? centsToDecimal(previous.declared_gross_cents) : "",
    net: previous ? centsToDecimal(previous.declared_net_cents) : "",
    withholding: previousAmount("employee_tax"),
    employer: previousAmount("employer_tax"),
    retirement: previousAmount("retirement_deferral"),
    deduction: previousAmount("other_deduction"),
    reimbursement: previousAmount("reimbursement"),
    fee: previousAmount("provider_fee"),
    document: record?.register.document_id ?? "",
    employeeName: previous?.employees[0]?.name ?? "",
    accounts: {
      officer_wages:
        previousAccount("officer_wages") || expenseBy(/officer|salar|wages/i),
      employer_tax:
        previousAccount("employer_tax") ||
        expenseBy(/employer.*tax|payroll tax/i),
      employer_tax_offset:
        previousAccount("employer_tax", true) || liabilityFor("employer_tax"),
      net_pay: previousAccount("net_pay") || liabilityFor("net_pay"),
      employee_tax:
        previousAccount("employee_tax") || liabilityFor("employee_tax"),
      retirement_deferral:
        previousAccount("retirement_deferral") ||
        liabilityFor("retirement_deferral"),
      other_deduction:
        previousAccount("other_deduction") || liabilityFor("other_deduction"),
      reimbursement:
        previousAccount("reimbursement") || expenseBy(/reimburse/i),
      provider_fee:
        previousAccount("provider_fee") ||
        expenseBy(/payroll fee|payroll service/i),
      provider_fee_offset:
        previousAccount("provider_fee", true) || liabilityFor("provider_fee"),
    },
    facts: Object.fromEntries(
      FACT_FIELDS.map(([key]) => {
        const v = record
          ? (
              previous?.employees[0] as
                | Record<string, string | null | undefined>
                | undefined
            )?.[key]
          : null;
        return [key, v ? centsToDecimal(v) : ""];
      }),
    ),
  }));
  const [error, setError] = useState("");
  const command = useAccountingCommand();

  const set = (patch: Partial<FormState>) =>
    setState((s) => ({ ...s, ...patch }));
  const setAccount = (key: string, value: string) =>
    setState((s) => ({ ...s, accounts: { ...s.accounts, [key]: value } }));

  // Register identity: gross + reimbursements = net + everything withheld.
  // A blank employee tax field takes the residual, so the usual run needs
  // only gross and net; an explicit amount is checked against it.
  let balance: { withholding: bigint; difference: bigint } | null = null;
  try {
    const cents = (v: string) => usdCents(v || "0");
    const residual =
      cents(state.gross) +
      cents(state.reimbursement) -
      (cents(state.net) + cents(state.retirement) + cents(state.deduction));
    const withholding = state.withholding.trim()
      ? cents(state.withholding)
      : residual;
    balance = { withholding, difference: residual - withholding };
  } catch {
    balance = null;
  }
  const derivedWithholding =
    balance && !state.withholding.trim() && balance.withholding >= BigInt(0)
      ? centsToDecimal(balance.withholding)
      : "0.00";

  // Reimbursements may post to expense, asset or liability accounts; the
  // preview rejects income and equity.
  const optionsFor = (type: "expense" | "liability" | "reimbursement") =>
    usable
      .filter((a) =>
        type === "reimbursement"
          ? ["expense", "asset", "liability"].includes(a.account_type)
          : a.account_type === type,
      )
      .map((a) => ({
        value: a.id,
        label: a.name,
        group: enumLabel(a.account_type),
        keywords: a.code,
      }));

  async function save() {
    setError("");
    try {
      if (!state.providerId.trim())
        throw new Error("Enter the Patriot payroll number or date.");
      if (!state.employeeName.trim())
        throw new Error("Enter the employee name.");
      const gross = usdCents(state.gross, true);
      const net = usdCents(state.net, true);
      if (!balance) throw new Error("Enter amounts in dollars and cents.");
      if (balance.withholding < BigInt(0))
        throw new Error(
          "Net pay plus deductions cannot exceed gross wages plus reimbursements.",
        );
      if (balance.difference !== BigInt(0))
        throw new Error(
          "The register does not balance: gross plus reimbursements must equal net pay plus everything withheld.",
        );
      const withholding = balance.withholding;
      const employer = usdCents(state.employer);
      const optional: [string, bigint][] = [
        ["retirement_deferral", usdCents(state.retirement)],
        ["other_deduction", usdCents(state.deduction)],
        ["reimbursement", usdCents(state.reimbursement)],
        ["provider_fee", usdCents(state.fee)],
      ];
      const component = (
        kind: string,
        amount: bigint,
        accountId: string,
        offsetId: string | null,
        paired: boolean,
      ): PayrollComponent => {
        if (!accountId)
          throw new Error(
            `Choose the account for ${payrollKinds[kind as keyof typeof payrollKinds]}.`,
          );
        if (paired && !offsetId)
          throw new Error(
            `Choose the liability account for ${payrollKinds[kind as keyof typeof payrollKinds]}.`,
          );
        return {
          key: kind,
          kind,
          label: payrollKinds[kind as keyof typeof payrollKinds],
          amount_cents: amount.toString(),
          account_id: accountId,
          offset_account_id: paired ? offsetId : null,
          expected_on:
            kind === "officer_wages" || kind === "reimbursement"
              ? null
              : state.payDate,
          source_line_id: null,
        };
      };
      const components: PayrollComponent[] = [
        component(
          "officer_wages",
          gross,
          state.accounts.officer_wages,
          null,
          false,
        ),
        component("net_pay", net, state.accounts.net_pay, null, false),
      ];
      if (withholding > BigInt(0))
        components.push(
          component(
            "employee_tax",
            withholding,
            state.accounts.employee_tax,
            null,
            false,
          ),
        );
      if (employer > BigInt(0))
        components.push(
          component(
            "employer_tax",
            employer,
            state.accounts.employer_tax,
            state.accounts.employer_tax_offset,
            true,
          ),
        );
      for (const [kind, amount] of optional) {
        if (amount === BigInt(0)) continue;
        const paired = kind === "provider_fee";
        components.push(
          component(
            kind,
            amount,
            state.accounts[kind],
            paired ? state.accounts[`${kind}_offset`] : null,
            paired,
          ),
        );
      }
      const facts = Object.fromEntries(
        FACT_FIELDS.map(([key]) => [
          key,
          state.facts[key] ? usdCents(state.facts[key]).toString() : null,
        ]),
      );
      const c: WorkflowCommand = {
        type: "payroll.save",
        id,
        expected_version: record?.version ?? 0,
        provider_run_id: state.providerId.trim(),
        body: {
          pay_date: state.payDate,
          period_from: state.from,
          period_to: state.to,
          declared_gross_cents: gross.toString(),
          declared_net_cents: net.toString(),
          components,
          employees: [
            {
              key: "owner",
              name: state.employeeName.trim(),
              is_officer: true,
              gross_cash_cents: gross.toString(),
              ...facts,
            },
          ],
        },
        document_id: state.document || null,
        reason: record
          ? "Register updated"
          : "Register entered from the payroll screen",
      };
      if (await command.execute(c)) {
        toast(
          "success",
          record ? "Register updated." : "Payroll run saved as a draft.",
        );
        await onSaved(id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the register.");
    }
  }

  const moneyField = (
    label: string,
    key: keyof FormState,
    extra?: { placeholder?: string; description?: string },
  ) => (
    <TextInput
      label={label}
      inputMode="decimal"
      placeholder={extra?.placeholder ?? "0.00"}
      description={extra?.description}
      value={String(state[key])}
      onChange={(nextValue) => set({ [key]: nextValue } as Partial<FormState>)}
    />
  );

  return (
    <WorkflowDialog
      title={record ? "Edit payroll" : "Record payroll"}
      busy={command.busy}
      onClose={onClose}
      form
      size="md"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Patriot run"
            required
            disabled={!!record}
            value={state.providerId}
            onChange={(nextValue) => set({ providerId: nextValue })}
            placeholder="2026-09 monthly"
          />
          <DateInput
            label="Pay date"
            required
            value={state.payDate}
            onChange={(nextValue) => set({ payDate: nextValue })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {moneyField("Gross wages", "gross")}
          {moneyField("Net pay", "net")}
        </div>

        <TextInput
          label="Employee"
          required
          value={state.employeeName}
          onChange={(nextValue) => set({ employeeName: nextValue })}
          placeholder="Owner name"
        />

        <AccountingDocumentPicker
          label="Patriot register"
          required={false}
          value={state.document}
          onChange={(v) => set({ document: v })}
        />

        {balance && balance.difference !== BigInt(0) && (
          <p role="status" className="text-sm text-warning">
            Register is <MaskedValue value={absMoney(balance.difference)} />{" "}
            off: gross plus reimbursements must equal net plus withholdings.
          </p>
        )}

        <details className="group rounded-xl border border-border">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground group-open:text-foreground">
            Advanced
          </summary>
          <div className="space-y-4 border-t border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <DateInput
                label="Period from"
                required
                value={state.from}
                onChange={(nextValue) => set({ from: nextValue })}
              />
              <DateInput
                label="Period to"
                required
                value={state.to}
                onChange={(nextValue) => set({ to: nextValue })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {moneyField("Employee taxes withheld", "withholding", {
                placeholder: derivedWithholding,
                description: "Blank uses gross minus net",
              })}
              {moneyField("Employer payroll taxes", "employer")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {moneyField("Retirement deferral", "retirement")}
              {moneyField("Other deductions", "deduction")}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {moneyField("Reimbursements paid", "reimbursement")}
              {moneyField("Patriot service fee", "fee")}
            </div>

            <Caption>Posting accounts</Caption>
            <div className="grid gap-4 sm:grid-cols-2">
              <AccountingPicker
                label="Wages expense"
                visibleLabel="Wages expense"
                value={state.accounts.officer_wages}
                options={optionsFor("expense")}
                onChange={(v) => setAccount("officer_wages", v)}
              />
              <AccountingPicker
                label="Net pay liability"
                visibleLabel="Net pay"
                value={state.accounts.net_pay}
                options={optionsFor("liability")}
                onChange={(v) => setAccount("net_pay", v)}
              />
              <AccountingPicker
                label="Employee tax liability"
                visibleLabel="Taxes withheld"
                value={state.accounts.employee_tax}
                options={optionsFor("liability")}
                onChange={(v) => setAccount("employee_tax", v)}
              />
              <AccountingPicker
                label="Employer tax expense"
                visibleLabel="Employer tax expense"
                value={state.accounts.employer_tax}
                options={optionsFor("expense")}
                onChange={(v) => setAccount("employer_tax", v)}
              />
              <AccountingPicker
                label="Employer tax liability"
                visibleLabel="Employer tax payable"
                value={state.accounts.employer_tax_offset}
                options={optionsFor("liability")}
                onChange={(v) => setAccount("employer_tax_offset", v)}
              />
              {state.retirement && (
                <AccountingPicker
                  label="Retirement liability"
                  visibleLabel="Retirement payable"
                  value={state.accounts.retirement_deferral}
                  options={optionsFor("liability")}
                  onChange={(v) => setAccount("retirement_deferral", v)}
                />
              )}
              {state.deduction && (
                <AccountingPicker
                  label="Other deduction liability"
                  visibleLabel="Other deductions payable"
                  value={state.accounts.other_deduction}
                  options={optionsFor("liability")}
                  onChange={(v) => setAccount("other_deduction", v)}
                />
              )}
              {state.reimbursement && (
                <AccountingPicker
                  label="Reimbursement account"
                  visibleLabel="Reimbursements"
                  value={state.accounts.reimbursement}
                  options={optionsFor("reimbursement")}
                  onChange={(v) => setAccount("reimbursement", v)}
                />
              )}
              {state.fee && (
                <>
                  <AccountingPicker
                    label="Payroll fee expense"
                    visibleLabel="Payroll fee expense"
                    value={state.accounts.provider_fee}
                    options={optionsFor("expense")}
                    onChange={(v) => setAccount("provider_fee", v)}
                  />
                  <AccountingPicker
                    label="Payroll fee liability"
                    visibleLabel="Payroll fee payable"
                    value={state.accounts.provider_fee_offset}
                    options={optionsFor("liability")}
                    onChange={(v) => setAccount("provider_fee_offset", v)}
                  />
                </>
              )}
            </div>

            <Caption>W-2 details</Caption>
            <div className="grid gap-4 sm:grid-cols-2">
              {FACT_FIELDS.map(([key, label]) => (
                <TextInput
                  key={key}
                  label={label}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={state.facts[key]}
                  onChange={(nextValue) =>
                    setState((s) => ({
                      ...s,
                      facts: { ...s.facts, [key]: nextValue },
                    }))
                  }
                />
              ))}
            </div>
          </div>
        </details>

        <WorkflowActions
          busy={command.busy}
          error={error || command.error}
          label="Save"
          onClose={onClose}
        />
      </form>
    </WorkflowDialog>
  );
}

function VoidDialog({
  run,
  today,
  onClose,
  onSaved,
}: {
  run: VoidTarget;
  today: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const command = useAccountingCommand(onSaved);
  return (
    <WorkflowDialog
      title="Void payroll run"
      description={`Run ${run.provider_run_id}, paid ${dateLabel(run.pay_date)}.`}
      busy={command.busy}
      onClose={onClose}
      form
      size="sm"
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void command.execute({
            type: "payroll.void",
            id: run.id,
            expected_version: run.version,
            effective_date: date,
            reason,
          });
        }}
      >
        <DateInput
          label="Effective date"
          required
          value={date}
          onChange={(nextValue) => setDate(nextValue)}
        />
        <TextInput
          label="Reason"
          required
          maxLength={1000}
          value={reason}
          onChange={(nextValue) => setReason(nextValue)}
        />
        <ActionFooter busy={command.busy} error={command.error}>
          <Button type="submit" variant="destructive" disabled={command.busy}>
            {command.busy ? "Voiding..." : "Void"}
          </Button>
        </ActionFooter>
      </form>
    </WorkflowDialog>
  );
}
