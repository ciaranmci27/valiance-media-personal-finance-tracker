"use client";
import { useRef, useState } from "react";
import Image from "next/image";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { FileInput } from "@/components/ui/inputs/FileInput";
import Link from "next/link";
import { ArrowRight, Check, CheckCircle2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Select } from "@/components/ui/inputs/Select";
import { MaskedValue } from "@/components/ui/masked-value";
import type { AccountingAccount } from "@/lib/accounting/contracts";
import {
  patriotMappingSchema,
  type PatriotMapping,
  type PatriotPreview,
} from "@/lib/accounting/patriot-import";
import { WorkflowDialog } from "./accounting-dialog";
import { JournalTotals } from "./accounting-journal-totals";
import { uploadEvidence } from "./accounting-documents";
import { dateLabel, money } from "./format";

type Inspection = {
  company_name: string;
  company_id: string;
  employees: string[];
  payroll_count: number;
  mapping: PatriotMapping | null;
};
const roles = [
  ["wages", "Wages expense", "expense"],
  ["employer_tax", "Employer payroll tax expense", "expense"],
  ["net_pay", "Net salary payable", "liability"],
  ["tax_payable", "Payroll taxes payable", "liability"],
] as const;

async function request(form: FormData) {
  const response = await fetch("/api/accounting/payroll-import", {
    method: "POST",
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Unable to import payroll.");
  return data;
}

export function AccountingPayrollImport({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: AccountingAccount[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { confirm, dialog } = useConfirmationDialog();
  const [step, setStep] = useState(0);
  const [page, setPage] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<PatriotMapping>({
    wages: "",
    employer_tax: "",
    net_pay: "",
    tax_payable: "",
    officers: [],
  });
  const [preview, setPreview] = useState<PatriotPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const [linkedCount, setLinkedCount] = useState(0);
  const [correctedCount, setCorrectedCount] = useState(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const flight = useRef(false);
  const evidence = useRef<{ file: File; id: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const usable = accounts.filter((a) => !a.is_archived);
  async function work(task: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Something went wrong. Please retry.",
      );
    } finally {
      setBusy(false);
      flight.current = false;
    }
  }
  function inspect(chosen: File) {
    void work(async () => {
      setInspection(null);
      setFile(chosen);
      setPreview(null);
      evidence.current = null;
      const form = new FormData();
      form.set("mode", "inspect");
      form.set("file", chosen);
      const data = (await request(form)) as Inspection;
      setInspection(data);
      const guess = (type: string, pattern: RegExp) => {
        const matches = usable.filter(
          (a) => a.account_type === type && pattern.test(a.name),
        );
        return matches.length === 1 ? matches[0].id : "";
      };
      setMapping(
        data.mapping ?? {
          wages: guess("expense", /salary|wages/i),
          employer_tax: guess("expense", /employer.*tax/i),
          net_pay: guess("liability", /net.*(salary|pay).*payable/i),
          tax_payable: guess("liability", /^(payroll )?taxes payable$/i),
          officers: [],
        },
      );
    });
  }
  function review() {
    if (!file) return;
    void work(async () => {
      const form = new FormData();
      form.set("mode", "preview");
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      const data = (await request(form)) as PatriotPreview;
      setPreview(data);
      setPage(0);
      setChoices(
        Object.fromEntries(
          data.results.flatMap((r) =>
            r.state === "new"
              ? [[r.key, "new"]]
              : r.state === "match" && r.candidates.length === 1
                ? [[r.key, r.candidates[0].id]]
                : [],
          ),
        ),
      );
      setStep(3);
    });
  }
  function commit() {
    if (!file || !preview || !Object.keys(choices).length) return;
    void work(async () => {
      const corrections = preview.results.filter((r) =>
        choices[r.key]?.startsWith("correct-date:"),
      );
      if (
        corrections.length &&
        !(await confirm({
          title: "Correct journal dates and import?",
          confirmLabel: "Correct dates and import",
          variant: "warning",
          description: (
            <span className="block space-y-3">
              {corrections.map((r) => {
                const candidate = r.candidates.find(
                  (c) => c.id === choices[r.key].split(":")[1],
                );
                return (
                  <span className="block" key={r.key}>
                    {candidate?.memo}: reverse on{" "}
                    {dateLabel(candidate?.entry_date)} and create a replacement
                    on {dateLabel(r.pay_date)} with the same amounts.
                  </span>
                );
              })}
              <span className="block">
                This changes which period records the expense. The original and
                reversal stay in history. Other selected payrolls will also be
                imported.
              </span>
            </span>
          ),
        }))
      )
        return;
      if (evidence.current?.file !== file)
        evidence.current = { file, id: crypto.randomUUID() };
      const doc = await uploadEvidence(file, evidence.current.id);
      const form = new FormData();
      form.set("mode", "commit");
      form.set("document_id", doc.id);
      form.set("mapping", JSON.stringify(mapping));
      form.set("choices", JSON.stringify(choices));
      const result = (await request(form)) as PatriotPreview;
      setSavedCount(
        result.results.filter((r) => choices[r.key] && r.run_id).length,
      );
      setLinkedCount(
        Object.values(choices).filter(
          (c) => c !== "new" && !c.startsWith("correct-date:"),
        ).length,
      );
      setCorrectedCount(corrections.length);
      setStep(4);
      try {
        await onSaved();
      } catch {
        setRefreshFailed(true);
      }
    });
  }
  const count = Object.keys(choices).length;
  const createCount = Object.values(choices).filter(
    (choice) => choice === "new",
  ).length;
  const correctionCount = Object.values(choices).filter((c) =>
    c.startsWith("correct-date:"),
  ).length;
  const linkCount = count - createCount - correctionCount;
  const outcome = [
    createCount
      ? `Create ${createCount} journal${createCount === 1 ? "" : "s"}`
      : "",
    linkCount ? `link ${linkCount} existing` : "",
    correctionCount
      ? `correct ${correctionCount} date${correctionCount === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const validMapping = patriotMappingSchema.safeParse(mapping).success;
  return (
    <WorkflowDialog
      title={step === 4 ? "Payroll imported" : "Import payroll"}
      onClose={onClose}
      busy={busy}
      size="md"
    >
      {dialog}
      <div className="space-y-6">
        {step < 4 && (
          <ol
            aria-label="Import progress"
            className="grid grid-cols-4 gap-2 text-[11px] sm:flex sm:items-center sm:text-sm"
          >
            {["Provider", "Instructions", "Upload", "Review"].map(
              (label, i) => (
                <li
                  key={label}
                  aria-current={step === i ? "step" : undefined}
                  className={`flex flex-col items-center gap-1 sm:flex-row sm:gap-2 ${step === i ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${i <= step ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
                  >
                    {i < step ? <Check size={12} /> : i + 1}
                  </span>
                  {label}
                  {i < 3 && (
                    <ArrowRight
                      size={12}
                      className="mx-1 hidden sm:block"
                      aria-hidden="true"
                    />
                  )}
                </li>
              ),
            )}
          </ol>
        )}
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">
                Who processes your payroll?
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Bring in the report. We’ll handle the accounting entry.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/20 p-3 text-left transition-colors hover:bg-secondary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary sm:gap-4"
            >
              <span className="flex h-18 w-18 shrink-0 items-center justify-center rounded-lg border border-[#e4e4e7] bg-[#ffffff] p-1.5">
                <Image
                  src="/logos/providers/patriot.png"
                  alt=""
                  width={1746}
                  height={755}
                  sizes="58px"
                  className="h-full w-full object-contain"
                />
              </span>
              <span
                className="w-px self-stretch bg-border"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Patriot</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  Payroll Details CSV
                </span>
              </span>
              <ArrowRight size={18} className="shrink-0" aria-hidden="true" />
            </button>
            <p className="text-xs text-muted-foreground">
              Patriot is currently supported.
            </p>
          </div>
        )}
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold">Get your Patriot report</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Download your payroll details, then upload the CSV in the next
                step.
              </p>
            </div>
            <ol className="space-y-4">
              {[
                [
                  "Open Payroll Details",
                  <>
                    In Patriot, go to{" "}
                    <strong className="font-medium text-foreground">
                      Reports → Payroll Reports → Payroll Details
                    </strong>
                    .
                  </>,
                ],
                [
                  "Choose the date range",
                  <>
                    Set the start and end dates using the{" "}
                    <strong className="font-medium text-foreground">
                      pay dates
                    </strong>{" "}
                    you want to import. You can include one payday, several
                    months, or a full year.
                  </>,
                ],
                [
                  "Check the report filters",
                  <>
                    Keep all locations and sources selected. Select the
                    employees whose payroll you want to import. For your own
                    payroll, select your name.
                  </>,
                ],
                [
                  "Group by Check",
                  <>
                    Set{" "}
                    <strong className="font-medium text-foreground">
                      Group By
                    </strong>{" "}
                    to{" "}
                    <strong className="font-medium text-foreground">
                      Check
                    </strong>{" "}
                    to include the individual paycheck details.
                  </>,
                ],
                [
                  "Download the CSV",
                  <>
                    Click{" "}
                    <strong className="font-medium text-foreground">
                      Download Spreadsheet
                    </strong>{" "}
                    at the top of the report. Keep the downloaded CSV unchanged.
                  </>,
                ],
              ].map(([title, description], i) => (
                <li key={i} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold">{title}</h4>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {description}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="rounded-xl bg-secondary/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              Importing multiple employees? The CSV must include each employee’s
              name so we can identify their payroll correctly.
            </p>
            <a
              href="https://help.patriotsoftware.com/en/articles/15383597-payroll-details-report"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex text-sm font-medium text-primary underline underline-offset-4"
            >
              Open Patriot’s report guide
            </a>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold">
                Upload your Patriot report
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                One payday or a full year. Each payroll keeps its original pay
                date.
              </p>
            </div>
            <FileInput
              ref={fileInput}
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Patriot Payroll Details CSV"
              disabled={busy}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) inspect(chosen);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = e.dataTransfer.files[0];
                if (dropped && !busy) inspect(dropped);
              }}
              className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border bg-secondary/20 px-5 py-8 text-center hover:border-primary/60 disabled:opacity-60"
            >
              <Upload
                size={24}
                className="mb-1 text-primary"
                aria-hidden="true"
              />
              <span className="max-w-full break-all font-medium">
                {busy
                  ? "Reading report..."
                  : (file?.name ?? "Choose a CSV or drop it here")}
              </span>
              <span className="text-xs text-muted-foreground">
                Payroll Details · Group By: Check · Up to 2 MB
              </span>
            </button>
            {inspection && (
              <>
                <div className="rounded-xl bg-primary/5 px-4 py-3">
                  <p className="font-medium">{inspection.company_name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {inspection.company_id} · {inspection.payroll_count}{" "}
                    {inspection.payroll_count === 1 ? "payroll" : "payrolls"} ·{" "}
                    {inspection.employees.length}{" "}
                    {inspection.employees.length === 1
                      ? "employee"
                      : "employees"}
                  </p>
                </div>
                <details
                  open={!inspection.mapping || !validMapping}
                  className="rounded-xl border border-border p-4"
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    Payroll accounts
                    {!inspection.mapping && " · First-time setup"}
                  </summary>
                  <div className="mt-4 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      We’ll remember these choices after your first import. Bank
                      withdrawals are matched separately in Transactions.
                    </p>
                    {roles.map(([key, label, type]) => (
                      <Select
                        key={key}
                        label={label}
                        visibleLabel={label}
                        value={mapping[key]}
                        searchable
                        options={usable
                          .filter((a) => a.account_type === type)
                          .map((a) => ({ value: a.id, label: a.name }))}
                        onChange={(value) =>
                          setMapping((m) => ({ ...m, [key]: value }))
                        }
                        disabled={busy}
                      />
                    ))}
                    <fieldset className="space-y-2 border-t border-border pt-3">
                      <legend className="text-sm font-medium">
                        Company officers
                      </legend>
                      <p className="text-xs text-muted-foreground">
                        Select employees who are company officers. Leave other
                        employees unchecked.
                      </p>
                      {inspection.employees.map((name) => (
                        <Checkbox
                          key={name}
                          label={name}
                          checked={mapping.officers.includes(name)}
                          disabled={busy}
                          onChange={(checked) =>
                            setMapping((m) => ({
                              ...m,
                              officers: checked
                                ? [...m.officers, name]
                                : m.officers.filter((n) => n !== name),
                            }))
                          }
                        />
                      ))}
                    </fieldset>
                  </div>
                </details>
              </>
            )}
          </div>
        )}
        {step === 3 && preview && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Review your payrolls</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {preview.company_name} · {preview.results.length}{" "}
                {preview.results.length === 1 ? "payroll" : "payrolls"} found
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{count} selected</span>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={review}
              >
                Refresh preview
              </Button>
            </div>
            <div
              className={`grid grid-cols-2 gap-2 rounded-xl bg-secondary/40 p-4 text-center ${correctionCount ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}
            >
              {[
                [
                  "Create journal",
                  preview.results.filter((r) => r.state === "new").length,
                ],
                [
                  "Link existing",
                  preview.results.filter(
                    (r) =>
                      r.state === "match" ||
                      choices[r.key]?.startsWith("link-date:"),
                  ).length,
                ],
                ...(correctionCount ? [["Correct date", correctionCount]] : []),
                [
                  "Already imported",
                  preview.results.filter((r) => r.state === "duplicate").length,
                ],
                [
                  "Needs review",
                  preview.results.filter(
                    (r) =>
                      r.state === "conflict" ||
                      (r.state === "date_match" && !choices[r.key]),
                  ).length,
                ],
              ].map(([label, total]) => (
                <div key={label}>
                  <p className="text-xl font-semibold">{total}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
            {preview.results.slice(page * 20, (page + 1) * 20).map((r) => {
              const total = BigInt(r.gross) + BigInt(r.employer_tax);
              return (
                <article
                  key={r.key}
                  className={`rounded-xl border border-border p-4 ${r.state === "duplicate" ? "bg-secondary/30" : "bg-background"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      {r.state === "new" || r.state === "match" ? (
                        <Checkbox
                          ariaLabel={`Include payroll paid ${dateLabel(r.pay_date)}`}
                          className="mt-1"
                          checked={!!choices[r.key]}
                          disabled={
                            busy ||
                            (r.state === "match" &&
                              r.candidates.length > 1 &&
                              !choices[r.key])
                          }
                          onChange={(checked) =>
                            setChoices((current) => {
                              const next = { ...current };
                              if (checked)
                                next[r.key] =
                                  r.state === "new"
                                    ? "new"
                                    : r.candidates[0].id;
                              else delete next[r.key];
                              return next;
                            })
                          }
                        />
                      ) : r.state === "duplicate" ? (
                        <CheckCircle2
                          size={18}
                          className="mt-0.5 shrink-0 text-primary"
                        />
                      ) : null}
                      <div>
                        <h4 className="font-semibold">
                          Payday {dateLabel(r.pay_date)}
                        </h4>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {dateLabel(r.period_from)} to {dateLabel(r.period_to)}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <MaskedValue
                        value={money(total)}
                        className="font-semibold tabular-nums"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Payroll cost
                      </p>
                    </div>
                  </div>
                  <p
                    className={`mt-3 text-sm ${r.state === "conflict" ? "text-warning" : "text-muted-foreground"}`}
                  >
                    {r.state === "match"
                      ? "Payroll is already recorded. Attach this report to the matching journal without adding another expense."
                      : r.state === "duplicate"
                        ? "This report's payroll has already been imported. Nothing will be added."
                        : r.state === "new"
                          ? "Create a journal entry dated on this payday."
                          : r.message}
                  </p>
                  {(r.state === "conflict" || r.state === "date_match") &&
                    r.candidates.some((c) => c.lines) && (
                      <details
                        className="mt-3 text-sm"
                        open={r.state === "date_match" ? true : undefined}
                      >
                        <summary className="cursor-pointer font-medium">
                          View differences
                        </summary>
                        {r.candidates.map((candidate) => {
                          const expected = new Map<string, bigint>();
                          const add = (id: string, amount: bigint) =>
                            expected.set(
                              id,
                              (expected.get(id) ?? BigInt(0)) + amount,
                            );
                          add(mapping.wages, BigInt(r.gross));
                          add(mapping.employer_tax, BigInt(r.employer_tax));
                          add(mapping.net_pay, -BigInt(r.net));
                          add(
                            mapping.tax_payable,
                            -(
                              BigInt(r.gross) -
                              BigInt(r.net) +
                              BigInt(r.employer_tax)
                            ),
                          );
                          const existing = new Map<string, bigint>();
                          for (const line of candidate.lines ?? [])
                            existing.set(
                              line.account_id,
                              (existing.get(line.account_id) ?? BigInt(0)) +
                                BigInt(line.amount_cents),
                            );
                          return (
                            <div
                              key={candidate.id}
                              className="mt-3 space-y-2 rounded-xl border border-border p-3"
                            >
                              <Link
                                href={`/accounting?view=journal&entry=${candidate.id}`}
                                className="font-medium underline"
                              >
                                Open {candidate.memo}
                              </Link>
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr>
                                      <th className="py-2 text-left">
                                        Compare
                                      </th>
                                      <th className="px-2 text-right">
                                        Patriot report
                                      </th>
                                      <th className="text-right">
                                        Existing journal
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <tr
                                      className={
                                        candidate.entry_date !== r.pay_date
                                          ? "text-warning"
                                          : ""
                                      }
                                    >
                                      <td className="py-2">Date</td>
                                      <td className="px-2 text-right">
                                        {dateLabel(r.pay_date)}
                                      </td>
                                      <td className="text-right">
                                        {dateLabel(candidate.entry_date)}
                                      </td>
                                    </tr>
                                    {[
                                      ...new Set([
                                        ...expected.keys(),
                                        ...existing.keys(),
                                      ]),
                                    ].map((id) => (
                                      <tr
                                        key={id}
                                        className={
                                          (expected.get(id) ?? BigInt(0)) !==
                                          (existing.get(id) ?? BigInt(0))
                                            ? "text-warning"
                                            : ""
                                        }
                                      >
                                        <td className="py-2">
                                          {accounts.find((a) => a.id === id)
                                            ?.name ?? "Account"}
                                        </td>
                                        <td className="px-2 text-right">
                                          <MaskedValue
                                            value={money(
                                              expected.get(id) ?? BigInt(0),
                                            )}
                                          />
                                        </td>
                                        <td className="text-right">
                                          <MaskedValue
                                            value={money(
                                              existing.get(id) ?? BigInt(0),
                                            )}
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {r.state === "date_match" &&
                              candidate.amounts_match ? (
                                <div className="space-y-3 pt-2">
                                  <p className="text-xs text-muted-foreground">
                                    All amounts match. Linking keeps{" "}
                                    {dateLabel(candidate.entry_date)}. Matching
                                    Patriot creates a dated correction.
                                  </p>
                                  <Select
                                    label="Resolve payroll date"
                                    visibleLabel="What should happen?"
                                    value={
                                      choices[r.key]?.split(":")[1] ===
                                      candidate.id
                                        ? choices[r.key]
                                        : ""
                                    }
                                    disabled={busy}
                                    options={[
                                      {
                                        value: "",
                                        label:
                                          "Choose an action or leave skipped",
                                      },
                                      {
                                        value: `link-date:${candidate.id}:${candidate.version}:${candidate.entry_date}`,
                                        label:
                                          "Link existing journal (recommended)",
                                      },
                                      ...(candidate.can_correct_date
                                        ? [
                                            {
                                              value: `correct-date:${candidate.id}:${candidate.version}:${candidate.entry_date}`,
                                              label: `Match Patriot’s date: ${dateLabel(r.pay_date)}`,
                                            },
                                          ]
                                        : []),
                                    ]}
                                    onChange={(value) =>
                                      setChoices((current) => {
                                        const next = { ...current };
                                        if (value) next[r.key] = value;
                                        else delete next[r.key];
                                        return next;
                                      })
                                    }
                                  />
                                  {!candidate.can_correct_date && (
                                    <p className="text-xs text-muted-foreground">
                                      Date correction is unavailable while a
                                      period is locked or this journal has
                                      linked bank, reconciliation, or register
                                      records. You can still link the report.
                                    </p>
                                  )}
                                  {choices[r.key]?.startsWith(
                                    `link-date:${candidate.id}:`,
                                  ) && (
                                    <p className="text-xs text-primary">
                                      Selected: attach the report and keep{" "}
                                      {dateLabel(candidate.entry_date)}. No new
                                      journal.
                                    </p>
                                  )}
                                  {choices[r.key]?.startsWith(
                                    `correct-date:${candidate.id}:`,
                                  ) && (
                                    <p className="text-xs text-warning">
                                      Selected: reverse on{" "}
                                      {dateLabel(candidate.entry_date)} and
                                      replace on {dateLabel(r.pay_date)}. You’ll
                                      confirm this before importing.
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  This journal does not qualify for a date-only
                                  correction. Review it before importing.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </details>
                    )}
                  {r.state === "match" && (
                    <div className="mt-3">
                      <Select
                        label="Link existing journal"
                        visibleLabel="Link existing journal"
                        value={choices[r.key] ?? ""}
                        disabled={busy}
                        options={[
                          { value: "", label: "Skip this payroll" },
                          ...r.candidates.map((c) => ({
                            value: c.id,
                            label: c.memo,
                          })),
                        ]}
                        onChange={(value) =>
                          setChoices((current) => {
                            const next = { ...current };
                            if (value) next[r.key] = value;
                            else delete next[r.key];
                            return next;
                          })
                        }
                      />
                    </div>
                  )}
                  <details className="mt-3 text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      Payroll breakdown
                    </summary>
                    <dl className="my-3 grid grid-cols-2 gap-2">
                      {[
                        ["Gross wages", r.gross],
                        ["Employer taxes", r.employer_tax],
                        ["Take-home pay", r.net],
                        ["Taxes payable", String(total - BigInt(r.net))],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="text-xs text-muted-foreground">
                            {label}
                          </dt>
                          <dd className="mt-1">
                            <MaskedValue value={money(value)} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <JournalTotals debit={total} credit={total} />
                  </details>
                </article>
              );
            })}
            {preview.results.length > 20 && (
              <nav
                aria-label="Payroll preview pages"
                className="flex items-center justify-between gap-2 text-sm"
              >
                <Button
                  type="button"
                  variant="ghost"
                  disabled={page === 0 || busy}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span>
                  {page + 1} of {Math.ceil(preview.results.length / 20)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={(page + 1) * 20 >= preview.results.length || busy}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </nav>
            )}
            <p className="text-xs text-muted-foreground">
              Confirm only the selected payrolls. Existing journals will be
              linked; new payrolls get balanced entries dated on payday.
              Selected date corrections require confirmation. The original CSV
              stays attached.
            </p>
          </div>
        )}
        {step === 4 && (
          <div className="space-y-4 py-5 text-center">
            <CheckCircle2 size={42} className="mx-auto text-primary" />
            <h3 className="text-xl font-semibold">
              {savedCount} {savedCount === 1 ? "payroll" : "payrolls"} recorded
            </h3>
            <p className="text-sm text-muted-foreground">
              {linkedCount > 0
                ? `${linkedCount} linked to existing journals. `
                : ""}
              {correctedCount > 0
                ? `${correctedCount} journal date${correctedCount === 1 ? "" : "s"} corrected. `
                : ""}
              Your payroll records and journal entries are ready.
            </p>
            <p className="text-sm text-muted-foreground">
              Match the bank withdrawals to the payroll liabilities in
              Transactions.
            </p>
            {refreshFailed && (
              <p role="alert" className="text-sm text-warning">
                Saved successfully. Refresh the page to reload the books.
              </p>
            )}
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-sm text-error"
          >
            {error}
          </p>
        )}
        <div className="sticky -bottom-5 -mx-4 -mb-5 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-[var(--background-subtle)] px-4 py-4 sm:-mx-6 sm:px-6">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              step > 0 && step < 4
                ? (setStep(step - 1), setError(""))
                : onClose()
            }
          >
            {step > 0 && step < 4 ? "Back" : "Close"}
          </Button>
          {step === 1 && (
            <Button type="button" onClick={() => setStep(2)}>
              Continue to upload <ArrowRight size={15} aria-hidden="true" />
            </Button>
          )}
          {step === 2 && (
            <Button
              type="button"
              disabled={busy || !inspection || !validMapping}
              onClick={review}
            >
              {busy ? "Reading..." : "Review payrolls"}
              <ArrowRight size={15} />
            </Button>
          )}
          {step === 3 && (
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={
                  busy ||
                  (!count &&
                    !preview?.results.every((r) => r.state === "duplicate"))
                }
                onClick={count ? commit : onClose}
              >
                {busy
                  ? "Importing..."
                  : count
                    ? outcome.charAt(0).toUpperCase() + outcome.slice(1)
                    : preview?.results.every((r) => r.state === "duplicate")
                      ? "Done"
                      : "Select payrolls"}
              </Button>
            </div>
          )}
          {step === 4 && (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </WorkflowDialog>
  );
}
