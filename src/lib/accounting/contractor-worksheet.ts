import { contractorYearRules } from "./contractors";
import { formatCents } from "./money";
import type { SupportReportData } from "./support-reports";

/**
 * The contractor worksheet: who needs a 1099-NEC for a calendar year, and
 * what is missing before one can be filed. The books return each contractor
 * (a contact with the contractor role) with their type, whether a W-9 is on
 * file, what was paid from bank and cash accounts net of refunds, and what
 * was paid by card (accounting.support_report, reviewed transactions only).
 * Bank and cash payments count toward the year's line; card payments are
 * left out because the card company reports them on a 1099-K. The line
 * comes from the contractor rules (contractorYearRules), the same table the
 * books use. This worksheet prepares the decision; it does not file a form.
 */

const ZERO = BigInt(0);
const big = (value: string | undefined) => BigInt(value || "0");

export type ContractorKind = "unknown" | "individual" | "corporation" | "foreign" | "other";
export type W9Status = "missing" | "received" | "not_required";

/** Where a contractor stands, in the order the page lists them. */
export type ContractorStatus =
  | "missing-w9"
  | "decide"
  | "ready"
  | "under"
  | "exempt"
  | "unpaid";

export const KIND_LABELS: Record<ContractorKind, string> = {
  unknown: "Not reviewed",
  individual: "Individual",
  corporation: "Corporation",
  foreign: "Foreign",
  other: "Other",
};
export const W9_LABELS: Record<W9Status, string> = {
  missing: "Missing",
  received: "Received",
  not_required: "Not required",
};
export const STATUS_LABELS: Record<ContractorStatus, string> = {
  "missing-w9": "Needs a W-9",
  decide: "Needs a decision",
  ready: "Ready to file",
  under: "Under the line",
  exempt: "No 1099",
  unpaid: "Not paid",
};
const STATUS_ORDER: ContractorStatus[] = ["missing-w9", "decide", "ready", "under", "exempt", "unpaid"];

export interface ContractorLine {
  id: string;
  name: string;
  kind: ContractorKind;
  w9: W9Status;
  /** Paid from bank and cash accounts, net of refunds (may be below zero). */
  cash: bigint;
  /** What counts toward the line: the cash payments, never below zero. */
  reportable: bigint;
  /** Paid by card: left out, the card company reports it. */
  card: bigint;
  /** Everything paid, cash and card. */
  total: bigint;
  overLine: boolean;
  /** Paid over the line and not a corporation or foreign contractor. */
  needs1099: boolean;
  status: ContractorStatus;
  /** The next step, in a few words. */
  step: string;
  /** Why, in a sentence. */
  reason: string;
}

export interface ContractorRule {
  year: number;
  /** The year's reporting line, or null when the rules do not cover the year. */
  line: bigint | null;
  source: string | null;
}

/** The year's line from the contractor rules. */
export function contractorRule(year: number): ContractorRule {
  const rule = contractorYearRules[year];
  return { year, line: rule ? BigInt(rule.minimum_cents) : null, source: rule?.source ?? null };
}

/** The calendar years the rules cover, newest first, up to `today`'s year. */
export function contractorYears(today: string): number[] {
  const current = Number(today.slice(0, 4));
  return Object.keys(contractorYearRules)
    .map(Number)
    .filter((y) => y <= current)
    .sort((a, b) => b - a);
}

/** The worksheet's scope for a year: January 1 through today in the current year, else the whole year. */
export function contractorScope(year: number, today: string) {
  const through = String(year) === today.slice(0, 4) ? today : `${year}-12-31`;
  return { report_id: "contractor-worksheet" as const, from: `${year}-01-01`, to: through, offset: 0 };
}

const asKind = (v: string): ContractorKind =>
  (["individual", "corporation", "foreign", "other"] as string[]).includes(v) ? (v as ContractorKind) : "unknown";
const asW9 = (v: string): W9Status =>
  v === "received" || v === "not_required" ? v : "missing";

/** One contractor's standing for the year. */
export function contractorLine(
  row: { id: string; contractor_party_id?: string | null; cells: string[] },
  rule: ContractorRule,
  inProgress: boolean,
): ContractorLine {
  const [name, kindText, w9Text, cashText, cardText] = row.cells;
  const kind = asKind(kindText);
  const w9 = asW9(w9Text);
  const cash = big(cashText);
  const card = big(cardText);
  const reportable = cash > ZERO ? cash : ZERO;
  const total = cash + card;
  const line = rule.line;
  const overLine = line !== null && reportable >= line;
  const exempt = kind === "corporation" || kind === "foreign";
  const needs1099 = overLine && !exempt;
  const year = rule.year;
  const base = { id: row.contractor_party_id ?? row.id, name, kind, w9, cash, reportable, card, total, overLine, needs1099 };
  const lineText = line === null ? "" : formatCents(line);
  if (cash <= ZERO && card <= ZERO && total <= ZERO)
    return {
      ...base,
      status: "unpaid",
      step: `Not paid in ${year}`,
      reason: cash < ZERO ? "More was refunded than paid, so nothing counts." : `No payments to them in ${year}.`,
    };
  if (kind === "corporation")
    return {
      ...base,
      status: "exempt",
      step: "No 1099 for a corporation",
      reason: "Corporations usually get no 1099-NEC. Legal fees are the exception.",
    };
  if (kind === "foreign")
    return {
      ...base,
      status: "exempt",
      step: "No 1099; keep a W-8BEN",
      reason: "A foreign contractor gets no 1099-NEC. Their W-8BEN on file supports that.",
    };
  if (line === null)
    return {
      ...base,
      status: "decide",
      step: "No line for this year",
      reason: `The contractor rules do not cover ${year} yet.`,
    };
  if (!overLine)
    return {
      ...base,
      status: "under",
      step: inProgress && w9 === "missing" ? "Under so far; ask for a W-9" : `Under the ${year} line`,
      // No amounts in the reasons: the cards show them, masked in privacy mode.
      reason: `What counts is under the ${lineText} line${inProgress ? " so far" : ""}.`,
    };
  if (w9 === "missing")
    return {
      ...base,
      status: "missing-w9",
      step: "Ask for a W-9",
      reason: "Their W-9 gives the name, type and tax ID the 1099 needs.",
    };
  if (kind === "unknown")
    return {
      ...base,
      status: "decide",
      step: "Set their type from the W-9",
      reason: "The W-9 is on file, but the contact's type is not set.",
    };
  if (w9 === "not_required")
    return {
      ...base,
      status: "decide",
      step: "Check the W-9 setting",
      reason: "They are marked as not needing a W-9, but a 1099 needs one.",
    };
  if (kind === "other")
    return {
      ...base,
      status: "decide",
      step: "Decide if a 1099 applies",
      reason: "Their type is Other. A more specific type settles it.",
    };
  return {
    ...base,
    status: "ready",
    step: "Ready to file",
    reason: `Paid over the ${lineText} line, with a W-9 on file.`,
  };
}

/** Every contractor for the year, the ones that need something first, then by amount. */
export function contractorLines(data: SupportReportData): ContractorLine[] {
  const year = Number(data.filter.to.slice(0, 4));
  const rule = contractorRule(year);
  const inProgress = data.filter.to < `${year}-12-31`;
  return data.rows
    .map((r) => contractorLine(r, rule, inProgress))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        (b.total > a.total ? 1 : b.total < a.total ? -1 : 0) ||
        a.name.localeCompare(b.name),
    );
}

export interface ContractorTotals {
  paid: number;
  needs1099: number;
  /** Needing a 1099 but not ready: no W-9, or a decision left. */
  missing: number;
  ready: number;
  total: bigint;
  reportable: bigint;
  card: bigint;
  /** Contractors on file with nothing paid this year. */
  unpaid: number;
}

export function contractorTotals(lines: ContractorLine[]): ContractorTotals {
  const paid = lines.filter((l) => l.status !== "unpaid");
  return {
    paid: paid.length,
    needs1099: lines.filter((l) => l.needs1099).length,
    missing: lines.filter((l) => l.needs1099 && l.status !== "ready").length,
    ready: lines.filter((l) => l.status === "ready").length,
    total: paid.reduce((s, l) => s + l.total, ZERO),
    reportable: paid.reduce((s, l) => s + l.reportable, ZERO),
    card: paid.reduce((s, l) => s + (l.card > ZERO ? l.card : ZERO), ZERO),
    unpaid: lines.length - paid.length,
  };
}

export interface ContractorDecision {
  key: string;
  /** "look" needs the owner before filing; "info" is worth knowing. */
  tone: "look" | "info";
  title: string;
  detail: string;
  contactId: string;
}

/**
 * What the owner still has to decide before the 1099s can go out, in plain
 * words: a contact whose type is not set, a W-9 marked not required for
 * someone who needs a 1099, a type of Other over the line, and refunds
 * larger than the payments.
 */
export function contractorDecisions(lines: ContractorLine[]): ContractorDecision[] {
  const out: ContractorDecision[] = [];
  for (const l of lines) {
    if (l.status === "unpaid" && l.cash >= ZERO) continue;
    if (l.cash < ZERO)
      out.push({
        key: `refund-${l.id}`,
        tone: "look",
        title: `${l.name} refunded more than you paid`,
        detail: "Nothing counts toward the line. Check that the refunds belong to this year and this contact.",
        contactId: l.id,
      });
    if (l.kind === "unknown" && l.status !== "unpaid")
      out.push({
        key: `kind-${l.id}`,
        tone: l.overLine ? "look" : "info",
        title: `Is ${l.name} a person or a business?`,
        detail: l.overLine
          ? "Their type decides whether a 1099 is due. Set it on the contact, from their W-9."
          : "Under the line for now. Set their type from a W-9 before they pass it.",
        contactId: l.id,
      });
    if (l.overLine && l.w9 === "not_required" && (l.kind === "individual" || l.kind === "other" || l.kind === "unknown"))
      out.push({
        key: `w9-${l.id}`,
        tone: "look",
        title: `${l.name} is marked as not needing a W-9`,
        detail: "They were paid over the line, so a 1099 needs their W-9. Change the setting or record why not.",
        contactId: l.id,
      });
    if (l.overLine && l.kind === "other")
      out.push({
        key: `other-${l.id}`,
        tone: "look",
        title: `${l.name}'s type is Other`,
        detail: "Decide whether a 1099 applies, or choose Individual, Corporation or Foreign.",
        contactId: l.id,
      });
  }
  return out;
}

/** One sentence for the year: how many need a 1099 and how many are ready. */
export function contractorSentence(t: ContractorTotals, year: number, inProgress: boolean): string {
  if (t.paid === 0) return `No contractor was paid in ${year}${inProgress ? " so far" : ""}.`;
  if (t.needs1099 === 0)
    return `None of the ${t.paid} ${t.paid === 1 ? "contractor" : "contractors"} you paid ${inProgress ? "has passed" : "passed"} the line${inProgress ? " so far" : ""}, so no 1099 is due${inProgress ? " yet" : ""}.`;
  const ready = t.needs1099 - t.missing;
  return `${t.needs1099} ${t.needs1099 === 1 ? "contractor needs" : "contractors need"} a 1099 for ${year}; ${
    ready === t.needs1099 ? (t.needs1099 === 1 ? "it is" : "all are") + " ready to file" : `${ready} ${ready === 1 ? "is" : "are"} ready, ${t.missing} ${t.missing === 1 ? "needs" : "need"} something first`
  }.`;
}

/**
 * The 1099 note other pages show (Expenses by vendor), by this worksheet's
 * own rule, so the two never disagree: how many contractors need a 1099 for
 * the year, pointing at the worksheet. Null when none does.
 */
export function contractorNote(
  data: SupportReportData,
): { year: number; count: number; lead: string; text: string } | null {
  const year = Number(data.filter.to.slice(0, 4));
  const count = contractorTotals(contractorLines(data)).needs1099;
  if (!count) return null;
  const soFar = data.filter.to < `${year}-12-31` ? " so far" : "";
  const lead = `${count} ${count === 1 ? "contractor needs" : "contractors need"} a 1099 for ${year}${soFar}`;
  return { year, count, lead, text: `${lead}; see the Contractor worksheet.` };
}

/** The statement's groups, in order. */
export const CONTRACTOR_GROUPS: { key: "file" | "none" | "unpaid"; label: string; match: (l: ContractorLine) => boolean }[] = [
  { key: "file", label: "Need a 1099", match: (l) => l.needs1099 },
  { key: "none", label: "No 1099 needed", match: (l) => !l.needs1099 && l.status !== "unpaid" },
  { key: "unpaid", label: "Not paid this year", match: (l) => l.status === "unpaid" },
];

export const CONTRACTOR_NOTES = [
  "Contractors are the contacts with the contractor role. Payments count when they leave a bank or cash account in the calendar year, net of refunds from the same contractor.",
  "Card payments are left out: the card company reports them on a 1099-K.",
  "Reimbursed expenses are not separated from fees. If a contractor billed you for expenses, check whether those should count.",
  "Corporations usually get no 1099-NEC (legal fees are the exception), and foreign contractors get none; keep their W-8BEN on file.",
  "Only reviewed transactions count. This worksheet prepares the 1099s; it does not file them.",
];
