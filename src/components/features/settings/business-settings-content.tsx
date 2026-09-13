"use client";
import { DateInput } from "@/components/ui/inputs/DateInput";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  Landmark,
  BookOpen,
  Users,
  Loader2,
  Check,
} from "lucide-react";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { Toggle } from "@/components/ui/inputs/Toggle";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import { getAvailableTaxYears } from "@/lib/tax/constants";
import {
  ENTITY_TYPE_OPTIONS,
  MONTH_OPTIONS,
  TIMEZONE_OPTIONS,
  classificationOptions,
  defaultClassification,
  describeTaxProfile,
  loadBusinessProfile,
  saveBusinessProfile,
  type BusinessProfile,
  type EntityType,
  type ProfileClassification,
  type ProfileLoad,
  CLASSIFICATION_PHRASES,
  isElection,
} from "@/lib/business-profile";

const EIN_PATTERN = /^\d{2}-?\d{7}$/;

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <div className="h-px flex-1 bg-border/50" />
      </div>
      <div className="glass-card space-y-5 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-teal-light">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
          <p className="pt-2 text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </section>
  );
}

export function BusinessSettingsContent() {
  const [load, setLoad] = React.useState<ProfileLoad | null>(null);
  const [profile, setProfile] = React.useState<BusinessProfile | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState("");
  const years = React.useMemo(() => getAvailableTaxYears(), []);
  // An election can predate the estimator's years: offer from formation (floor 2000) to next year.
  const electionYears = React.useMemo(() => {
    const now = new Date().getFullYear();
    const formed = profile?.formation_date
      ? Number(profile.formation_date.slice(0, 4)) || now
      : now;
    const first = Math.max(2000, Math.min(formed, now, ...years));
    const last = Math.max(now + 1, ...years);
    return Array.from({ length: last - first + 1 }, (_, i) => last - i);
  }, [profile?.formation_date, years]);

  React.useEffect(() => {
    let cancelled = false;
    loadBusinessProfile()
      .then((result) => {
        if (cancelled) return;
        setLoad(result);
        setProfile(result.profile);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoad({
          status: "unavailable",
          profile: null as never,
          reason:
            e instanceof Error
              ? e.message
              : "Could not load the business profile.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update(patch: Partial<BusinessProfile>) {
    setProfile((p) => (p ? { ...p, ...patch } : p));
    setDirty(true);
    setSavedAt(null);
  }

  function updateAddress(patch: Partial<BusinessProfile["address"]>) {
    setProfile((p) => (p ? { ...p, address: { ...p.address, ...patch } } : p));
    setDirty(true);
    setSavedAt(null);
  }

  async function save() {
    if (!profile) return;
    setError("");
    if (!profile.legal_name.trim()) {
      setError("Enter the legal business name.");
      return;
    }
    if (profile.ein && !EIN_PATTERN.test(profile.ein.trim())) {
      setError("Enter the EIN as nine digits, for example 12-3456789.");
      return;
    }
    if (
      profile.accountant_email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.accountant_email.trim())
    ) {
      setError("Enter a valid accountant email address.");
      return;
    }
    if (isElection(profile) && !profile.tax_classification_since) {
      setError(
        `Enter the year the ${CLASSIFICATION_PHRASES[profile.tax_classification].replace(/^an? /, "")} election took effect.`,
      );
      return;
    }
    setSaving(true);
    try {
      const saved = await saveBusinessProfile(profile);
      setProfile(saved);
      setLoad({ status: "ready", profile: saved });
      setDirty(false);
      setSavedAt(Date.now());
      toast("success", "Business details saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const classOptions = profile
    ? classificationOptions(profile.entity_type)
    : [];
  const election = profile ? isElection(profile) : false;
  const defaultPhrase = profile
    ? CLASSIFICATION_PHRASES[defaultClassification(profile.entity_type)]
    : "";
  const yearOptions = election
    ? [
        ...(profile?.tax_classification_since
          ? []
          : [{ value: "", label: "Choose the year" }]),
        ...electionYears.map((y) => ({ value: String(y), label: String(y) })),
      ]
    : [{ value: "", label: "Applies to every year" }];
  // The estimator's state list carries tax rates in its labels; addresses do not need them.
  const stateOptions = [
    { value: "", label: "Select state" },
    ...STATE_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label.replace(/\s*\(.*\)\s*$/, ""),
    })),
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Building2 className="h-5 w-5 text-teal-light" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Business</h1>
            <p className="text-sm text-muted-foreground">
              One profile the tax estimator and the books both read
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            asChild
            size="sm"
            variant="secondary"
            className="gap-1 rounded-xl"
          >
            <Link href="/settings">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </Link>
          </Button>
          <HeaderControls />
        </div>
      </div>

      {!load || !profile ? (
        <div className="flex items-center justify-center py-16">
          <Loader2
            className="h-5 w-5 animate-spin text-muted-foreground"
            aria-label="Loading business profile"
          />
        </div>
      ) : (
        <>
          {load.status === "unavailable" && (
            <div
              role="status"
              className="glass-card rounded-xl border-warning/30 p-4 text-sm"
            >
              <p className="font-medium text-warning">Not available yet</p>
              <p className="mt-1 text-muted-foreground">{load.reason}</p>
            </div>
          )}
          {load.status === "empty" && (
            <div
              role="status"
              className="glass-card rounded-xl p-4 text-sm text-muted-foreground"
            >
              Nothing is saved yet. Fill in what you know; every field can be
              updated later.
            </div>
          )}

          <Section
            icon={Building2}
            title="Identity"
            description="How the business is registered. These appear on reports and the year-end package."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextInput
                label="Legal name"
                required
                value={profile.legal_name}
                onChange={(nextValue) => update({ legal_name: nextValue })}
                placeholder="Valiance Media LLC"
              />
              <TextInput
                label="Doing business as"
                value={profile.dba}
                onChange={(nextValue) => update({ dba: nextValue })}
                placeholder="Optional"
              />
              <Select
                label="Entity type"
                value={profile.entity_type}
                options={ENTITY_TYPE_OPTIONS}
                onChange={(v) => {
                  const entity = v as EntityType;
                  update({
                    entity_type: entity,
                    tax_classification: defaultClassification(entity),
                  });
                }}
              />
              <TextInput
                label="EIN"
                value={profile.ein}
                onChange={(nextValue) => update({ ein: nextValue })}
                placeholder="12-3456789"
                inputMode="numeric"
                autoComplete="off"
              />
              <DateInput
                label="Formation date"
                value={profile.formation_date ?? ""}
                onChange={(nextValue) =>
                  update({ formation_date: nextValue || null })
                }
              />
              <Select
                label="State of formation"
                value={profile.state_of_formation}
                options={stateOptions}
                onChange={(v) => update({ state_of_formation: v })}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextInput
                label="Address"
                value={profile.address.line1}
                onChange={(nextValue) => updateAddress({ line1: nextValue })}
                placeholder="Street"
                className="sm:col-span-2"
              />
              <TextInput
                aria-label="Address line 2"
                value={profile.address.line2}
                onChange={(nextValue) => updateAddress({ line2: nextValue })}
                placeholder="Suite, unit (optional)"
                className="sm:col-span-2"
              />
              <TextInput
                label="City"
                value={profile.address.city}
                onChange={(nextValue) => updateAddress({ city: nextValue })}
              />
              <div className="grid grid-cols-[1fr_120px] gap-4">
                <Select
                  label="State"
                  value={profile.address.state}
                  options={stateOptions}
                  onChange={(v) => updateAddress({ state: v })}
                />
                <TextInput
                  label="ZIP"
                  value={profile.address.postal_code}
                  onChange={(nextValue) =>
                    updateAddress({ postal_code: nextValue })
                  }
                  inputMode="numeric"
                />
              </div>
              <TextInput
                label="Phone"
                type="tel"
                value={profile.phone}
                onChange={(nextValue) => update({ phone: nextValue })}
              />
              <TextInput
                label="Business email"
                type="email"
                value={profile.email}
                onChange={(nextValue) => update({ email: nextValue })}
              />
            </div>
          </Section>

          <Section
            icon={Landmark}
            title="Tax profile"
            description="How the business is taxed. The estimator and the books apply an election from its start year; earlier years use the entity's default."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Tax classification"
                value={profile.tax_classification}
                options={classOptions}
                disabled={classOptions.length <= 1}
                onChange={(v) => {
                  const next = v as ProfileClassification;
                  update({
                    tax_classification: next,
                    // The entity's own default has no start year.
                    ...(next === defaultClassification(profile.entity_type)
                      ? { tax_classification_since: null }
                      : {}),
                  });
                }}
              />
              <Select
                label="In effect since tax year"
                value={
                  profile.tax_classification_since
                    ? String(profile.tax_classification_since)
                    : ""
                }
                options={yearOptions}
                disabled={!election}
                onChange={(v) =>
                  update({ tax_classification_since: v ? Number(v) : null })
                }
                helperText={
                  election
                    ? `Years before this are taxed as ${defaultPhrase}.`
                    : "Nothing was elected, so this applies to every year."
                }
              />
              <Select
                label="Home state for taxes"
                value={profile.home_state}
                options={stateOptions}
                onChange={(v) => update({ home_state: v })}
              />
              <div className="flex items-end pb-2">
                <Toggle
                  checked={profile.is_sstb}
                  onChange={(v) => update({ is_sstb: v })}
                  label="Specified service business (limits the QBI deduction)"
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Currently:{" "}
              <span className="text-foreground">
                {describeTaxProfile(profile)}
              </span>
            </p>
          </Section>

          <Section
            icon={BookOpen}
            title="Books"
            description="Settings the accounting ledger reads once. Change them before importing history."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Select
                label="Fiscal year starts in"
                value={String(profile.fiscal_year_start_month)}
                options={MONTH_OPTIONS}
                onChange={(v) => update({ fiscal_year_start_month: Number(v) })}
              />
              <Select
                label="Books timezone"
                value={profile.books_timezone}
                options={TIMEZONE_OPTIONS}
                onChange={(v) => update({ books_timezone: v })}
                helperText="Dates bank transactions post on."
              />
              <DateInput
                label="Books start on"
                value={profile.earliest_history_date ?? ""}
                onChange={(nextValue) =>
                  update({ earliest_history_date: nextValue || null })
                }
              />
            </div>
          </Section>

          <Section
            icon={Users}
            title="People"
            description="Who signs and who prepares. Used on reports and when sharing the year-end package."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextInput
                label="Owner name"
                value={profile.owner_name}
                onChange={(nextValue) => update({ owner_name: nextValue })}
              />
              <TextInput
                label="Owner title"
                value={profile.owner_title}
                onChange={(nextValue) => update({ owner_title: nextValue })}
                placeholder="Owner"
              />
              <TextInput
                label="Accountant name"
                value={profile.accountant_name}
                onChange={(nextValue) => update({ accountant_name: nextValue })}
                placeholder="Optional"
              />
              <TextInput
                label="Accountant email"
                type="email"
                value={profile.accountant_email}
                onChange={(nextValue) =>
                  update({ accountant_email: nextValue })
                }
                placeholder="Optional"
              />
            </div>
          </Section>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-error/20 bg-error/5 p-3 text-sm text-error"
            >
              {error}
            </p>
          )}

          <div
            className={cn(
              "sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-xl px-4 py-3",
              "glass-strong border border-border shadow-[var(--shadow-card)]",
            )}
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {dirty ? (
                <Badge variant="warning" dot>
                  Unsaved changes
                </Badge>
              ) : savedAt ? (
                <span className="flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Saved
                </span>
              ) : profile.updated_at ? (
                <span>
                  Last saved {new Date(profile.updated_at).toLocaleDateString()}
                </span>
              ) : null}
            </div>
            <Button
              onClick={() => void save()}
              disabled={saving || !dirty || load.status === "unavailable"}
              loading={saving}
            >
              Save business details
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
