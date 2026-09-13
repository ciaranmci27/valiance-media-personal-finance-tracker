import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import {
  CLASSIFICATION_LABELS,
  CLASSIFICATION_PHRASES,
  businessTypeForYear,
  classificationForYear,
  isElection,
  type EntityType,
  type ProfileClassification,
} from "./business-classification";

/**
 * The one record of who the business is. The tax estimator and the accounting
 * books both read it; neither keeps a copy. Backed by `public.business_profile`,
 * a singleton row with `id = 1`.
 */

// The classification rule is pure and shared; this module adds the record and its storage.
export {
  CLASSIFICATION_LABELS,
  CLASSIFICATION_PHRASES,
  businessTypeForYear,
  classificationForYear,
  defaultClassification,
  isElection,
} from "./business-classification";
export type { EntityType, ProfileClassification } from "./business-classification";

export interface BusinessAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
}

export interface BusinessProfile {
  id: number;
  legal_name: string;
  dba: string;
  entity_type: EntityType;
  ein: string;
  formation_date: string | null;
  state_of_formation: string;
  address: BusinessAddress;
  phone: string;
  email: string;
  tax_classification: ProfileClassification;
  tax_classification_since: number | null;
  home_state: string;
  is_sstb: boolean;
  fiscal_year_start_month: number;
  books_timezone: string;
  earliest_history_date: string | null;
  owner_name: string;
  owner_title: string;
  accountant_name: string;
  accountant_email: string;
  default_email_account_id: string | null;
  version: number;
  updated_at: string | null;
}

export const EMPTY_ADDRESS: BusinessAddress = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  postal_code: "",
};

export const EMPTY_PROFILE: BusinessProfile = {
  id: 1,
  legal_name: "",
  dba: "",
  entity_type: "llc",
  ein: "",
  formation_date: null,
  state_of_formation: "",
  address: EMPTY_ADDRESS,
  phone: "",
  email: "",
  tax_classification: "disregarded",
  tax_classification_since: null,
  home_state: "",
  is_sstb: false,
  fiscal_year_start_month: 1,
  books_timezone: "America/Phoenix",
  earliest_history_date: null,
  owner_name: "",
  owner_title: "Owner",
  accountant_name: "",
  accountant_email: "",
  default_email_account_id: null,
  version: 0,
  updated_at: null,
};

export const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "llc", label: "LLC" },
  { value: "corporation", label: "Corporation" },
  { value: "sole_proprietorship", label: "Sole proprietorship" },
  { value: "partnership", label: "Partnership" },
];

/** Which classifications a given entity can elect. */
export function classificationOptions(entity: EntityType) {
  const values: ProfileClassification[] =
    entity === "llc"
      ? ["disregarded", "s_corp", "c_corp", "partnership"]
      : entity === "corporation"
        ? ["c_corp", "s_corp"]
        : entity === "sole_proprietorship"
          ? ["sole_prop"]
          : ["partnership"];
  return values.map((value) => ({
    value,
    label: CLASSIFICATION_LABELS[value],
  }));
}

/** Short human line, e.g. "LLC taxed as an S corporation since 2023". */
export function describeTaxProfile(profile: BusinessProfile): string {
  const entity =
    ENTITY_TYPE_OPTIONS.find((o) => o.value === profile.entity_type)?.label ??
    "";
  const since = profile.tax_classification_since
    ? ` since ${profile.tax_classification_since}`
    : "";
  const elected =
    (profile.entity_type === "llc" &&
      profile.tax_classification !== "disregarded") ||
    (profile.entity_type === "corporation" &&
      profile.tax_classification === "s_corp");
  return elected
    ? `${entity} taxed as ${CLASSIFICATION_PHRASES[profile.tax_classification]}${since}`
    : entity;
}

/** The same line for one year, naming the pre-election default when it applies. */
export function describeTaxProfileForYear(
  profile: BusinessProfile,
  year: number,
): string {
  const since = profile.tax_classification_since;
  if (since === null || year >= since || !isElection(profile))
    return describeTaxProfile(profile);
  const entity =
    ENTITY_TYPE_OPTIONS.find((o) => o.value === profile.entity_type)?.label ??
    "";
  const elected = CLASSIFICATION_PHRASES[profile.tax_classification].replace(
    /^an? /,
    "",
  );
  return `${entity} taxed as ${CLASSIFICATION_PHRASES[classificationForYear(profile, year)]} in ${year}, ${elected} since ${since}`;
}

export const MONTH_OPTIONS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
].map((label, i) => ({ value: String(i + 1), label }));

export const TIMEZONE_OPTIONS = [
  { value: "America/Phoenix", label: "Arizona (no daylight saving)" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/New_York", label: "Eastern" },
  { value: "UTC", label: "UTC" },
];

export type ProfileLoad =
  | { status: "ready"; profile: BusinessProfile }
  | { status: "empty"; profile: BusinessProfile }
  | { status: "unavailable"; profile: BusinessProfile; reason: string };

const DEMO_PROFILE: BusinessProfile = {
  ...EMPTY_PROFILE,
  legal_name: "Demo Studio LLC",
  entity_type: "llc",
  ein: "12-3456789",
  formation_date: "2021-03-15",
  state_of_formation: "AZ",
  address: {
    line1: "100 Example Ave",
    line2: "",
    city: "Phoenix",
    state: "AZ",
    postal_code: "85001",
  },
  tax_classification: "s_corp",
  tax_classification_since: 2023,
  home_state: "AZ",
  earliest_history_date: "2022-12-31",
  owner_name: "Demo Owner",
  version: 3,
  updated_at: "2026-09-01T12:00:00Z",
};

function isMissingTable(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /business_profile.*(does not exist|schema cache)/i.test(error.message ?? "")
  );
}

function normalize(row: Record<string, unknown>): BusinessProfile {
  const address = (row.address as Partial<BusinessAddress> | null) ?? {};
  return {
    ...EMPTY_PROFILE,
    ...row,
    id: 1,
    dba: (row.dba as string) ?? "",
    ein: (row.ein as string) ?? "",
    state_of_formation: (row.state_of_formation as string) ?? "",
    phone: (row.phone as string) ?? "",
    email: (row.email as string) ?? "",
    home_state: (row.home_state as string) ?? "",
    owner_name: (row.owner_name as string) ?? "",
    owner_title: (row.owner_title as string) ?? "",
    accountant_name: (row.accountant_name as string) ?? "",
    accountant_email: (row.accountant_email as string) ?? "",
    address: { ...EMPTY_ADDRESS, ...address },
    version: Number(row.version ?? 0),
  } as BusinessProfile;
}

export async function loadBusinessProfile(): Promise<ProfileLoad> {
  if (isDemoMode()) return { status: "ready", profile: DEMO_PROFILE };
  const supabase = createClient();
  const { data, error } = await supabase
    .from("business_profile")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error))
      return {
        status: "unavailable",
        profile: EMPTY_PROFILE,
        reason:
          "The business profile table is not installed yet. It arrives with the accounting schema update.",
      };
    throw error;
  }
  if (!data) return { status: "empty", profile: EMPTY_PROFILE };
  return {
    status: "ready",
    profile: normalize(data as Record<string, unknown>),
  };
}

function toRow(profile: BusinessProfile) {
  const text = (v: string) => (v.trim() ? v.trim() : null);
  return {
    id: 1,
    legal_name: profile.legal_name.trim(),
    dba: text(profile.dba),
    entity_type: profile.entity_type,
    ein: text(profile.ein),
    formation_date: profile.formation_date || null,
    state_of_formation: text(profile.state_of_formation),
    address: profile.address,
    phone: text(profile.phone),
    email: text(profile.email),
    tax_classification: profile.tax_classification,
    tax_classification_since: profile.tax_classification_since,
    home_state: text(profile.home_state),
    is_sstb: profile.is_sstb,
    fiscal_year_start_month: profile.fiscal_year_start_month,
    books_timezone: profile.books_timezone,
    // The column is required in the database; an empty field keeps the stored value.
    ...(profile.earliest_history_date
      ? { earliest_history_date: profile.earliest_history_date }
      : {}),
    owner_name: text(profile.owner_name),
    owner_title: text(profile.owner_title),
    accountant_name: text(profile.accountant_name),
    accountant_email: text(profile.accountant_email),
    default_email_account_id: profile.default_email_account_id,
  };
}

/**
 * Saves the profile and stamps every estimator year with the profile's answer
 * for that year: the election from its start year on, the entity's default
 * before it. The estimator never needs its own copy of these two facts.
 */
export async function saveBusinessProfile(
  profile: BusinessProfile,
): Promise<BusinessProfile> {
  if (isDemoMode()) {
    await new Promise((r) => setTimeout(r, 300));
    return { ...profile, version: profile.version + 1 };
  }
  const supabase = createClient();
  const { data, error } = await supabase
    .from("business_profile")
    .upsert(toRow(profile), { onConflict: "id" })
    .select("*")
    .single();
  if (error) throw error;
  const saved = normalize(data as Record<string, unknown>);

  const since = saved.tax_classification_since;
  const stamp = (year: number) => ({
    business_type: businessTypeForYear(saved, year),
    tax_classification: classificationForYear(saved, year),
  });
  const writes = since
    ? [
        supabase
          .from("tax_estimates")
          .update(stamp(since))
          .is("deleted_at", null)
          .gte("tax_year", since),
        supabase
          .from("tax_estimates")
          .update(stamp(since - 1))
          .is("deleted_at", null)
          .lt("tax_year", since),
      ]
    : [
        supabase
          .from("tax_estimates")
          .update(stamp(new Date().getFullYear()))
          .is("deleted_at", null),
      ];
  for (const write of writes) {
    const { error: yearError } = await write;
    if (yearError) throw yearError;
  }
  return saved;
}
