"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { recordConfigChange } from "@/lib/payroll/audit";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import type {
  FederalDepositSchedule,
  OrganizationConfig,
  PayrollAddress,
  StateDepositSchedule,
} from "@/types/payroll";

const FEDERAL_SCHEDULE_OPTIONS: { value: FederalDepositSchedule; label: string }[] = [
  { value: "monthly", label: "Monthly (default for small employers)" },
  { value: "semiweekly", label: "Semiweekly (>$50k lookback liability)" },
];

const STATE_SCHEDULE_OPTIONS: { value: StateDepositSchedule; label: string }[] = [
  { value: "quarterly", label: "Quarterly (<$500/quarter withholding)" },
  { value: "monthly", label: "Monthly ($500-$1,500/quarter)" },
  { value: "semiweekly", label: "Semiweekly (>$1,500/quarter)" },
];

interface Props {
  initial: OrganizationConfig | null;
}

function formatFein(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 9);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

function isValidFein(fein: string): boolean {
  return /^\d{2}-\d{7}$/.test(fein);
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidZip(zip: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(zip);
}

function toAddress(value: unknown): PayrollAddress {
  const a = (value && typeof value === "object" ? value : {}) as Partial<PayrollAddress>;
  return {
    line1: a.line1 ?? "",
    line2: a.line2 ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    zip: a.zip ?? "",
  };
}

export function OrganizationEditorContent({ initial }: Props) {
  const router = useRouter();
  const supabase = React.useMemo(() => createClient(), []);

  const isEditing = initial !== null;

  const [legalName, setLegalName] = React.useState(initial?.legal_name ?? "");
  const [fein, setFein] = React.useState(initial?.fein ?? "");
  const [stateTaxId, setStateTaxId] = React.useState(initial?.state_tax_id ?? "");
  const [stateUiId, setStateUiId] = React.useState(initial?.state_ui_id ?? "");
  const [address, setAddress] = React.useState<PayrollAddress>(toAddress(initial?.address));
  const [signerName, setSignerName] = React.useState(initial?.signer_name ?? "");
  const [signerTitle, setSignerTitle] = React.useState(initial?.signer_title ?? "");
  const [phone, setPhone] = React.useState(initial?.phone ?? "");
  const [email, setEmail] = React.useState(initial?.email ?? "");
  const [accountantEmail, setAccountantEmail] = React.useState(initial?.accountant_email ?? "");
  const [federalSchedule, setFederalSchedule] = React.useState<FederalDepositSchedule>(
    initial?.federal_deposit_schedule ?? "monthly",
  );
  const [stateSchedule, setStateSchedule] = React.useState<StateDepositSchedule>(
    initial?.state_deposit_schedule ?? "monthly",
  );

  const [saving, setSaving] = React.useState(false);

  const updateAddress = (patch: Partial<PayrollAddress>) =>
    setAddress((prev) => ({ ...prev, ...patch }));

  const validate = (): string | null => {
    if (!legalName.trim()) return "Legal name is required";
    if (!isValidFein(fein)) return "EIN must be 9 digits in the format XX-XXXXXXX";
    if (!signerName.trim()) return "Signer name is required";
    if (!address.line1.trim() || !address.city.trim() || !address.state || !address.zip.trim()) {
      return "Complete mailing address is required";
    }
    if (!isValidZip(address.zip)) return "ZIP code must be 5 digits (or 9 with dash)";
    if (email && !isValidEmail(email)) return "Contact email is not a valid email address";
    if (accountantEmail && !isValidEmail(accountantEmail)) {
      return "Accountant email is not a valid email address";
    }
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) {
      toast("error", error);
      return;
    }

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not persisted");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        legal_name: legalName.trim(),
        fein,
        state_tax_id: stateTaxId.trim() || null,
        state_ui_id: stateUiId.trim() || null,
        address: {
          line1: address.line1.trim(),
          line2: address.line2?.trim() || undefined,
          city: address.city.trim(),
          state: address.state,
          zip: address.zip.trim(),
        },
        signer_name: signerName.trim(),
        signer_title: signerTitle.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        accountant_email: accountantEmail.trim() || null,
        federal_deposit_schedule: federalSchedule,
        state_deposit_schedule: stateSchedule,
      };

      let rowId: string;
      let oldValues: Record<string, unknown> | null = null;

      if (initial) {
        oldValues = { ...initial } as unknown as Record<string, unknown>;
        const { error: updateError } = await supabase
          .from("organization_config")
          .update(payload)
          .eq("id", initial.id);
        if (updateError) throw updateError;
        rowId = initial.id;
      } else {
        const { data, error: insertError } = await supabase
          .from("organization_config")
          .insert(payload)
          .select("id")
          .single();
        if (insertError) throw insertError;
        rowId = data.id;
      }

      await recordConfigChange(supabase, {
        configType: "organization",
        configId: rowId,
        oldValues,
        newValues: payload as unknown as Record<string, unknown>,
        summary: initial ? "Updated organization details" : "Created organization profile",
      });

      toast("success", initial ? "Organization updated" : "Organization saved");
      router.refresh();
    } catch (err) {
      console.error("[organization-editor] save failed:", err);
      toast("error", "Failed to save organization");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Building2 className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Organization</h1>
            <p className="text-sm text-muted-foreground">
              Legal entity details used on tax forms and pay stubs
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Legal Entity
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <Input
            label="Legal Name"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            placeholder="Your S Corp, Inc."
            required
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="EIN"
              value={fein}
              onChange={(e) => setFein(formatFein(e.target.value))}
              placeholder="12-3456789"
              inputMode="numeric"
              required
            />
            <Input
              label="State Tax ID"
              value={stateTaxId}
              onChange={(e) => setStateTaxId(e.target.value)}
              placeholder="Optional"
            />
            <Input
              label="State UI ID"
              value={stateUiId}
              onChange={(e) => setStateUiId(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Mailing Address
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <Input
            label="Address Line 1"
            value={address.line1}
            onChange={(e) => updateAddress({ line1: e.target.value })}
            placeholder="123 Main St"
            required
          />
          <Input
            label="Address Line 2"
            value={address.line2 ?? ""}
            onChange={(e) => updateAddress({ line2: e.target.value })}
            placeholder="Suite 400 (optional)"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="City"
              value={address.city}
              onChange={(e) => updateAddress({ city: e.target.value })}
              placeholder="Phoenix"
              required
            />
            <CustomSelect
              label="State"
              value={address.state}
              onChange={(val) => updateAddress({ state: val })}
              options={STATE_OPTIONS}
              placeholder="Select state"
              required
            />
            <Input
              label="ZIP"
              value={address.zip}
              onChange={(e) => updateAddress({ zip: e.target.value })}
              placeholder="85001"
              inputMode="numeric"
              required
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Authorized Signer
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Signer Name"
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="Jane Doe"
              required
            />
            <Input
              label="Title"
              value={signerTitle}
              onChange={(e) => setSignerTitle(e.target.value)}
              placeholder="President"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 555-5555"
              type="tel"
            />
            <Input
              label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="signer@example.com"
              type="email"
            />
          </div>
          <Input
            label="Accountant Email (optional)"
            value={accountantEmail}
            onChange={(e) => setAccountantEmail(e.target.value)}
            placeholder="accountant@example.com"
            type="email"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Tax Deposit Schedule
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            Determines when Form 941 and state withholding deposits are due.
            Federal schedule is set annually by the IRS based on your lookback-period
            liability. State schedule (Arizona) is based on quarterly withholding
            thresholds published with Form A1-WP. Confirm both with your accountant
            before approving pay runs.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CustomSelect
              label="Federal (IRS 941)"
              value={federalSchedule}
              onChange={(val) => setFederalSchedule(val as FederalDepositSchedule)}
              options={FEDERAL_SCHEDULE_OPTIONS}
            />
            <CustomSelect
              label="State withholding"
              value={stateSchedule}
              onChange={(val) => setStateSchedule(val as StateDepositSchedule)}
              options={STATE_SCHEDULE_OPTIONS}
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />}
          {isEditing ? "Save Changes" : "Save Organization"}
        </Button>
      </div>
    </div>
  );
}
