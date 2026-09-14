"use client";
import { Check, Loader2 } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The review checkmark. One look everywhere a transaction can be marked
 * reviewed: the list rows and the editor's footer.
 */
export function ReviewCheck({
  reviewed,
  categorized,
  name,
  busy = false,
  disabled = false,
  onToggle,
}: {
  reviewed: boolean;
  /** Without a category the check stays off and says why. */
  categorized: boolean;
  /** Names the transaction for assistive tech. */
  name: string;
  busy?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const hint = reviewed
    ? "Mark as unreviewed"
    : categorized
      ? "Mark as reviewed"
      : "Choose a category first";
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        disabled={disabled || (!reviewed && !categorized)}
        onClick={onToggle}
        aria-label={
          reviewed ? `Mark ${name} as unreviewed` : `Mark ${name} as reviewed`
        }
        aria-pressed={reviewed}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-default",
          reviewed
            ? "border-primary/20 bg-primary/15 text-teal-light enabled:hover:bg-primary/25"
            : "border-border text-muted-foreground enabled:hover:border-primary enabled:hover:bg-primary/10 enabled:hover:text-teal-light",
          !categorized && !reviewed && "opacity-40",
        )}
      >
        {busy ? (
          <Loader2
            size={15}
            aria-label="Saving transaction"
            className="animate-spin"
          />
        ) : (
          <Check size={15} aria-hidden="true" />
        )}
      </button>
    </Tooltip>
  );
}
