"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Database,
  Download,
  FileJson,
  FileSpreadsheet,
  Loader2,
  HardDrive,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";

export function DataSettingsContent() {
  const [isExporting, setIsExporting] = React.useState<"json" | "csv" | null>(null);
  const [exportSuccess, setExportSuccess] = React.useState<string | null>(null);

  // Auto-clear success message
  React.useEffect(() => {
    if (exportSuccess) {
      const timer = setTimeout(() => setExportSuccess(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [exportSuccess]);

  const handleExportJSON = async () => {
    setIsExporting("json");
    const supabase = createClient();

    try {
      const [
        { data: incomeSources },
        { data: incomeEntries },
        { data: incomeAmounts },
        { data: expenses },
        { data: netWorth },
      ] = await Promise.all([
        supabase.from("income_sources").select("*").is("deleted_at", null),
        supabase.from("income_entries").select("*").is("deleted_at", null),
        supabase.from("income_amounts").select("*"),
        supabase.from("expenses").select("*").is("deleted_at", null),
        supabase.from("net_worth").select("*").is("deleted_at", null),
      ]);

      const exportData = {
        exportedAt: new Date().toISOString(),
        incomeSources,
        incomeEntries,
        incomeAmounts,
        expenses,
        netWorth,
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `valiance-finance-export-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportSuccess("JSON export completed");
    } catch (error) {
      console.error("Error exporting:", error);
    } finally {
      setIsExporting(null);
    }
  };

  const handleExportCSV = async () => {
    setIsExporting("csv");
    const supabase = createClient();

    try {
      const { data: entries } = await supabase
        .from("income_entries")
        .select(`
          month,
          notes,
          income_amounts (
            amount,
            income_sources (name)
          )
        `)
        .is("deleted_at", null)
        .order("month", { ascending: false });

      if (!entries) return;

      const headers = ["Month", "Total", "Notes"];
      const rows = entries.map((entry) => {
        const total = entry.income_amounts.reduce(
          (sum: number, ia: { amount: string }) => sum + Number(ia.amount),
          0
        );
        return [entry.month, total.toFixed(2), entry.notes || ""].join(",");
      });

      const csv = [headers.join(","), ...rows].join("\n");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `valiance-income-export-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportSuccess("CSV export completed");
    } catch (error) {
      console.error("Error exporting:", error);
    } finally {
      setIsExporting(null);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Database className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Data Management</h1>
            <p className="text-sm text-muted-foreground">
              Export and import your financial data
            </p>
          </div>
        </div>
        <Link href="/settings">
          <Button size="sm" className="rounded-xl gap-1">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
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
              <Download className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 space-y-4">
              <div>
                <h3 className="font-medium mb-1">Download Your Data</h3>
                <p className="text-sm text-muted-foreground">
                  Export your financial data for backup or analysis in other tools.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                {/* JSON Export */}
                <button
                  onClick={handleExportJSON}
                  disabled={isExporting !== null}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl border border-border p-4 text-left transition-all",
                    "hover:border-primary/30 hover:bg-primary/5",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#C5A68F]/10 group-hover:bg-[#C5A68F]/20 transition-colors">
                    {isExporting === "json" ? (
                      <Loader2 className="h-5 w-5 text-[#C5A68F] animate-spin" />
                    ) : (
                      <FileJson className="h-5 w-5 text-[#C5A68F]" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-sm">JSON Format</p>
                    <p className="text-xs text-muted-foreground">Complete backup</p>
                  </div>
                </button>

                {/* CSV Export */}
                <button
                  onClick={handleExportCSV}
                  disabled={isExporting !== null}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl border border-border p-4 text-left transition-all",
                    "hover:border-primary/30 hover:bg-primary/5",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10 group-hover:bg-success/20 transition-colors">
                    {isExporting === "csv" ? (
                      <Loader2 className="h-5 w-5 text-success animate-spin" />
                    ) : (
                      <FileSpreadsheet className="h-5 w-5 text-success" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium text-sm">CSV Format</p>
                    <p className="text-xs text-muted-foreground">For spreadsheets</p>
                  </div>
                </button>
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
            {isDemoMode() ? (
              <>
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted shrink-0">
                  <HardDrive className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium mb-1">Local Storage</h3>
                  <p className="text-sm text-muted-foreground mb-1">
                    Demo mode — using static sample data. No real data is stored or persisted.
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
                  <svg className="h-5 w-5" viewBox="0 0 109 113" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#supabase-a)" />
                    <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#supabase-b)" fillOpacity="0.2" />
                    <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.16513 56.4175L45.317 2.07103Z" fill="#3ECF8E" />
                    <defs>
                      <linearGradient id="supabase-a" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#249361" />
                        <stop offset="1" stopColor="#3ECF8E" />
                      </linearGradient>
                      <linearGradient id="supabase-b" x1="36.1558" y1="30.578" x2="54.4844" y2="65.0806" gradientUnits="userSpaceOnUse">
                        <stop />
                        <stop offset="1" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
                <div className="flex-1">
                  <h3 className="font-medium mb-1">Supabase Cloud</h3>
                  <p className="text-sm text-muted-foreground mb-1">
                    Your data is securely stored in Supabase with automatic backups and row-level security.
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
