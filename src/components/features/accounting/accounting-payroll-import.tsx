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
import {
  gustoCreditNote,
  gustoSkippedNote,
  type GustoPreview,
  type GustoSkipped,
} from "@/lib/accounting/gusto-import";
import {
  correctChoice,
  gustoDefaultChoices,
  gustoFeeDefaults,
  gustoFeeSummary,
  gustoRunChoices,
  linkChoice,
  gustoSummary,
  gustoUnits,
  type GustoUnit,
} from "@/lib/accounting/gusto-review";
import { accountingHref } from "@/lib/accounting/views";
import { WorkflowDialog } from "./accounting-dialog";
import { JournalTotals } from "./accounting-journal-totals";
import { uploadEvidence } from "./accounting-documents";
import {
  GustoFees,
  GustoReview,
  GustoSummaryTiles,
} from "./accounting-payroll-gusto-review";
import { dateLabel, money } from "./format";

type Provider = "gusto" | "patriot";
type Inspection = {
  company_name?: string;
  company_id?: string;
  /** Gusto: first and last check dates in the export. */
  from?: string;
  to?: string;
  /** Gusto: $0 catch-up payrolls left out of the import. */
  skipped?: GustoSkipped[];
  employees: string[];
  payroll_count: number;
  mapping: PatriotMapping | null;
  /** Gusto: the account whose purpose is payroll fees, if any. */
  fee_account?: string | null;
  /** Gusto: the years the file covers (payrolls and the file name's range). */
  years?: number[];
  /** Gusto: the books' first year, the earliest year the owner can pick. */
  first_year?: number;
  /** Gusto: no payrolls and no range in the name, so the owner picks the year. */
  needs_year?: boolean;
};
type GustoDone = {
  linked: number;
  corrected: number;
  posted: number;
  fees: number;
  years: string[];
};

/** The payroll register for one calendar year, in Reports. */
const registerHref = (year: string) =>
  accountingHref("reports", undefined, {
    report: "payroll-register",
    support_filter: JSON.stringify({
      report_id: "payroll-register",
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      offset: 0,
    }),
  });
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
  const [provider, setProvider] = useState<Provider>("gusto");
  const [gusto, setGusto] = useState<{
    preview: GustoPreview;
    units: GustoUnit[];
  } | null>(null);
  const [unitChoices, setUnitChoices] = useState<Record<string, string>>({});
  const [gustoDone, setGustoDone] = useState<GustoDone | null>(null);
  const [feeAccount, setFeeAccount] = useState("");
  const [feeYear, setFeeYear] = useState("");
  const [feeChoices, setFeeChoices] = useState<Set<string>>(new Set());
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
      setGusto(null);
      evidence.current = null;
      const form = new FormData();
      form.set("mode", "inspect");
      form.set("provider", provider);
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
      if (provider === "gusto")
        setFeeAccount(data.fee_account || guess("expense", /payroll.*fee/i));
    });
  }
  function review() {
    if (!file) return;
    void work(async () => {
      const form = new FormData();
      form.set("mode", "preview");
      form.set("provider", provider);
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      if (provider === "gusto") {
        form.set("fee_account", feeAccount);
        if (inspection?.needs_year) form.set("year", feeYear);
        const data = (await request(form)) as GustoPreview;
        const units = gustoUnits(data.results);
        setGusto({ preview: data, units });
        setFeeChoices(new Set(gustoFeeDefaults(data.fees ?? [])));
        // A refreshed preview keeps the owner's choices that are still on offer.
        setUnitChoices((previous) => {
          const next = gustoDefaultChoices(units);
          for (const unit of units) {
            const kept = previous[unit.key];
            if (kept === undefined) continue;
            const offered =
              unit.state === "new"
                ? ["new", ""]
                : unit.state === "date_match" || unit.state === "difference"
                  ? [linkChoice(unit), correctChoice(unit)]
                  : [];
            if (offered.includes(kept)) next[unit.key] = kept;
          }
          return next;
        });
        setStep(3);
        return;
      }
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
  function commitGusto() {
    if (!file || !gusto) return;
    void work(async () => {
      const corrections = gusto.units.filter((u) =>
        unitChoices[u.key]?.startsWith("correct:"),
      );
      const feeMoves = (gusto.preview.fees ?? []).filter((r) =>
        feeChoices.has(r.id),
      );
      const changed = corrections.length + feeMoves.length;
      if (
        changed &&
        !(await confirm({
          title:
            changed === 1
              ? `Change 1 entry${gustoCount ? " and import" : ""}?`
              : `Change ${changed} entries${gustoCount ? " and import" : ""}?`,
          confirmLabel: gustoCount ? "Change and import" : "Change entries",
          variant: "warning",
          description: (
            <span className="block space-y-3">
              {corrections.map((unit) => {
                const entry = unit.runs[0].entry;
                return (
                  <span className="block" key={unit.key}>
                    {entry?.memo || "Payroll entry"}:{" "}
                    {unit.state === "date_match"
                      ? `moves from ${dateLabel(entry?.entry_date)} to ${dateLabel(unit.runs[0].pay_date)} with the same amounts.`
                      : `takes Gusto's amounts and keeps ${dateLabel(entry?.entry_date)}.`}
                  </span>
                );
              })}
              {feeMoves.length > 0 && (
                <span className="block">
                  {gustoFeeSummary(
                    gusto.preview.fees ?? [],
                    feeChoices,
                    accountName,
                    money,
                  )}
                </span>
              )}
              <span className="block">
                Each original entry and its reversal stay in history.
                {gustoCount
                  ? " The other selected payrolls are imported too."
                  : ""}
              </span>
            </span>
          ),
        }))
      )
        return;
      const runChoices = gustoRunChoices(gusto.units, unitChoices);
      if (evidence.current?.file !== file)
        evidence.current = { file, id: crypto.randomUUID() };
      const doc = await uploadEvidence(file, evidence.current.id);
      const form = new FormData();
      form.set("mode", "commit");
      form.set("provider", "gusto");
      form.set("document_id", doc.id);
      form.set("mapping", JSON.stringify(mapping));
      form.set("choices", JSON.stringify(runChoices));
      form.set("fee_account", feeAccount);
      if (inspection?.needs_year) form.set("year", feeYear);
      form.set(
        "fees",
        JSON.stringify(feeMoves.map((r) => ({ id: r.id, version: r.version }))),
      );
      const result = (await request(form)) as GustoPreview;
      const saved = result.results.filter((r) => runChoices[r.key] && r.run_id);
      const by = (prefix: string) =>
        saved.filter((r) => runChoices[r.key].startsWith(prefix)).length;
      setGustoDone({
        linked: by("link:"),
        corrected: by("correct:"),
        posted: by("new"),
        fees: feeMoves.length,
        years: [...new Set(saved.map((r) => r.pay_date.slice(0, 4)))].sort(),
      });
      setStep(4);
      try {
        await onSaved();
      } catch {
        setRefreshFailed(true);
      }
    });
  }
  function commit() {
    if (provider === "gusto") return commitGusto();
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
      form.set("provider", "patriot");
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
  const gustoTotals = gusto ? gustoSummary(gusto.units, unitChoices) : null;
  const gustoAllImported =
    !!gusto && gusto.units.every((u) => u.state === "duplicate");
  const gustoCount = gustoTotals ? gustoTotals.link + gustoTotals.posted : 0;
  const feeCount = (gusto?.preview.fees ?? []).filter((r) =>
    feeChoices.has(r.id),
  ).length;
  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? "Account";
  const gustoNothingToDo = gustoAllImported && feeCount === 0;
  /** A Gusto file with no payrolls: only fees and refunds can move. */
  const gustoFeesOnly = !!gusto && gusto.units.length === 0;
  const yearsLabel = (years: number[] | undefined) =>
    !years?.length
      ? ""
      : years.length > 2 && years.every((y, i) => !i || y === years[i - 1] + 1)
        ? `${years[0]} to ${years.at(-1)}`
        : years.join(" and ");
  const thisYear = new Date().getFullYear();
  const pickableYears = Array.from(
    {
      length: Math.max(1, thisYear - (inspection?.first_year ?? thisYear) + 1),
    },
    (_, i) => String(thisYear - i),
  );
  const isGusto = provider === "gusto";
  function chooseProvider(next: Provider) {
    if (next !== provider) {
      setFile(null);
      setInspection(null);
      setPreview(null);
      setGusto(null);
      setChoices({});
      setUnitChoices({});
      evidence.current = null;
    }
    setProvider(next);
    setStep(1);
  }
  return (
    <WorkflowDialog
      title={
        step !== 4
          ? "Import payroll"
          : gustoDone &&
              !(gustoDone.linked + gustoDone.corrected + gustoDone.posted)
            ? "Import finished"
            : "Payroll imported"
      }
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
            {(
              [
                {
                  id: "gusto",
                  name: "Gusto",
                  report: "Payroll data export (Excel)",
                  logo: "/logos/providers/gusto.svg",
                  width: 147,
                  height: 56,
                },
                {
                  id: "patriot",
                  name: "Patriot",
                  report: "Payroll Details CSV",
                  logo: "/logos/providers/patriot.png",
                  width: 1746,
                  height: 755,
                },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => chooseProvider(option.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/20 p-3 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring sm:gap-4"
              >
                <span className="flex h-18 w-18 shrink-0 items-center justify-center rounded-lg border border-[#e4e4e7] bg-[#ffffff] p-1.5">
                  <Image
                    src={option.logo}
                    alt=""
                    width={option.width}
                    height={option.height}
                    sizes="58px"
                    unoptimized={option.logo.endsWith(".svg")}
                    className="h-full w-full object-contain"
                  />
                </span>
                <span
                  className="w-px self-stretch bg-border"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{option.name}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {option.report}
                  </span>
                </span>
                <ArrowRight size={18} className="shrink-0" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {step === 1 && isGusto && (
          <div className="space-y-5">
            <div>
              <h3 className="text-lg font-semibold">Get your Gusto export</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Download one Excel file from Gusto, then upload it in the next
                step.
              </p>
            </div>
            <ol className="space-y-4">
              {[
                [
                  "Open Payroll data export",
                  <>
                    In Gusto, open{" "}
                    <strong className="font-medium text-foreground">
                      Reports
                    </strong>
                    , then{" "}
                    <strong className="font-medium text-foreground">
                      Payroll data export
                    </strong>
                    .
                  </>,
                ],
                [
                  "Choose the dates",
                  <>
                    Choose{" "}
                    <strong className="font-medium text-foreground">
                      Annually
                    </strong>{" "}
                    and a year, or a custom date range covering the payrolls you
                    want. One file can cover several years.
                  </>,
                ],
                [
                  "Generate the report",
                  <>
                    Click{" "}
                    <strong className="font-medium text-foreground">
                      Generate report
                    </strong>{" "}
                    and download the Excel file. Keep it unchanged.
                  </>,
                ],
                [
                  "Upload the Excel file here",
                  <>
                    The next step reads the file and shows how each payroll
                    lines up with your books before anything is saved.
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
              Payrolls already in your books are linked, not added again.
              Payments to Gusto from your bank are left as they are.
            </p>
          </div>
        )}
        {step === 1 && !isGusto && (
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
                {isGusto
                  ? "Upload your Gusto export"
                  : "Upload your Patriot report"}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {isGusto
                  ? "One year or several. Each payroll keeps its own pay date."
                  : "One payday or a full year. Each payroll keeps its original pay date."}
              </p>
            </div>
            <FileInput
              ref={fileInput}
              accept={
                isGusto
                  ? ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  : ".csv,text/csv"
              }
              className="sr-only"
              aria-label={
                isGusto
                  ? "Gusto payroll data export (.xlsx)"
                  : "Patriot Payroll Details CSV"
              }
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
                  : (file?.name ??
                    (isGusto
                      ? "Choose the Excel file or drop it here"
                      : "Choose a CSV or drop it here"))}
              </span>
              <span className="text-xs text-muted-foreground">
                {isGusto
                  ? "Payroll data export · .xlsx · Up to 2 MB"
                  : "Payroll Details · Group By: Check · Up to 2 MB"}
              </span>
            </button>
            {inspection && (
              <>
                <div className="rounded-xl bg-primary/5 px-4 py-3">
                  <p className="font-medium">
                    {!isGusto
                      ? inspection.company_name
                      : inspection.payroll_count
                        ? `Gusto payrolls ${dateLabel(inspection.from)} to ${dateLabel(inspection.to)}`
                        : `No Gusto payrolls in this file${inspection.years?.length ? ` (${yearsLabel(inspection.years)})` : ""}`}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {isGusto && !inspection.payroll_count
                      ? "Only Gusto fees and refunds in your books can be moved with it."
                      : `${isGusto ? "" : `${inspection.company_id} · `}${inspection.payroll_count} ${inspection.payroll_count === 1 ? "payroll" : "payrolls"} · ${inspection.employees.length} ${inspection.employees.length === 1 ? "employee" : "employees"}`}
                  </p>
                  {isGusto && inspection.needs_year && (
                    <Select
                      className="mt-3"
                      label="Year this file covers"
                      visibleLabel="Year this file covers"
                      helperText="The file name has no date range, so choose the year you exported."
                      value={feeYear}
                      options={pickableYears.map((y) => ({
                        value: y,
                        label: y,
                      }))}
                      onChange={(value) => setFeeYear(value)}
                      disabled={busy}
                    />
                  )}
                  {isGusto && !!inspection.skipped?.length && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {gustoSkippedNote(inspection.skipped, dateLabel)}{" "}
                      {gustoCreditNote(inspection.skipped, dateLabel)}
                    </p>
                  )}
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
                    {isGusto && (
                      <Select
                        label="Payroll fees"
                        visibleLabel="Payroll fees"
                        helperText="Gusto's monthly fees and fee refunds move here in the review. Any expense account works."
                        value={feeAccount}
                        searchable
                        options={usable
                          .filter((a) => a.account_type === "expense")
                          .map((a) => ({ value: a.id, label: a.name }))}
                        onChange={(value) => setFeeAccount(value)}
                        disabled={busy}
                      />
                    )}
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
        {step === 3 && isGusto && gusto && gustoTotals && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Review your payrolls</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {gustoFeesOnly
                  ? `Gusto · ${yearsLabel(gusto.preview.years)}. Nothing is saved until you import.`
                  : `Gusto · ${dateLabel(gusto.preview.from)} to ${dateLabel(gusto.preview.to)}. Nothing is saved until you import.`}
              </p>
            </div>
            {gustoFeesOnly && (
              <p className="rounded-xl bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
                {gusto.preview.fees?.length
                  ? `No Gusto payrolls in this file (${yearsLabel(gusto.preview.years)}). Only Gusto fees and refunds are listed.`
                  : `Nothing to import for ${yearsLabel(gusto.preview.years)}.`}
              </p>
            )}
            {!!gusto.preview.skipped?.length && (
              <p className="rounded-xl bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
                {gustoSkippedNote(gusto.preview.skipped, dateLabel)}{" "}
                {gustoCreditNote(gusto.preview.skipped, dateLabel)}
              </p>
            )}
            {!gustoFeesOnly && <GustoSummaryTiles summary={gustoTotals} />}
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span
                className={
                  gustoTotals.needChoice
                    ? "text-warning"
                    : "text-muted-foreground"
                }
              >
                {gustoFeesOnly
                  ? ""
                  : gustoTotals.needChoice
                    ? `Choose what happens to ${gustoTotals.needChoice} ${gustoTotals.needChoice === 1 ? "payroll" : "payrolls"} marked below.`
                    : gustoAllImported
                      ? "Every payroll in this file is already imported."
                      : "Every payroll has what it needs."}
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={review}
              >
                Refresh preview
              </Button>
            </div>
            <GustoReview
              units={gusto.units}
              choices={unitChoices}
              accounts={accounts}
              busy={busy}
              onChoose={(key, value) =>
                setUnitChoices((current) => ({
                  ...current,
                  [key]: value ?? "",
                }))
              }
            />
            {!gustoFeesOnly && (
              <p className="text-xs text-muted-foreground">
                Linked payrolls attach to the entries already in your books.
                Corrections reverse the old entry and keep it in history. The
                Excel file stays attached to every imported payroll.
              </p>
            )}
            <GustoFees
              rows={gusto.preview.fees ?? []}
              selected={feeChoices}
              accountName={accountName}
              busy={busy}
              onToggle={(id, checked) =>
                setFeeChoices((current) => {
                  const next = new Set(current);
                  if (checked) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
              onAll={(checked) =>
                setFeeChoices(
                  new Set(
                    checked ? gustoFeeDefaults(gusto.preview.fees ?? []) : [],
                  ),
                )
              }
            />
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
        {step === 4 && isGusto && gustoDone && (
          <div className="space-y-4 py-5 text-center">
            <CheckCircle2 size={42} className="mx-auto text-primary" />
            <h3 className="text-xl font-semibold">
              {gustoDone.linked + gustoDone.corrected + gustoDone.posted > 0
                ? `${gustoDone.linked + gustoDone.corrected + gustoDone.posted} ${gustoDone.linked + gustoDone.corrected + gustoDone.posted === 1 ? "payroll" : "payrolls"} imported from Gusto`
                : "Gusto fees updated"}
            </h3>
            <ul className="mx-auto max-w-sm space-y-1 text-sm text-muted-foreground">
              {(
                [
                  [gustoDone.linked, "linked to entries already in your books"],
                  [
                    gustoDone.corrected,
                    "linked after correcting their entries",
                  ],
                  [
                    gustoDone.posted,
                    gustoDone.posted === 1
                      ? "posted as a new payroll entry"
                      : "posted as new payroll entries",
                  ],
                  [
                    gustoDone.fees,
                    gustoDone.fees === 1
                      ? "Gusto fee or refund moved to its payroll account"
                      : "Gusto fees and refunds moved to their payroll accounts",
                  ],
                ] as const
              )
                .filter(([n]) => n > 0)
                .map(([n, text]) => (
                  <li key={text}>
                    <span className="font-medium text-foreground">{n}</span>{" "}
                    {text}
                  </li>
                ))}
            </ul>
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
              {gustoDone.years.map((year) => (
                <Link
                  key={year}
                  href={registerHref(year)}
                  onClick={onClose}
                  className="text-sm font-medium text-primary underline underline-offset-4"
                >
                  Open the {year} payroll register
                </Link>
              ))}
            </div>
            {refreshFailed && (
              <p role="alert" className="text-sm text-warning">
                Saved successfully. Refresh the page to reload the books.
              </p>
            )}
          </div>
        )}
        {step === 4 && !isGusto && (
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
              disabled={
                busy ||
                !inspection ||
                !validMapping ||
                (isGusto && !!inspection.needs_year && !feeYear)
              }
              onClick={review}
            >
              {busy ? "Reading..." : "Review payrolls"}
              <ArrowRight size={15} />
            </Button>
          )}
          {step === 3 && isGusto && gustoTotals && (
            <Button
              type="button"
              disabled={
                busy ||
                (gustoFeesOnly && feeCount === 0) ||
                (!gustoNothingToDo &&
                  (gustoTotals.needChoice > 0 || gustoCount + feeCount === 0))
              }
              onClick={gustoNothingToDo ? onClose : commit}
            >
              {busy
                ? "Importing..."
                : gustoFeesOnly && feeCount === 0
                  ? "Nothing to import"
                  : gustoNothingToDo
                    ? "Done"
                    : gustoTotals.needChoice > 0
                      ? `Choose for ${gustoTotals.needChoice} more`
                      : [
                          gustoCount
                            ? `Import ${gustoCount} ${gustoCount === 1 ? "payroll" : "payrolls"}`
                            : "",
                          feeCount
                            ? `${gustoCount ? "move" : "Move"} ${feeCount} ${feeCount === 1 ? "fee entry" : "fee entries"}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" and ")}
            </Button>
          )}
          {step === 3 && !isGusto && (
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
