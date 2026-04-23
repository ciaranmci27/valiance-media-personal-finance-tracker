"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "default";
  /** When true, adds a second confirmation step before executing */
  doubleConfirm?: boolean;
  /** Title for the second confirmation step */
  doubleConfirmTitle?: string;
  /** Description for the second confirmation step */
  doubleConfirmDescription?: React.ReactNode;
  /** Button label for the second confirmation step (falls back to confirmLabel) */
  doubleConfirmLabel?: string;
}

export function ConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  doubleConfirm = false,
  doubleConfirmTitle = "Are you absolutely sure?",
  doubleConfirmDescription = "This action is permanent and cannot be undone.",
  doubleConfirmLabel,
}: ConfirmationDialogProps) {
  const [step, setStep] = React.useState(1);

  const handleClose = () => {
    setStep(1);
    onOpenChange(false);
  };

  const handleConfirm = () => {
    if (doubleConfirm && step === 1) {
      setStep(2);
      return;
    }
    onConfirm();
    handleClose();
  };

  // Reset step when dialog closes externally
  React.useEffect(() => {
    if (!open) setStep(1);
  }, [open]);

  const isStep2 = doubleConfirm && step === 2;

  const iconColors = {
    danger: "bg-error/10 text-error",
    warning: "bg-warning/10 text-warning",
    default: "bg-primary/10 text-primary",
  };

  const activeTitle = isStep2 ? doubleConfirmTitle : title;
  const activeDescription = isStep2 ? doubleConfirmDescription : description;
  const activeLabel = isStep2 ? (doubleConfirmLabel ?? confirmLabel) : confirmLabel;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
          onEscapeKeyDown={() => handleClose()}
        >
          {/* Icon */}
          <div
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-xl mb-4",
              iconColors[variant]
            )}
          >
            <AlertTriangle className="h-6 w-6" />
          </div>

          {/* Title */}
          <DialogPrimitive.Title className="text-lg font-semibold mb-2">
            {activeTitle}
          </DialogPrimitive.Title>

          {/* Description */}
          <DialogPrimitive.Description asChild>
            <div className="text-sm text-muted-foreground leading-relaxed mb-6">
              {activeDescription}
            </div>
          </DialogPrimitive.Description>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleClose}
              className="flex-1 rounded-xl"
            >
              {cancelLabel}
            </Button>
            <Button
              variant={variant === "danger" ? "destructive" : "default"}
              onClick={handleConfirm}
              className="flex-1 rounded-xl"
            >
              {activeLabel}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Hook for managing confirmation dialog state.
 *
 * Usage:
 * ```tsx
 * const { confirm, dialog } = useConfirmationDialog();
 *
 * const handleDelete = async () => {
 *   const ok = await confirm({
 *     title: "Delete item?",
 *     description: "This will soft-delete the item.",
 *     confirmLabel: "Delete",
 *     variant: "danger",
 *   });
 *   if (!ok) return;
 *   // proceed with delete
 * };
 *
 * return <>{dialog}{/* rest of UI *\/}</>
 * ```
 */
export function useConfirmationDialog() {
  const [state, setState] = React.useState<{
    open: boolean;
    props: Omit<ConfirmationDialogProps, "open" | "onOpenChange" | "onConfirm">;
    resolve: ((value: boolean) => void) | null;
  }>({
    open: false,
    props: { title: "", description: "" },
    resolve: null,
  });

  const confirm = React.useCallback(
    (props: Omit<ConfirmationDialogProps, "open" | "onOpenChange" | "onConfirm">) => {
      return new Promise<boolean>((resolve) => {
        setState({ open: true, props, resolve });
      });
    },
    []
  );

  const handleConfirm = React.useCallback(() => {
    state.resolve?.(true);
    setState((prev) => ({ ...prev, open: false, resolve: null }));
  }, [state.resolve]);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) {
        state.resolve?.(false);
        setState((prev) => ({ ...prev, open: false, resolve: null }));
      }
    },
    [state.resolve]
  );

  const dialog = (
    <ConfirmationDialog
      open={state.open}
      onOpenChange={handleOpenChange}
      onConfirm={handleConfirm}
      {...state.props}
    />
  );

  return { confirm, dialog };
}
