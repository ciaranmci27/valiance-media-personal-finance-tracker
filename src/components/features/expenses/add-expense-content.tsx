"use client";

import * as React from "react";
import {
  MobileMenuButton,
  HeaderControls,
} from "@/components/layout/page-header";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Save,
  X,
  FileText,
  User,
  Briefcase,
  DollarSign,
  Calendar,
  TrendingUp,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { TextInput } from "@/components/ui/inputs/TextInput";
import { NumberInput } from "@/components/ui/inputs/NumberInput";
import { Select } from "@/components/ui/inputs/Select";
import { Textarea } from "@/components/ui/inputs/Textarea";
import { formatCurrency, toMonthlyAmount, toAnnualAmount } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { isDemoMode } from "@/lib/demo";
import type { ExpenseCategory } from "@/types/database";
import { EXPENSE_CATEGORIES } from "@/types/database";

export function AddExpenseContent() {
  const router = useRouter();
  const [isSaving, setIsSaving] = React.useState(false);

  // Form state with defaults
  const [name, setName] = React.useState("");
  const [amount, setAmount] = React.useState<number>(0);
  const [frequency, setFrequency] = React.useState<
    "weekly" | "monthly" | "quarterly" | "annual"
  >("monthly");
  const [expenseType, setExpenseType] = React.useState<"personal" | "business">(
    "personal",
  );
  const [category, setCategory] = React.useState<ExpenseCategory | null>(null);
  const [notes, setNotes] = React.useState("");

  const monthly = toMonthlyAmount(Number(amount), frequency);
  const annual = toAnnualAmount(Number(amount), frequency);

  const frequencyLabels: Record<string, string> = {
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    annual: "Annual",
  };

  const handleSave = async () => {
    if (!name.trim() || amount <= 0) return;

    // In demo mode, show message and navigate back
    if (isDemoMode()) {
      toast("info", "Demo mode: changes are not saved");
      router.push("/expenses");
      return;
    }

    setIsSaving(true);
    const supabase = createClient();

    try {
      const { data, error } = await supabase
        .from("expenses")
        .insert({
          name: name.trim(),
          amount: Number(amount),
          frequency,
          expense_type: expenseType,
          category,
          is_active: true,
          notes: notes || null,
        })
        .select()
        .single();

      if (error) throw error;

      // Navigate to the new expense detail page
      router.push(`/expenses/${data.id}`);
      router.refresh();
    } catch (error) {
      console.error("Error creating expense:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const formatClean = (value: number) => formatCurrency(value);

  const canSave = name.trim() && amount > 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <MobileMenuButton />
          <TextInput
            aria-label="Name"
            value={name}
            onChange={(nextValue) => setName(nextValue)}
            placeholder="Expense name..."
            autoFocus
          />
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <HeaderControls />
          <Link href="/expenses">
            <Button variant="ghost" disabled={isSaving}>
              <X className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Cancel</span>
            </Button>
          </Link>
          <Button onClick={handleSave} disabled={isSaving || !canSave}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 sm:mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 sm:mr-1" />
            )}
            <span className="hidden sm:inline">
              {isSaving ? "Creating..." : "Create"}
            </span>
          </Button>
        </div>
      </div>

      {/* Financial Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px rounded-xl overflow-hidden glass-card">
        <div className="bg-white/[0.03] p-4 sm:p-5 text-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm font-medium">Amount</span>
          </div>
          <NumberInput
            aria-label="Amount (USD)"
            step={0.01}
            value={amount || ""}
            onChange={(nextValue) => setAmount(Number(String(nextValue)))}
            placeholder="0.00"
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {frequencyLabels[frequency]}
          </p>
        </div>
        <div className="bg-white/[0.03] p-4 sm:p-5 text-center border-l sm:border-x border-white/[0.06]">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <Calendar className="h-4 w-4" />
            <span className="text-sm font-medium">Monthly</span>
          </div>
          <p className="text-xl sm:text-2xl font-bold tabular-nums text-teal-light">
            {amount > 0 ? formatClean(monthly) : "$0"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Per month</p>
        </div>
        <div className="hidden sm:block bg-white/[0.03] p-5 text-center">
          <div className="flex items-center justify-center gap-1 text-muted-foreground mb-2">
            <TrendingUp className="h-4 w-4" />
            <span className="text-sm font-medium">Annual</span>
          </div>
          <p className="text-2xl font-bold tabular-nums">
            {amount > 0 ? formatClean(annual) : "$0"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">Per year</p>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-4 p-6 rounded-xl glass-card">
        <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wider">
          Details
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Frequency"
            value={frequency}
            onChange={(value) => setFrequency(value as typeof frequency)}
            options={[
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
              { value: "quarterly", label: "Quarterly" },
              { value: "annual", label: "Annual" },
            ]}
          />

          <Select
            label="Type"
            value={expenseType}
            onChange={(value) =>
              setExpenseType(value as "personal" | "business")
            }
            options={[
              { value: "personal", label: "Personal" },
              { value: "business", label: siteConfig.companyName },
            ]}
          />
        </div>

        <Select
          label="Category"
          value={category || ""}
          onChange={(value) => setCategory((value as ExpenseCategory) || null)}
          placeholder="Select a category..."
          options={Object.entries(EXPENSE_CATEGORIES).map(([value, label]) => ({
            value,
            label,
          }))}
        />

        {/* Type Badge Preview */}
        <div className="flex items-center gap-2 pt-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              expenseType === "personal"
                ? "bg-teal/20 text-teal-light"
                : "bg-copper/20 text-copper"
            }`}
          >
            {expenseType === "personal" ? (
              <User className="h-3 w-3" />
            ) : (
              <Briefcase className="h-3 w-3" />
            )}
            {expenseType === "personal" ? "Personal" : siteConfig.companyName}
          </span>
          {category && (
            <>
              <span className="text-muted-foreground">•</span>
              <span className="text-sm text-muted-foreground">
                {EXPENSE_CATEGORIES[category]}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Notes */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <FileText className="h-4 w-4" />
          <h3 className="font-medium text-sm uppercase tracking-wider">
            Notes
          </h3>
        </div>
        <Textarea
          aria-label="Notes"
          value={notes}
          onChange={(nextValue) => setNotes(nextValue)}
          placeholder="Add notes about this expense..."
        />
      </div>
    </div>
  );
}
