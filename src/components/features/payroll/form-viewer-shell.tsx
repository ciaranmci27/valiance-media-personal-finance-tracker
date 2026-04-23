"use client";

// Shared chrome for the individual payroll form viewers (941, 940, A1-QRT,
// A1-APR, W-2, W-3). Each form has its own body layout; this module covers
// the header, action bar, banners, warnings, and file-confirmation dialog so
// individual viewers stay narrowly focused on line items.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  type LucideIcon,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { cn, formatCurrency } from "@/lib/utils";
import { markFormFiled } from "@/lib/payroll/forms-actions";
import type { PayrollForm } from "@/types/payroll";
import { formStatusLabel } from "@/lib/payroll/labels";

// ─── Shell props ──────────────────────────────────────────────────────────────

export interface FormViewerShellProps {
  icon: LucideIcon;
  title: string;
  subtitle: React.ReactNode;
  /** The stored payroll_forms row (null when not yet generated). */
  form: PayrollForm | null;
  /** True when a form_data payload exists and the body can render. */
  hasData: boolean;
  /** Called when user clicks Generate/Regenerate. Must display toasts and
   *  call router.refresh on success. */
  onGenerate: () => Promise<void>;
  /** In-flight state for disabling actions. */
  submitting: boolean;
  /** Warnings surfaced from the most recent generation call. */
  warnings: string[];
  /** Body content (per-form line items). */
  children: React.ReactNode;
  /** Label shown on the empty state when no form exists yet. */
  emptyStateHint: string;
  /** Copy for the discard-draft confirmation. Used when the stored status is
   *  "draft" (admin edits) and the user regenerates. */
  discardEditsDescription?: string;
  /** If true, hides the "Mark filed" action. Use for parent/rollup forms
   *  that are purely derived (e.g., a future read-only view). */
  hideMarkFiled?: boolean;
  /** Optional additional actions placed alongside Generate/Mark filed. */
  extraActions?: React.ReactNode;
}

export function FormViewerShell({
  icon: Icon,
  title,
  subtitle,
  form,
  hasData,
  onGenerate,
  submitting,
  warnings,
  children,
  emptyStateHint,
  discardEditsDescription,
  hideMarkFiled,
  extraActions,
}: FormViewerShellProps) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirmationDialog();
  const [fileDialog, setFileDialog] = React.useState(false);
  const [filing, setFiling] = React.useState(false);
  const [confirmationNumber, setConfirmationNumber] = React.useState("");

  const isFiled = form?.status === "filed";
  const hasDraftEdits = form?.status === "draft";

  const handleGenerate = async () => {
    if (hasDraftEdits && discardEditsDescription) {
      const ok = await confirm({
        title: "Discard draft edits?",
        description: discardEditsDescription,
        confirmLabel: "Discard and regenerate",
        variant: "warning",
      });
      if (!ok) return;
    }
    await onGenerate();
  };

  const handleMarkFiled = async () => {
    if (!form) return;
    setFiling(true);
    try {
      const res = await markFormFiled({
        form_id: form.id,
        confirmation_number: confirmationNumber.trim() || null,
      });
      if (!res.ok) {
        toast("error", res.error ?? "Failed to mark filed");
        return;
      }
      toast("success", `${title} marked as filed`);
      setFileDialog(false);
      router.refresh();
    } finally {
      setFiling(false);
    }
  };

  const anyPending = submitting || filing;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <StatusBadge status={form?.status ?? null} />
        </div>
      </div>

      <div className="glass-card rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <Button
          onClick={handleGenerate}
          disabled={anyPending || isFiled}
          variant={hasData ? "outline" : "default"}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1" aria-hidden="true" />
          )}
          {hasData ? "Regenerate from runs" : `Generate ${title}`}
        </Button>

        {hasData && !isFiled && !hideMarkFiled && (
          <Button
            onClick={() => setFileDialog(true)}
            disabled={anyPending}
          >
            <FileCheck2 className="h-4 w-4 mr-1" aria-hidden="true" />
            Mark filed
          </Button>
        )}

        {extraActions}

        {form?.generated_at && (
          <span className="text-xs text-muted-foreground ml-auto">
            Generated {new Date(form.generated_at).toLocaleString()}
          </span>
        )}
      </div>

      {isFiled && form && (
        <div
          role="status"
          className="rounded-xl border border-success/40 bg-success/10 p-4 flex items-start gap-3"
        >
          <CheckCircle2
            className="h-5 w-5 text-success flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="flex-1 text-sm">
            <div className="font-medium text-success">
              Filed {form.filed_at ? new Date(form.filed_at).toLocaleDateString() : ""}
            </div>
            {form.confirmation_number && (
              <div className="text-muted-foreground mt-0.5">
                Confirmation: {form.confirmation_number}
              </div>
            )}
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-2"
        >
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Review before filing
          </div>
          <ul className="text-sm text-foreground space-y-1 list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {!hasData ? (
        <div className="glass-card rounded-xl p-10 text-center text-sm text-muted-foreground space-y-2">
          <p>{emptyStateHint}</p>
          <p>Click Generate to aggregate the relevant runs and produce a draft.</p>
        </div>
      ) : (
        children
      )}

      <FileDialog
        open={fileDialog && !!form}
        title={title}
        confirmationNumber={confirmationNumber}
        onConfirmationNumberChange={setConfirmationNumber}
        onConfirm={handleMarkFiled}
        onCancel={() => {
          if (filing) return;
          setFileDialog(false);
        }}
        submitting={filing}
      />
      {confirmDialog}
    </div>
  );
}

// ─── Shared subcomponents ─────────────────────────────────────────────────────

export function LineRow({
  number,
  label,
  value,
  tax,
  rate,
  format = "currency",
  tone,
  emphasis,
  signed,
}: {
  number: string;
  label: React.ReactNode;
  value: number;
  tax?: number;
  rate?: string;
  format?: "currency" | "integer";
  tone?: "error" | "success";
  emphasis?: boolean;
  signed?: boolean;
}) {
  const valueDisplay =
    format === "integer"
      ? String(Math.round(value))
      : signed
        ? formatSigned(value)
        : formatCurrency(value);
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-1.5 text-sm",
        emphasis && "font-semibold",
      )}
    >
      <span className="w-10 flex-shrink-0 text-xs font-mono text-muted-foreground">
        {number}
      </span>
      <span className="flex-1 text-foreground">{label}</span>
      <span
        className={cn(
          "text-right font-mono tabular-nums",
          tone === "error" && "text-error",
          tone === "success" && "text-success",
        )}
      >
        {valueDisplay}
      </span>
      {rate && (
        <span className="text-xs text-muted-foreground font-mono w-16 text-right">
          × {rate}
        </span>
      )}
      {tax != null && (
        <span
          className={cn(
            "text-right font-mono tabular-nums w-28",
            emphasis && "font-semibold",
          )}
        >
          {formatCurrency(tax)}
        </span>
      )}
    </div>
  );
}

function formatSigned(value: number): string {
  if (value >= 0) return formatCurrency(value);
  return `(${formatCurrency(Math.abs(value))})`;
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "filed") {
    return (
      <span className="inline-flex items-center rounded-md bg-success/10 text-success px-2 py-1 text-xs font-medium">
        {formStatusLabel("filed")}
      </span>
    );
  }
  if (status === "generated") {
    return (
      <span className="inline-flex items-center rounded-md bg-primary/10 text-primary px-2 py-1 text-xs font-medium">
        {formStatusLabel("generated")}
      </span>
    );
  }
  if (status === "draft") {
    return (
      <span className="inline-flex items-center rounded-md bg-warning/10 text-warning px-2 py-1 text-xs font-medium">
        Edited draft
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-secondary text-muted-foreground px-2 py-1 text-xs font-medium">
      Not started
    </span>
  );
}

function FileDialog({
  open,
  title,
  confirmationNumber,
  onConfirmationNumberChange,
  onConfirm,
  onCancel,
  submitting,
}: {
  open: boolean;
  title: string;
  confirmationNumber: string;
  onConfirmationNumberChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="space-y-4">
        <DialogTitle>Mark {title} as filed</DialogTitle>
        <DialogDescription>
          Record that you have filed this return. Once marked filed, the form
          becomes read-only and regeneration is disabled.
        </DialogDescription>
        <Input
          label="Confirmation / submission ID (optional)"
          value={confirmationNumber}
          onChange={(e) => onConfirmationNumberChange(e.target.value)}
          placeholder="e.g., e-file submission ID"
        />
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={submitting}>
            {submitting && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" aria-hidden="true" />
            )}
            Mark filed
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
