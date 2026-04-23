"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Map as MapIcon, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { CustomSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import { recordConfigChange } from "@/lib/payroll/audit";
import {
  formatZodError,
  parseStateTaxConfigWrite,
} from "@/lib/payroll/schemas";
import {
  CALCULATION_METHOD_LABELS,
  type CalculationMethod,
  type StateConfigPayload,
  type StateConfigFlat,
  type StateConfigFlatEmployeeElected,
  type StateConfigProgressive,
  type StateSdiConfig,
  type StateSutaConfig,
  type StatePaymentPortal,
  type StatePaymentPortals,
  type StateTaxConfig,
} from "@/types/payroll";

interface Props {
  stateCode: string;
  year: number;
  initial: StateTaxConfig | null;
  /** Most recent prior year's config for the same state. Used to prefill
   *  stable fields (payment portals, calculation method + config shape, SDI,
   *  SUTA) when creating a fresh year, so the admin doesn't retype URLs,
   *  steps, and rates that rarely change. Ignored when `initial` is set. */
  prefillSource?: StateTaxConfig | null;
}

const METHOD_OPTIONS: { value: CalculationMethod; label: string }[] = (
  Object.keys(CALCULATION_METHOD_LABELS) as CalculationMethod[]
).map((m) => ({
  value: m,
  label: CALCULATION_METHOD_LABELS[m],
}));

// Deterministic JSON: sort object keys recursively so version_hash is stable
// regardless of insertion order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

async function computeVersionHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(payload));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Avoid caret-jumping: show the user's typed value without forced trailing zeros.
function toPercentDisplay(decimal: number | null | undefined): string {
  if (decimal == null || !Number.isFinite(decimal)) return "";
  return String(Number((decimal * 100).toFixed(4)));
}

function configHasContent(cfg: StateConfigPayload): boolean {
  if (!cfg) return false;
  const keys = Object.keys(cfg);
  if (keys.length === 0) return false;
  // A zeroed/empty default config shouldn't trigger the confirmation.
  return keys.some((k) => {
    const v = (cfg as Record<string, unknown>)[k];
    if (v == null) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return Boolean(v);
  });
}

function asFlat(cfg: StateConfigPayload): StateConfigFlat {
  const c = cfg as Partial<StateConfigFlat>;
  return { rate: c.rate ?? 0, form: c.form, notes: c.notes };
}

function asFlatElected(
  cfg: StateConfigPayload
): StateConfigFlatEmployeeElected {
  const c = cfg as Partial<StateConfigFlatEmployeeElected>;
  return {
    actualTaxRate: c.actualTaxRate ?? 0,
    rates: c.rates ?? [],
    defaultRate: c.defaultRate ?? 0,
    form: c.form,
    notes: c.notes,
  };
}

function asProgressive(cfg: StateConfigPayload): StateConfigProgressive {
  const c = cfg as Partial<StateConfigProgressive>;
  return {
    period: c.period ?? "annual",
    brackets: c.brackets ?? { single: [] },
    std_deduction: c.std_deduction,
    form: c.form,
    notes: c.notes,
  };
}

export function StateYearEditorContent({
  stateCode,
  year,
  initial,
  prefillSource,
}: Props) {
  const router = useRouter();
  const supabase = React.useMemo(() => createClient(), []);

  // Create mode: if a prior year's config exists for this state, prefill the
  // fields that don't typically change year to year. The admin can still
  // override any value before saving. Edit mode (`initial` set) always wins.
  const seed = initial ?? prefillSource ?? null;
  const isPrefilled = !initial && !!prefillSource;

  const [method, setMethod] = React.useState<CalculationMethod>(
    seed?.calculation_method ?? "none",
  );
  const [config, setConfig] = React.useState<StateConfigPayload>(
    seed?.config ?? {},
  );
  const [sdi, setSdi] = React.useState<StateSdiConfig>(
    (seed?.sdi_config as StateSdiConfig) ?? {},
  );
  const [suta, setSuta] = React.useState<StateSutaConfig>(
    (seed?.suta_config as StateSutaConfig) ?? {},
  );
  const [portals, setPortals] = React.useState<StatePaymentPortals>(
    (seed?.payment_portals as StatePaymentPortals) ?? {},
  );
  // Notes are year-specific (usually describe the year's changes), so don't
  // carry them forward even in create-with-prefill mode.
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [saving, setSaving] = React.useState(false);

  // For chip input on flat_employee_elected
  const [newRate, setNewRate] = React.useState("");

  // Pending method change awaiting confirmation (only when existing config would be dropped).
  const [pendingMethod, setPendingMethod] = React.useState<CalculationMethod | null>(null);

  const applyMethodChange = React.useCallback((next: CalculationMethod) => {
    setMethod(next);
    switch (next) {
      case "flat":
        setConfig({ rate: 0 } satisfies StateConfigFlat);
        break;
      case "flat_employee_elected":
        setConfig({
          actualTaxRate: 0,
          rates: [],
          defaultRate: 0,
        } satisfies StateConfigFlatEmployeeElected);
        break;
      case "progressive":
        setConfig({
          period: "annual",
          brackets: { single: [] },
        } satisfies StateConfigProgressive);
        break;
      case "custom":
      case "none":
      default:
        setConfig({});
        break;
    }
  }, []);

  const handleMethodChange = (val: string) => {
    const next = val as CalculationMethod;
    if (next === method) return;
    if (configHasContent(config)) {
      setPendingMethod(next);
      return;
    }
    applyMethodChange(next);
  };

  const handleAddElectedRate = () => {
    const pct = Number(newRate);
    if (!Number.isFinite(pct) || pct <= 0) {
      toast("error", "Enter a positive percentage");
      return;
    }
    const rate = pct / 100;
    const current = asFlatElected(config);
    if (current.rates.includes(rate)) {
      toast("info", "Rate already in the list");
      return;
    }
    const updated = [...current.rates, rate].sort((a, b) => a - b);
    setConfig({ ...current, rates: updated });
    setNewRate("");
  };

  const handleRemoveElectedRate = (rate: number) => {
    const current = asFlatElected(config);
    setConfig({ ...current, rates: current.rates.filter((r) => r !== rate) });
  };

  const handleSave = async () => {
    const candidate = {
      state_code: stateCode,
      tax_year: year,
      calculation_method: method,
      config,
      sdi_config: sdi,
      suta_config: suta,
      payment_portals: portals,
      notes: notes.trim() || null,
    };
    const parsed = parseStateTaxConfigWrite(candidate);
    if (!parsed.success) {
      toast("error", formatZodError(parsed.error));
      return;
    }

    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not persisted");
      return;
    }

    setSaving(true);
    try {
      const fingerprint = { method, config, sdi, suta, portals };
      const version_hash = await computeVersionHash(fingerprint);

      const payload = {
        ...candidate,
        version_hash,
      };

      let rowId: string;
      let oldValues: Record<string, unknown> | null = null;

      if (initial) {
        oldValues = { ...initial } as unknown as Record<string, unknown>;
        const { error } = await supabase
          .from("state_tax_configs")
          .update(payload)
          .eq("id", initial.id);
        if (error) throw error;
        rowId = initial.id;
      } else {
        const { data, error } = await supabase
          .from("state_tax_configs")
          .insert(payload)
          .select("id")
          .single();
        if (error) throw error;
        rowId = data.id;
      }

      await recordConfigChange(supabase, {
        configType: "state",
        configId: rowId,
        oldValues,
        newValues: payload as unknown as Record<string, unknown>,
        summary: initial
          ? `Updated ${stateCode} config for ${year}`
          : `Created ${stateCode} config for ${year}`,
      });

      toast("success", `Saved ${stateCode} ${year} config`);
      router.push("/payroll/config/states");
      router.refresh();
    } catch (err) {
      console.error("[state-editor] save failed:", err);
      toast("error", "Failed to save state config");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
            <MapIcon className="h-5 w-5 text-violet-500" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">
              {stateCode} · {year}
            </h1>
            <p className="text-sm text-muted-foreground">
              State income tax, SDI, and SUTA configuration
            </p>
          </div>
        </div>
      </div>

      {isPrefilled && prefillSource && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm flex items-start gap-2">
          <span className="text-primary font-medium shrink-0">Prefilled.</span>
          <span className="text-muted-foreground">
            Copied the calculation method, SDI / SUTA, and payment portals
            from{" "}
            <span className="text-foreground font-medium">
              {stateCode} {prefillSource.tax_year}
            </span>
            . Review each section and adjust any values that changed this
            year (SUTA rate and wage base are the most common).
          </span>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Calculation Method
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <CustomSelect
            label="Method"
            value={method}
            onChange={handleMethodChange}
            options={METHOD_OPTIONS}
          />

          {method === "flat" && <FlatEditor config={asFlat(config)} setConfig={setConfig} />}
          {method === "flat_employee_elected" && (
            <FlatElectedEditor
              config={asFlatElected(config)}
              setConfig={setConfig}
              newRate={newRate}
              setNewRate={setNewRate}
              onAddRate={handleAddElectedRate}
              onRemoveRate={handleRemoveElectedRate}
            />
          )}
          {method === "progressive" && (
            <ProgressiveEditor
              config={asProgressive(config)}
              setConfig={setConfig}
            />
          )}
          {method === "custom" && (
            <CustomEditor config={config} setConfig={setConfig} />
          )}
          {method === "none" && (
            <p className="text-sm text-muted-foreground">
              This state has no income tax withholding. Leave the rest blank
              unless SDI or SUTA applies.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            SDI (State Disability Insurance)
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <p className="text-xs text-muted-foreground">
            Leave blank if the state has no SDI (e.g. AZ).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <NumberInput
              label="Rate (%)"
              value={toPercentDisplay(sdi.rate)}
              onChange={(e) =>
                setSdi({
                  ...sdi,
                  rate:
                    e.target.value === ""
                      ? undefined
                      : Number(e.target.value) / 100,
                })
              }
              placeholder="0.00"
            />
            <NumberInput
              label="Wage Base ($)"
              value={sdi.wage_base ?? ""}
              onChange={(e) =>
                setSdi({
                  ...sdi,
                  wage_base:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              integer
              placeholder="0"
            />
            <CustomSelect
              label="Side"
              value={sdi.side ?? ""}
              onChange={(val) =>
                setSdi({
                  ...sdi,
                  side: (val as StateSdiConfig["side"]) || undefined,
                })
              }
              options={[
                { value: "", label: "Not applicable" },
                { value: "employee", label: "Employee" },
                { value: "employer", label: "Employer" },
                { value: "both", label: "Both" },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            SUTA (State Unemployment)
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput
              label="New Employer Rate (%)"
              value={toPercentDisplay(suta.newEmployerRate)}
              onChange={(e) =>
                setSuta({
                  ...suta,
                  newEmployerRate:
                    e.target.value === ""
                      ? undefined
                      : Number(e.target.value) / 100,
                })
              }
              placeholder="2.0"
            />
            <NumberInput
              label="Wage Base ($)"
              value={suta.wageBase ?? ""}
              onChange={(e) =>
                setSuta({
                  ...suta,
                  wageBase:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              integer
              placeholder="8000"
            />
            <NumberInput
              label="Rate Range Min (%)"
              value={toPercentDisplay(suta.rangeMin)}
              onChange={(e) =>
                setSuta({
                  ...suta,
                  rangeMin:
                    e.target.value === ""
                      ? undefined
                      : Number(e.target.value) / 100,
                })
              }
              placeholder="0.04"
            />
            <NumberInput
              label="Rate Range Max (%)"
              value={toPercentDisplay(suta.rangeMax)}
              onChange={(e) =>
                setSuta({
                  ...suta,
                  rangeMax:
                    e.target.value === ""
                      ? undefined
                      : Number(e.target.value) / 100,
                })
              }
              placeholder="11.05"
            />
          </div>
          <Input
            label="Forms Due (comma-separated)"
            value={(suta.formsDue ?? []).join(", ")}
            onChange={(e) =>
              setSuta({
                ...suta,
                formsDue: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="A-1-QRT quarterly, A-1-APR annual"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Payment Portals
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6 space-y-6">
          <p className="text-xs text-muted-foreground">
            Portal URL, agency, form code, and step-by-step instructions for
            each state deposit type. Drives the &ldquo;Pay at [portal]&rdquo;
            links and walkthroughs on the deposits page. Federal 941 / 940
            deposits always go to EFTPS and are not configured here.
          </p>

          <PortalEditor
            title="State Withholding"
            description="Where to pay state income tax withheld from employees."
            portal={portals.state_withholding ?? null}
            onChange={(p) =>
              setPortals({ ...portals, state_withholding: p })
            }
          />

          <PortalEditor
            title="SUTA (State Unemployment)"
            description="Where to file and pay state unemployment quarterly."
            portal={portals.state_suta ?? null}
            onChange={(p) => setPortals({ ...portals, state_suta: p })}
          />

          {(sdi.rate ?? 0) > 0 && (
            <PortalEditor
              title="SDI (State Disability Insurance)"
              description="Only needed if this state has an SDI program."
              portal={portals.state_sdi ?? null}
              onChange={(p) => setPortals({ ...portals, state_sdi: p })}
            />
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Notes
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>
        <div className="glass-card rounded-xl p-6">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. AZ 2026 values unchanged from 2025."
            rows={3}
          />
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" aria-hidden="true" />}
          {initial ? "Save Changes" : `Create ${stateCode} ${year} Config`}
        </Button>
      </div>

      <ConfirmationDialog
        open={pendingMethod !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMethod(null);
        }}
        onConfirm={() => {
          if (pendingMethod) applyMethodChange(pendingMethod);
          setPendingMethod(null);
        }}
        title="Change calculation method?"
        description="Switching the calculation method will clear the current configuration. SDI, SUTA, and notes are kept."
        confirmLabel="Change method"
        variant="warning"
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Payment portal sub-editor
// ----------------------------------------------------------------------------

function PortalEditor({
  title,
  description,
  portal,
  onChange,
}: {
  title: string;
  description: string;
  portal: StatePaymentPortal | null;
  onChange: (next: StatePaymentPortal | null) => void;
}) {
  const enabled = portal !== null;
  const value: StatePaymentPortal = portal ?? {
    portal: "",
    agency: "",
    url: "",
    form: "",
    steps: [],
  };
  const updateField = <K extends keyof StatePaymentPortal>(
    key: K,
    v: StatePaymentPortal[K],
  ) => {
    onChange({ ...value, [key]: v });
  };
  return (
    <div className="space-y-3 pb-5 border-b border-border/50 last:border-b-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-muted-foreground">
            {enabled ? "Configured" : "Disabled"}
          </label>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() =>
              onChange(
                enabled
                  ? null
                  : {
                      portal: "",
                      agency: "",
                      url: "",
                      form: "",
                      steps: [],
                    },
              )
            }
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              enabled ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 rounded-full bg-background transition-transform mt-0.5",
                enabled ? "translate-x-4 ml-0.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>

      {enabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Portal name"
              value={value.portal}
              onChange={(e) => updateField("portal", e.target.value)}
              placeholder="AZTaxes"
            />
            <Input
              label="Form code"
              value={value.form}
              onChange={(e) => updateField("form", e.target.value)}
              placeholder="A1-WP"
            />
          </div>
          <Input
            label="Agency"
            value={value.agency}
            onChange={(e) => updateField("agency", e.target.value)}
            placeholder="Arizona Department of Revenue"
          />
          <Input
            label="URL"
            value={value.url}
            onChange={(e) => updateField("url", e.target.value)}
            placeholder="https://www.aztaxes.gov/"
          />
          <Textarea
            label="Step-by-step instructions (one per line)"
            value={value.steps.join("\n")}
            onChange={(e) =>
              updateField(
                "steps",
                e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            rows={5}
            placeholder={
              "Log in to AZTaxes.gov\nSelect Withholding Tax, then Make a Payment\nChoose form A1-WP\n..."
            }
          />
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Method-specific sub-editors
// ----------------------------------------------------------------------------

function FlatEditor({
  config,
  setConfig,
}: {
  config: StateConfigFlat;
  setConfig: (c: StateConfigPayload) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <NumberInput
        label="Flat Rate (%)"
        value={toPercentDisplay(config.rate)}
        onChange={(e) =>
          setConfig({ ...config, rate: Number(e.target.value) / 100 })
        }
        placeholder="0.00"
      />
      <Input
        label="Form"
        value={config.form ?? ""}
        onChange={(e) => setConfig({ ...config, form: e.target.value })}
        placeholder="e.g. W-4 equivalent"
      />
    </div>
  );
}

function FlatElectedEditor({
  config,
  setConfig,
  newRate,
  setNewRate,
  onAddRate,
  onRemoveRate,
}: {
  config: StateConfigFlatEmployeeElected;
  setConfig: (c: StateConfigPayload) => void;
  newRate: string;
  setNewRate: (val: string) => void;
  onAddRate: () => void;
  onRemoveRate: (rate: number) => void;
}) {
  // Keys use fixed precision to avoid float-repr drift when matching rate back.
  const rateKey = (r: number) => r.toFixed(6);
  const defaultRateOptions = config.rates.map((r) => ({
    value: rateKey(r),
    label: `${(r * 100).toFixed(2)}%`,
  }));
  const currentDefaultKey = config.rates.includes(config.defaultRate)
    ? rateKey(config.defaultRate)
    : "";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <NumberInput
          label="Actual Tax Rate (%)"
          value={toPercentDisplay(config.actualTaxRate)}
          onChange={(e) =>
            setConfig({
              ...config,
              actualTaxRate: Number(e.target.value) / 100,
            })
          }
          placeholder="0.00"
        />
        <Input
          label="Form"
          value={config.form ?? ""}
          onChange={(e) => setConfig({ ...config, form: e.target.value })}
          placeholder="e.g. A-4"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Allowed Rates
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          {config.rates.map((r) => (
            <span
              key={r}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg",
                "bg-primary/10 text-primary text-sm font-medium"
              )}
            >
              {(r * 100).toFixed(2)}%
              <button
                type="button"
                onClick={() => onRemoveRate(r)}
                className="text-primary/70 hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
                aria-label={`Remove ${(r * 100).toFixed(2)}% rate`}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-2">
          <NumberInput
            value={newRate}
            onChange={(e) => setNewRate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddRate();
            }}
            placeholder="e.g. 2.5"
            className="h-9 w-32 text-sm"
          />
          <Button size="sm" variant="ghost" onClick={onAddRate}>
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Add Rate
          </Button>
        </div>
      </div>

      <CustomSelect
        label="Default Rate"
        value={currentDefaultKey}
        onChange={(val) => {
          const match = config.rates.find((r) => rateKey(r) === val);
          if (match != null) setConfig({ ...config, defaultRate: match });
        }}
        options={defaultRateOptions}
        placeholder="Select a rate"
        size="sm"
      />
    </div>
  );
}

function ProgressiveEditor({
  config,
  setConfig,
}: {
  config: StateConfigProgressive;
  setConfig: (c: StateConfigPayload) => void;
}) {
  const rows = config.brackets.single ?? [];

  const update = (idx: number, patch: Partial<(typeof rows)[number]>) => {
    const next = [...rows];
    next[idx] = { ...next[idx], ...patch };
    setConfig({
      ...config,
      brackets: { ...config.brackets, single: next },
    });
  };

  const add = () => {
    const last = rows[rows.length - 1];
    setConfig({
      ...config,
      brackets: {
        ...config.brackets,
        single: [
          ...rows,
          { min: last?.max ?? 0, max: null, rate: 0, base_tax: 0 },
        ],
      },
    });
  };

  const remove = (idx: number) => {
    setConfig({
      ...config,
      brackets: {
        ...config.brackets,
        single: rows.filter((_, i) => i !== idx),
      },
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Single-filer bracket table. Multi-status brackets can be added post-v1.
      </p>
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Min ($)</span>
          <span>Max ($)</span>
          <span>Rate (%)</span>
          <span>Base Tax ($)</span>
          <span className="w-8" />
        </div>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground italic px-2 py-3">
            No brackets yet. Click &quot;Add Row&quot; to begin.
          </div>
        ) : (
          rows.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-center"
            >
              <NumberInput
                value={row.min}
                onChange={(e) =>
                  update(idx, { min: Number(e.target.value) })
                }
                placeholder="0.00"
                className="h-9 text-sm"
              />
              <NumberInput
                value={row.max ?? ""}
                onChange={(e) =>
                  update(idx, {
                    max:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                placeholder="no cap"
                className="h-9 text-sm"
              />
              <NumberInput
                value={toPercentDisplay(row.rate)}
                onChange={(e) =>
                  update(idx, { rate: Number(e.target.value) / 100 })
                }
                placeholder="0.00"
                className="h-9 text-sm"
              />
              <NumberInput
                value={row.base_tax}
                onChange={(e) =>
                  update(idx, { base_tax: Number(e.target.value) })
                }
                placeholder="0.00"
                className="h-9 text-sm"
              />
              <button
                type="button"
                onClick={() => remove(idx)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground/60 hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label={`Remove row ${idx + 1}`}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-md px-1 py-0.5"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add Row
      </button>
    </div>
  );
}

function CustomEditor({
  config,
  setConfig,
}: {
  config: StateConfigPayload;
  setConfig: (c: StateConfigPayload) => void;
}) {
  const [text, setText] = React.useState(() => JSON.stringify(config, null, 2));
  const [parseError, setParseError] = React.useState<string | null>(null);

  const handleChange = (val: string) => {
    setText(val);
    try {
      const parsed = JSON.parse(val || "{}");
      setConfig(parsed);
      setParseError(null);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Raw JSON for custom calculation logic. Keep this minimal; advanced
        formula support is post-v1.
      </p>
      <Textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        rows={8}
        className="font-mono text-xs"
      />
      {parseError && (
        <p className="text-xs text-error">JSON error: {parseError}</p>
      )}
    </div>
  );
}
