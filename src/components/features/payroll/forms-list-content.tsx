"use client";

import * as React from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  FileCheck2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  form940DueDate,
  form941DueDate,
  formA1AprDueDate,
  formA1QrtDueDate,
  w2DueDate,
} from "@/lib/payroll/deposits";
import {
  PAYROLL_FORM_TYPE_LABELS,
  type PayrollForm,
  type PayrollFormStatus,
  type PayrollFormType,
} from "@/types/payroll";
import { formStatusLabel } from "@/lib/payroll/labels";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  forms: PayrollForm[];
  currentYear: number;
}

// A "slot" is one scheduled filing for a tax year: type + optional quarter.
// Employee-scoped forms (W-2) are summarized as a single slot that points at
// the per-year W-2 index page.
interface Slot {
  id: string;
  type: PayrollFormType;
  year: number;
  quarter: 1 | 2 | 3 | 4 | null;
  label: string;
  href: string;
  dueDate: string;
  form: PayrollForm | null;
  /** For W-2, total count of generated W-2 forms so the slot can show
   *  progress instead of a single status. */
  w2Progress?: { generated: number; filed: number };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FormsListContent({ forms, currentYear }: Props) {
  const formsByKey = React.useMemo(() => {
    const map = new Map<string, PayrollForm>();
    for (const f of forms) {
      // Quarter/employee-scoped key for exact lookup; W-2 rollup uses a
      // separate path below.
      const key = `${f.tax_year}|${f.form_type}|${f.quarter ?? ""}|${f.employee_id ?? ""}`;
      map.set(key, f);
    }
    return map;
  }, [forms]);

  const w2ProgressByYear = React.useMemo(() => {
    const map = new Map<number, { generated: number; filed: number }>();
    for (const f of forms) {
      if (f.form_type !== "w2") continue;
      const entry = map.get(f.tax_year) ?? { generated: 0, filed: 0 };
      entry.generated += 1;
      if (f.status === "filed") entry.filed += 1;
      map.set(f.tax_year, entry);
    }
    return map;
  }, [forms]);

  const years = React.useMemo(() => {
    const set = new Set<number>([currentYear]);
    for (const f of forms) set.add(f.tax_year);
    return Array.from(set).sort((a, b) => b - a);
  }, [forms, currentYear]);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <FileCheck2 className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Tax Forms</h1>
            <p className="text-sm text-muted-foreground">
              Quarterly and annual payroll filings
            </p>
          </div>
        </div>
      </div>

      {years.map((year) => {
        const slots = buildYearSlots(year, formsByKey, w2ProgressByYear);
        return (
          <section key={year} className="glass-card rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{year}</h2>
              {year === currentYear && (
                <span className="text-xs text-muted-foreground">
                  Current tax year
                </span>
              )}
            </div>
            <div className="border-t border-border pt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {slots.map((slot) => (
                <FormSlotCard key={slot.id} slot={slot} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ─── Slot construction ────────────────────────────────────────────────────────

function buildYearSlots(
  year: number,
  formsByKey: Map<string, PayrollForm>,
  w2ProgressByYear: Map<number, { generated: number; filed: number }>,
): Slot[] {
  const slots: Slot[] = [];

  // 941 and A1-QRT: quarterly. One slot per quarter each.
  for (const q of [1, 2, 3, 4] as const) {
    slots.push({
      id: `${year}-941-${q}`,
      type: "941",
      year,
      quarter: q,
      label: `${PAYROLL_FORM_TYPE_LABELS["941"]} - Q${q}`,
      href: `/payroll/forms/941/${year}/${q}`,
      dueDate: form941DueDate(year, q),
      form: formsByKey.get(`${year}|941|${q}|`) ?? null,
    });
    slots.push({
      id: `${year}-a1_qrt-${q}`,
      type: "a1_qrt",
      year,
      quarter: q,
      label: `${PAYROLL_FORM_TYPE_LABELS.a1_qrt} - Q${q}`,
      href: `/payroll/forms/a1-qrt/${year}/${q}`,
      dueDate: formA1QrtDueDate(year, q),
      form: formsByKey.get(`${year}|a1_qrt|${q}|`) ?? null,
    });
  }

  // Annual: 940, W-3, A1-APR. Jan 31 or Feb 28 respectively.
  slots.push({
    id: `${year}-940`,
    type: "940",
    year,
    quarter: null,
    label: PAYROLL_FORM_TYPE_LABELS["940"],
    href: `/payroll/forms/940/${year}`,
    dueDate: form940DueDate(year),
    form: formsByKey.get(`${year}|940||`) ?? null,
  });

  slots.push({
    id: `${year}-w3`,
    type: "w3",
    year,
    quarter: null,
    label: PAYROLL_FORM_TYPE_LABELS.w3,
    href: `/payroll/forms/w3/${year}`,
    dueDate: w2DueDate(year),
    form: formsByKey.get(`${year}|w3||`) ?? null,
  });

  slots.push({
    id: `${year}-a1_apr`,
    type: "a1_apr",
    year,
    quarter: null,
    label: PAYROLL_FORM_TYPE_LABELS.a1_apr,
    href: `/payroll/forms/a1-apr/${year}`,
    dueDate: formA1AprDueDate(year),
    form: formsByKey.get(`${year}|a1_apr||`) ?? null,
  });

  // Per-employee W-2 rollup. Uses a slot that points at the year index page;
  // the card surfaces per-year progress.
  slots.push({
    id: `${year}-w2`,
    type: "w2",
    year,
    quarter: null,
    label: PAYROLL_FORM_TYPE_LABELS.w2,
    href: `/payroll/forms/w2/${year}`,
    dueDate: w2DueDate(year),
    form: null,
    w2Progress: w2ProgressByYear.get(year) ?? { generated: 0, filed: 0 },
  });

  // Order by due date. Tie-break by quarter-start (Q1 before Q2 within the
  // same due date). Past-due items (older due dates) sort first so the admin
  // sees anything overdue at the top of the year section.
  slots.sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    const aq = a.quarter ?? 99;
    const bq = b.quarter ?? 99;
    if (aq !== bq) return aq - bq;
    return a.type.localeCompare(b.type);
  });

  return slots;
}

// ─── Slot card ────────────────────────────────────────────────────────────────

function FormSlotCard({ slot }: { slot: Slot }) {
  const today = todayYmd();
  const overdue =
    slot.form?.status !== "filed" && slot.dueDate < today && !slot.w2Progress;
  const dueSoon =
    slot.form?.status !== "filed" &&
    withinDays(slot.dueDate, today, 14) &&
    !slot.w2Progress;

  // W-2 slot uses its own status icon (in-progress if any generated but not
  // all filed, success if all filed).
  const w2AllFiled =
    slot.w2Progress != null &&
    slot.w2Progress.generated > 0 &&
    slot.w2Progress.generated === slot.w2Progress.filed;

  const iconClass = cn(
    "flex h-9 w-9 items-center justify-center rounded-lg",
    slot.form?.status === "filed" || w2AllFiled
      ? "bg-success/10 text-success"
      : overdue
        ? "bg-error/10 text-error"
        : "bg-primary/10 text-primary",
  );

  return (
    <Link
      href={slot.href}
      className={cn(
        "rounded-lg border border-border p-3 flex items-center gap-3 transition-colors hover:border-primary/30 hover:bg-secondary/30",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <div className={iconClass} aria-hidden="true">
        {slot.form?.status === "filed" || w2AllFiled ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Clock className="h-4 w-4" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground">{slot.label}</div>
        <div
          className={cn(
            "text-xs text-muted-foreground",
            overdue && "text-error font-medium",
            dueSoon && !overdue && "text-warning font-medium",
          )}
        >
          {slot.w2Progress
            ? w2StatusLine(slot.w2Progress, slot.dueDate)
            : statusLine(slot.form?.status ?? null, slot.dueDate)}
        </div>
      </div>
      <ChevronRight
        className="h-4 w-4 text-muted-foreground/50"
        aria-hidden="true"
      />
    </Link>
  );
}

function statusLine(status: PayrollFormStatus | null, dueDate: string): string {
  if (status === "filed") return formStatusLabel("filed");
  if (status === "generated")
    return `${formStatusLabel("generated")} - due ${dueDate}`;
  if (status === "draft") return `${formStatusLabel("draft")} - due ${dueDate}`;
  return `Not started - due ${dueDate}`;
}

function w2StatusLine(
  progress: { generated: number; filed: number },
  dueDate: string,
): string {
  if (progress.generated === 0) return `Not started - due ${dueDate}`;
  if (progress.filed === progress.generated) {
    return `${progress.filed} of ${progress.generated} filed`;
  }
  if (progress.filed > 0) {
    return `${progress.filed} of ${progress.generated} filed - due ${dueDate}`;
  }
  return `${progress.generated} ready to review - due ${dueDate}`;
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function withinDays(target: string, from: string, days: number): boolean {
  const t = Date.parse(`${target}T00:00:00Z`);
  const f = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(f)) return false;
  const diff = (t - f) / 86_400_000;
  return diff >= 0 && diff <= days;
}
