/**
 * How the business is taxed in a given year. One rule, shared by the tax
 * estimator, the settings screens and the setup guide: the elected
 * classification from its start year onward, the entity's own default before
 * that. Pure, so it can run on the server and in tests.
 */
import type { BusinessType, TaxClassification } from "@/types/database";

export type EntityType =
  | "llc"
  | "corporation"
  | "sole_proprietorship"
  | "partnership";

export type ProfileClassification =
  | "disregarded"
  | "sole_prop"
  | "s_corp"
  | "c_corp"
  | "partnership";

/** The slice of the business profile the rule reads. */
export interface TaxProfileFacts {
  entity_type: EntityType;
  tax_classification: ProfileClassification;
  tax_classification_since: number | null;
}

export const CLASSIFICATION_LABELS: Record<ProfileClassification, string> = {
  disregarded: "Disregarded entity (Schedule C)",
  sole_prop: "Sole proprietor (Schedule C)",
  s_corp: "S corporation (Form 2553)",
  c_corp: "C corporation",
  partnership: "Partnership",
};

/** "a disregarded entity", for sentences. */
export const CLASSIFICATION_PHRASES: Record<ProfileClassification, string> = {
  disregarded: "a disregarded entity",
  sole_prop: "a sole proprietorship",
  s_corp: "an S corporation",
  c_corp: "a C corporation",
  partnership: "a partnership",
};

/** What an entity is taxed as when it elects nothing. */
export function defaultClassification(entity: EntityType): ProfileClassification {
  return entity === "llc"
    ? "disregarded"
    : entity === "corporation"
      ? "c_corp"
      : entity === "sole_proprietorship"
        ? "sole_prop"
        : "partnership";
}

/** True when the classification is an election, which needs a start year. */
export function isElection(
  profile: Pick<TaxProfileFacts, "entity_type" | "tax_classification">,
): boolean {
  return profile.tax_classification !== defaultClassification(profile.entity_type);
}

/** The election from its start year on; the entity's default before it. */
export function classificationForYear(
  profile: TaxProfileFacts,
  year: number,
): ProfileClassification {
  const since = profile.tax_classification_since;
  if (since !== null && year < since)
    return defaultClassification(profile.entity_type);
  return profile.tax_classification;
}

/** The estimator's business type for a year, so both features agree. */
export function businessTypeForYear(
  profile: TaxProfileFacts,
  year: number,
): BusinessType {
  switch (profile.entity_type) {
    case "llc":
      return "llc";
    case "corporation":
      return classificationForYear(profile, year) === "s_corp"
        ? "s_corp"
        : "c_corp";
    case "sole_proprietorship":
      return "sole_prop";
    case "partnership":
      return "partnership";
  }
}

/** The estimator stores the same vocabulary; the cast documents that. */
export function estimatorClassificationForYear(
  profile: TaxProfileFacts,
  year: number,
): TaxClassification {
  return classificationForYear(profile, year);
}
