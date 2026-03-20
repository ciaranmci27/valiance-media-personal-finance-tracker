import type { TaxIncomeSource, TaxClassification, IncomeType } from "@/types/database";
import type { FilingStatus } from "@/lib/tax/constants";

/**
 * Generate template income line items based on business setup.
 * Returns regular TaxIncomeSource objects seeded with $0 amounts
 * that users can rename, delete, or supplement via the "+ Add" button.
 */
export function createTemplateIncomeSources(
  businessType: string,
  taxClassification: TaxClassification | null
): TaxIncomeSource[] {
  const classification = taxClassification ?? inferClassification(businessType);

  switch (classification) {
    case "s_corp":
      return [
        makeSource("Officer Salary", "w2", false),
        makeSource("Business Profit", "k1", false),
      ];
    case "sole_prop":
    case "disregarded":
      return [makeSource("Business Profit", "1099", true)];
    case "partnership":
      return [makeSource("Partnership Income", "k1", false)];
    case "c_corp":
      return [makeSource("Salary", "w2", false)];
    default:
      return [makeSource("W-2 Income", "w2", false)];
  }
}

function inferClassification(businessType: string): TaxClassification | null {
  switch (businessType) {
    case "sole_prop":
      return "sole_prop";
    case "s_corp":
      return "s_corp";
    case "partnership":
      return "partnership";
    default:
      return null;
  }
}

/**
 * Personal income templates - other income someone might have regardless of business.
 *
 * People's financial lives are complex: an S-Corp owner can also have a day job,
 * a sole prop can have investment income, etc. So personal templates are always
 * available. The only conditional is spouse income based on filing status.
 *
 * - W-2 Employment: always (separate job, day job, etc.)
 * - Spouse W-2: only for married filers (mfj, mfs)
 * - Freelance / Side Income: always (1099-NEC, subject to SE tax)
 * - Interest & Dividends: always (1099-INT/1099-DIV, not subject to SE tax)
 */
export function createPersonalTemplateSources(
  filingStatus: FilingStatus | null,
): TaxIncomeSource[] {
  const sources: TaxIncomeSource[] = [];

  sources.push(makeSource("W-2 Employment", "w2", false));

  const isMarried = filingStatus === "mfj" || filingStatus === "mfs";
  if (isMarried) {
    sources.push(makeSource("Spouse W-2", "w2", false));
  }

  sources.push(makeSource("Freelance / Side Income", "1099", true));
  sources.push(makeSource("Interest & Dividends", "1099", false));

  return sources;
}

/**
 * Check if a template income source is already present in existing sources.
 * Matches on name + income_type to avoid duplicates when re-opening the popover.
 */
export function isTemplateAlreadyAdded(
  template: TaxIncomeSource,
  existingSources: TaxIncomeSource[]
): boolean {
  return existingSources.some(
    (s) => s.name === template.name && s.income_type === template.income_type
  );
}

function makeSource(
  name: string,
  incomeType: IncomeType,
  subjectToSe: boolean
): TaxIncomeSource {
  return {
    id: crypto.randomUUID(),
    name,
    amount: 0,
    subject_to_se: subjectToSe,
    income_type: incomeType,
  };
}
