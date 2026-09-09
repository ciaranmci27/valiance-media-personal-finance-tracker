"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { Select } from "@/components/ui/inputs/Select";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { recordConfigChange } from "@/lib/payroll/audit";
import { STATE_OPTIONS } from "@/lib/tax/state-taxes";
import type { PayrollAddress } from "@/types/payroll";

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// Component
// ============================================================================

interface PayrollSetupCardProps {
  /** Called after the organization row is created. */
  onComplete?: () => void;
}

export function PayrollSetupCard({ onComplete }: PayrollSetupCardProps) {
  const router = useRouter();

  const [legalName, setLegalName] = React.useState("");
  const [fein, setFein] = React.useState("");
  const [address, setAddress] = React.useState<PayrollAddress>({
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
  });
  const [signerName, setSignerName] = React.useState("");
  const [signerTitle, setSignerTitle] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");

  const [saving, setSaving] = React.useState(false);

  const updateAddress = (patch: Partial<PayrollAddress>) =>
    setAddress((prev) => ({ ...prev, ...patch }));

  const validate = (): string | null => {
    if (!legalName.trim()) return "Legal name is required";
    if (!isValidFein(fein)) return "EIN must be in the format XX-XXXXXXX";
    if (!signerName.trim()) return "Signer name is required";
    if (
      !address.line1.trim() ||
      !address.city.trim() ||
      !address.state ||
      !address.zip.trim()
    ) {
      return "Complete mailing address is required";
    }
    if (!isValidZip(address.zip)) {
      return "ZIP code must be 5 digits (or 9 with a dash)";
    }
    if (email && !isValidEmail(email)) {
      return "Contact email is not a valid email address";
    }
    return null;
  };

  const buildOrgPayload = () => ({
    legal_name: legalName.trim(),
    fein,
    state_tax_id: null,
    state_ui_id: null,
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
    accountant_email: null,
  });

  const handleFinish = async () => {
    const err = validate();
    if (err) {
      toast("error", err);
      return;
    }

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not persisted");
      onComplete?.();
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const payload = buildOrgPayload();

      const { data, error } = await supabase
        .from("organization_config")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;

      await recordConfigChange(supabase, {
        configType: "organization",
        configId: data.id,
        oldValues: null,
        newValues: payload as unknown as Record<string, unknown>,
        summary: "Created organization profile via onboarding wizard",
      });

      toast("success", "Payroll is ready to go.");
      router.refresh();
      onComplete?.();
    } catch (err) {
      console.error("[payroll-setup] save failed:", err);
      toast("error", "Failed to save organization");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-full max-w-2xl mx-auto animate-fade-up space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Building2
                className="h-6 w-6 text-teal-light"
                aria-hidden="true"
              />
            </div>
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            Set Up Payroll
          </h2>
          <p className="text-sm text-muted-foreground">
            Tell us about your business. This appears on pay stubs, 941s, and
            W-2s.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-teal-light font-semibold">
            <Check className="h-3 w-3" aria-hidden="true" />
          </span>
          <span>Encryption key</span>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold">
            2
          </span>
          <span className="font-medium text-foreground">Organization</span>
        </div>

        {/* Legal Entity */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Legal Entity
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="glass-card rounded-xl p-5 space-y-4">
            <TextInput
              label="Legal Name"
              value={legalName}
              onChange={(nextValue) => setLegalName(nextValue)}
              placeholder="Your S Corp, Inc."
              required
            />
            <TextInput
              label="EIN"
              value={fein}
              onChange={(nextValue) => setFein(formatFein(nextValue))}
              placeholder="12-3456789"
              inputMode="numeric"
              required
            />
          </div>
        </div>

        {/* Mailing Address */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Mailing Address
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="glass-card rounded-xl p-5 space-y-4">
            <TextInput
              label="Address Line 1"
              value={address.line1}
              onChange={(nextValue) => updateAddress({ line1: nextValue })}
              placeholder="123 Main St"
              required
            />
            <TextInput
              label="Address Line 2"
              value={address.line2 ?? ""}
              onChange={(nextValue) => updateAddress({ line2: nextValue })}
              placeholder="Suite 400 (optional)"
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <TextInput
                label="City"
                value={address.city}
                onChange={(nextValue) => updateAddress({ city: nextValue })}
                placeholder="Phoenix"
                required
              />
              <Select
                label="State"
                value={address.state}
                onChange={(val) => updateAddress({ state: val })}
                options={STATE_OPTIONS}
                placeholder="Select state"
                required
              />
              <TextInput
                label="ZIP"
                value={address.zip}
                onChange={(nextValue) => updateAddress({ zip: nextValue })}
                placeholder="85001"
                inputMode="numeric"
                required
              />
            </div>
          </div>
        </div>

        {/* Authorized Signer */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Authorized Signer
            </h2>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="glass-card rounded-xl p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextInput
                label="Signer Name"
                value={signerName}
                onChange={(nextValue) => setSignerName(nextValue)}
                placeholder="Jane Doe"
                required
              />
              <TextInput
                label="Title (optional)"
                value={signerTitle}
                onChange={(nextValue) => setSignerTitle(nextValue)}
                placeholder="President"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TextInput
                label="Phone (optional)"
                value={phone}
                onChange={(nextValue) => setPhone(nextValue)}
                placeholder="(555) 555-5555"
                type="tel"
              />
              <TextInput
                label="Email (optional)"
                value={email}
                onChange={(nextValue) => setEmail(nextValue)}
                placeholder="signer@example.com"
                type="email"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleFinish} disabled={saving}>
            {saving ? (
              <Loader2
                className="h-4 w-4 animate-spin mr-2"
                aria-hidden="true"
              />
            ) : null}
            Finish Setup
            {!saving && (
              <ChevronRight className="h-4 w-4 ml-1" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
