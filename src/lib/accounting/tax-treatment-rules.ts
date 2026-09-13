/**
 * Deterministic tax treatment suggestions for unmapped accounts.
 *
 * Every suggestion comes from something the books already know: last year's
 * mapping, the account's system purpose, its name, or its report group.
 * When no rule fits, the account is flagged for the owner to pick. There is
 * no guessing beyond these rules and no external classification.
 */
import { defaultChart } from "./chart";
import { taxConcepts, type TaxConcept, type TaxSource } from "./tax-workpapers";
import type { AccountProfile } from "./workflows";

export type TaxAccount = TaxSource["accounts"][number];
export type AccountKind = "income" | "expense";
export type TreatmentSource = "prior_year" | "purpose" | "name" | "subtype";

export interface TreatmentSuggestion {
  account_id: string;
  name: string;
  code: string;
  account_type: AccountKind;
  book_cents: string;
  concept: TaxConcept;
  deductible_bps: number;
  /** The rule, in the owner's words. */
  reason: string;
  source: TreatmentSource;
  confidence: "certain" | "likely";
}

export interface TreatmentReviewItem {
  account_id: string;
  name: string;
  code: string;
  account_type: AccountKind;
  book_cents: string;
  /** Why no rule placed it. */
  reason: string;
}

/** The concepts the workpapers editor offers per account type. */
export const INCOME_CONCEPTS: readonly TaxConcept[] = [
  "ordinary_income",
  "interest",
  "qualified_dividend",
  "short_gain",
  "long_gain",
  "tax_exempt",
  "excluded_book",
];
export const EXPENSE_CONCEPTS: readonly TaxConcept[] = [
  "ordinary_expense",
  "officer_wages",
  "meals",
  "travel",
  "nondeductible",
  "charity",
  "excluded_book",
];

export function conceptsFor(type: AccountKind): readonly TaxConcept[] {
  return type === "income" ? INCOME_CONCEPTS : EXPENSE_CONCEPTS;
}

export function conceptAllowed(type: AccountKind, concept: TaxConcept): boolean {
  return conceptsFor(type).includes(concept);
}

/** The editor's convention: full deduction for ordinary items, half for meals, none otherwise. */
export function deductibleBpsFor(concept: TaxConcept): number {
  switch (concept) {
    case "ordinary_income":
    case "ordinary_expense":
    case "officer_wages":
    case "travel":
      return 10000;
    case "meals":
      return 5000;
    default:
      return 0;
  }
}

const SQL_TO_TS: Record<string, TaxConcept> = {
  gross_receipts: "ordinary_income",
  other_deduction: "ordinary_expense",
  officer_compensation: "officer_wages",
  meals_50: "meals",
  balance_sheet_only: "excluded_book",
};

/** Stored mappings carry the SQL concept name; the command wants the app's. */
export function sqlConceptToTs(concept: string): TaxConcept | null {
  if (concept in SQL_TO_TS) return SQL_TO_TS[concept];
  return concept in taxConcepts ? (concept as TaxConcept) : null;
}

// ---------------------------------------------------------------------------
// Rules

const OFFICER_PURPOSES = new Set(["officer_compensation", "officer_wages"]);
const UNCATEGORIZED_PURPOSES = new Set(["uncategorized_income", "uncategorized_expense"]);

const PURPOSE_CONCEPT: Record<string, TaxConcept> = {
  officer_compensation: "officer_wages",
  officer_wages: "officer_wages",
  meals: "meals",
  travel: "travel",
};

function purposeLabel(purpose: string): string {
  return defaultChart.find((entry) => entry.purpose === purpose)?.name ?? purpose.replace(/_/g, " ");
}

type Rule = { concept: TaxConcept; reason: string; source: TreatmentSource; confidence: "certain" | "likely" };
type Outcome = { kind: "suggest"; rule: Rule } | { kind: "review"; reason: string } | null;

function fromPriorYear(account: TaxAccount, prior: TaxSource | null): Outcome {
  const mapping = prior?.accounts.find((a) => a.account_id === account.account_id)?.mapping;
  if (!mapping || !prior) return null;
  const concept = sqlConceptToTs(String(mapping.concept));
  if (!concept || !conceptAllowed(account.account_type, concept)) return null;
  return {
    kind: "suggest",
    rule: {
      concept,
      reason: `Same treatment as ${prior.year}`,
      source: "prior_year",
      confidence: "certain",
    },
  };
}

function fromPurpose(account: TaxAccount, profile: AccountProfile | undefined): Outcome {
  const purpose = profile?.purpose;
  if (!purpose) return null;
  if (UNCATEGORIZED_PURPOSES.has(purpose)) {
    return { kind: "review", reason: "Categorise these transactions first" };
  }
  const known = defaultChart.find((entry) => entry.purpose === purpose);
  const concept: TaxConcept | undefined =
    PURPOSE_CONCEPT[purpose] ??
    (known
      ? known.account_type === "income"
        ? "ordinary_income"
        : known.account_type === "expense"
          ? "ordinary_expense"
          : undefined
      : OFFICER_PURPOSES.has(purpose)
        ? "officer_wages"
        : undefined);
  if (!concept || !conceptAllowed(account.account_type, concept)) return null;
  return {
    kind: "suggest",
    rule: {
      concept,
      reason: `Account purpose is ${purposeLabel(purpose)}`,
      source: "purpose",
      confidence: "certain",
    },
  };
}

const INCOME_PATTERNS: { concept: TaxConcept; test: RegExp; what: string }[] = [
  { concept: "interest", test: /\binterest\b/i, what: "interest" },
  { concept: "qualified_dividend", test: /\bdividend/i, what: "dividend" },
  { concept: "tax_exempt", test: /tax[\s-]?exempt|municipal/i, what: "tax-exempt" },
];
const EXPENSE_PATTERNS: { concept: TaxConcept; test: RegExp; what: string }[] = [
  { concept: "meals", test: /\bmeals?\b|\bdining\b|\brestaurant/i, what: "meals" },
  { concept: "travel", test: /\btravel|\bairfare|\bflights?\b|\blodging|\bhotel|\bmileage/i, what: "travel" },
  { concept: "nondeductible", test: /\bpenalt|\bfines?\b|\bentertain|income tax|federal tax|state tax|estimated tax/i, what: "a nondeductible item" },
  { concept: "charity", test: /\bcharit|\bdonation/i, what: "charity" },
  { concept: "officer_wages", test: /\bofficer\b.*(salar|wage|comp)|(salar|wage|comp).*\bofficer\b/i, what: "officer wages" },
];

/** Every treatment a name points at, or a review flag when gains lack a term. */
function nameMatches(
  text: string,
  type: TaxAccount["account_type"],
): Map<TaxConcept, string> | { kind: "review"; reason: string } {
  const matches = new Map<TaxConcept, string>();
  if (type === "income") {
    for (const p of INCOME_PATTERNS) if (p.test.test(text)) matches.set(p.concept, p.what);
    if (/\bgains?\b|\blosse?s?\b/i.test(text)) {
      const long = /\blong[\s-]?term|\blong\b/i.test(text);
      const short = /\bshort[\s-]?term|\bshort\b/i.test(text);
      if (long && !short) matches.set("long_gain", "long-term gains");
      else if (short && !long) matches.set("short_gain", "short-term gains");
      else return { kind: "review", reason: "Say whether these gains are short- or long-term" };
    }
  } else {
    for (const p of EXPENSE_PATTERNS) if (p.test.test(text)) matches.set(p.concept, p.what);
  }
  return matches;
}

function fromName(account: TaxAccount, profile: AccountProfile | undefined): Outcome {
  // The owner's own name for the account is the deliberate signal. The name
  // it had in Wave only counts when the current name says nothing, so a
  // rename is never second-guessed by the alias it replaced.
  const own = nameMatches(account.name, account.account_type);
  if (!(own instanceof Map)) return own;
  const wave = profile?.external_names?.wave?.trim() ?? "";
  let matches = own;
  let where = "Name";
  if (own.size === 0 && wave) {
    const alias = nameMatches(wave, account.account_type);
    if (!(alias instanceof Map)) return alias;
    matches = alias;
    where = "Wave name";
  }

  if (matches.size === 0) return null;
  if (matches.size > 1) return { kind: "review", reason: `${where} fits more than one treatment` };
  const [concept, what] = [...matches.entries()][0];
  return {
    kind: "suggest",
    rule: {
      concept,
      reason: `${where} suggests ${what}`,
      source: "name",
      confidence: "likely",
    },
  };
}

const SUBTYPE_CONCEPT: Record<string, TaxConcept> = {
  revenue: "ordinary_income",
  cogs: "ordinary_expense",
  operating_expense: "ordinary_expense",
  payroll_expense: "ordinary_expense",
};

function fromSubtype(account: TaxAccount, profile: AccountProfile | undefined): Outcome {
  const subtype = (profile?.subtype ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const concept = SUBTYPE_CONCEPT[subtype];
  if (!concept || !conceptAllowed(account.account_type, concept)) return null;
  return {
    kind: "suggest",
    rule: {
      concept,
      reason: `Report group is ${subtype.replace(/_/g, " ")}`,
      source: "subtype",
      confidence: "likely",
    },
  };
}

// ---------------------------------------------------------------------------

export function suggestTreatments(input: {
  source: TaxSource;
  profiles: AccountProfile[];
  prior: TaxSource | null;
}): { suggestions: TreatmentSuggestion[]; review: TreatmentReviewItem[] } {
  const suggestions: TreatmentSuggestion[] = [];
  const review: TreatmentReviewItem[] = [];
  const profileById = new Map(input.profiles.map((p) => [p.account_id, p]));

  for (const account of input.source.accounts) {
    if (account.current || account.line_count === 0) continue;
    const profile = profileById.get(account.account_id);
    const outcome =
      fromPriorYear(account, input.prior) ??
      fromPurpose(account, profile) ??
      fromName(account, profile) ??
      fromSubtype(account, profile) ??
      ({ kind: "review", reason: "No rule fits this account" } as Outcome);

    const base = {
      account_id: account.account_id,
      name: account.name,
      code: account.code,
      account_type: account.account_type,
      book_cents: account.book_cents,
    };
    if (outcome?.kind === "suggest") {
      suggestions.push({
        ...base,
        concept: outcome.rule.concept,
        deductible_bps: deductibleBpsFor(outcome.rule.concept),
        reason: outcome.rule.reason,
        source: outcome.rule.source,
        confidence: outcome.rule.confidence,
      });
    } else if (outcome?.kind === "review") {
      review.push({ ...base, reason: outcome.reason });
    }
  }

  return { suggestions, review };
}
