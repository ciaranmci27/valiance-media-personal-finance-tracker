"use client";

import * as React from "react";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
import Link from "next/link";
import {
  ArrowLeft,
  Database,
  Download,
  HardDrive,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/inputs/Checkbox";
import { RadioGroup } from "@/components/ui/inputs/RadioGroup";
import { DateInput } from "@/components/ui/inputs/DateInput";
import { cn } from "@/lib/utils";
import { isDemoMode } from "@/lib/demo";
import { ACCOUNTING_ENABLED } from "@/lib/env";
import {
  EXPORT_GROUPS,
  exportUrl,
  type ExportDataset,
  type ExportFormat,
} from "@/lib/export-datasets";

const GROUPS = EXPORT_GROUPS.filter(
  (g) => g.id !== "books" || ACCOUNTING_ENABLED,
);
const EVERYTHING = GROUPS.flatMap((g) => g.datasets.map((d) => d.id));

export function DataSettingsContent() {
  const demo = isDemoMode();
  const [selected, setSelected] = React.useState<Set<ExportDataset>>(
    () => new Set(EVERYTHING),
  );
  const [format, setFormat] = React.useState<ExportFormat>("json");
  const [limitRange, setLimitRange] = React.useState(false);
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [exportSuccess, setExportSuccess] = React.useState<string | null>(null);

  // Auto-clear success message
  React.useEffect(() => {
    if (exportSuccess) {
      const timer = setTimeout(() => setExportSuccess(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [exportSuccess]);

  const ranged = GROUPS.some((g) =>
    g.datasets.some((d) => d.ranged && selected.has(d.id)),
  );

  function toggle(id: ExportDataset, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleGroup(ids: ExportDataset[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function download() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const url = exportUrl({
        datasets: EVERYTHING.filter((id) => selected.has(id)),
        format,
        from: limitRange && from ? from : undefined,
        to: limitRange && to ? to : undefined,
      });
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "The export could not be prepared.");
      }
      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(
          response.headers.get("Content-Disposition") ?? "",
        )?.[1] ?? `valiance-export.${format === "json" ? "json" : "zip"}`;
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(href);
      setExportSuccess(
        `${name} is downloading with ${selected.size} ${selected.size === 1 ? "dataset" : "datasets"}.`,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The export could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10">
            <Database className="h-5 w-5 text-sky-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Data Management</h1>
            <p className="text-sm text-muted-foreground">
              Export and import your financial data
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/settings">
            <Button size="sm" className="rounded-xl gap-1">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
          <HeaderControls />
        </div>
      </div>

      {/* Success Message */}
      {exportSuccess && (
        <div className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm bg-success/10 text-success border border-success/20">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {exportSuccess}
        </div>
      )}

      {/* Export Section */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Export Data
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div className="glass-card rounded-xl p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 shrink-0">
              <Download className="h-5 w-5 text-teal-light" />
            </div>
            <div className="flex-1 min-w-0 space-y-6">
              <div>
                <h3 className="font-medium mb-1">Download Your Data</h3>
                <p className="text-sm text-muted-foreground">
                  Choose what to include. JSON keeps every field for a full
                  backup; CSV gives you one spreadsheet per table in a zip.
                </p>
              </div>

              {GROUPS.map((group) => {
                const ids = group.datasets.map((d) => d.id);
                const count = ids.filter((id) => selected.has(id)).length;
                const all = count === ids.length;
                return (
                  <section
                    key={group.id}
                    aria-labelledby={`export-${group.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4
                          id={`export-${group.id}`}
                          className="text-sm font-medium"
                        >
                          {group.title}
                        </h4>
                        <p className="text-xs text-muted-foreground">
                          {group.description}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleGroup(ids, !all)}
                        className="shrink-0 rounded px-1 text-xs font-medium text-teal-light hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {all ? "Clear" : "Select all"}
                      </button>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {group.datasets.map((d) => {
                        const on = selected.has(d.id);
                        return (
                          <div
                            key={d.id}
                            className={cn(
                              "rounded-xl border p-3 transition-colors",
                              on
                                ? "border-primary/40 bg-primary/5"
                                : "border-border hover:border-primary/30",
                            )}
                          >
                            <Checkbox
                              checked={on}
                              onChange={(next) => toggle(d.id, next)}
                              label={d.label}
                              description={d.description}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}

              <div className="grid gap-4 sm:grid-cols-2">
                <RadioGroup
                  label="Format"
                  orientation="horizontal"
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: "json", label: "JSON" },
                    { value: "csv", label: "CSV" },
                  ]}
                />
                {ranged && (
                  <div className="space-y-3">
                    <Checkbox
                      checked={limitRange}
                      onChange={setLimitRange}
                      label="Limit the books to a date range"
                      description="Applies to transactions, balances, statements and payroll."
                    />
                    {limitRange && (
                      <div className="grid grid-cols-2 gap-2">
                        <DateInput
                          label="From"
                          value={from}
                          onChange={setFrom}
                          minDate="1900-01-01"
                          maxDate="2100-12-31"
                        />
                        <DateInput
                          label="Through"
                          value={to}
                          onChange={setTo}
                          minDate="1900-01-01"
                          maxDate="2100-12-31"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-error/20 bg-error/5 p-3 text-sm text-error"
                >
                  {error}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {demo
                    ? "Exports are available in your own account."
                    : selected.size === 0
                      ? "Pick at least one dataset."
                      : `${selected.size} of ${EVERYTHING.length} datasets as ${format.toUpperCase()}.`}
                </p>
                <Button
                  onClick={() => void download()}
                  disabled={demo || selected.size === 0}
                  loading={busy}
                >
                  <Download className="h-4 w-4" />
                  {busy ? "Preparing" : "Download"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Storage Info */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Storage
          </h2>
          <div className="flex-1 h-px bg-border/50" />
        </div>

        <div className="glass-card rounded-xl p-6">
          <div className="flex items-start gap-4">
            {demo ? (
              <>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-secondary shrink-0">
                  <HardDrive className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium mb-1">Local Storage</h3>
                  <p className="text-sm text-muted-foreground mb-1">
                    Demo mode: using static sample data. No real data is stored
                    or persisted.
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="h-1.5 w-1.5 rounded-full bg-copper" />
                    <span>Demo mode active</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#3ECF8E]/10 shrink-0">
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 109 113"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
                      fill="url(#supabase-a)"
                    />
                    <path
                      d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
                      fill="url(#supabase-b)"
                      fillOpacity="0.2"
                    />
                    <path
                      d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.16513 56.4175L45.317 2.07103Z"
                      fill="#3ECF8E"
                    />
                    <defs>
                      <linearGradient
                        id="supabase-a"
                        x1="53.9738"
                        y1="54.974"
                        x2="94.1635"
                        y2="71.8295"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#249361" />
                        <stop offset="1" stopColor="#3ECF8E" />
                      </linearGradient>
                      <linearGradient
                        id="supabase-b"
                        x1="36.1558"
                        y1="30.578"
                        x2="54.4844"
                        y2="65.0806"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop />
                        <stop offset="1" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="font-medium mb-1">Supabase Cloud</h3>
                  <p className="text-sm text-muted-foreground mb-1">
                    Your data is securely stored in Supabase with automatic
                    backups and row-level security.
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="h-1.5 w-1.5 rounded-full bg-success" />
                    <span>Connected and operational</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
