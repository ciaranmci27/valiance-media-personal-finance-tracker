"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Info,
  OctagonAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ACCOUNTING_ENABLED } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import type {
  SetupGuideData,
  SetupLevel,
  SetupStep,
} from "@/lib/accounting/setup-guide";
import { WorkflowDialog } from "./accounting-dialog";
import { TreatmentReview } from "./tax-treatment-review";
import { accountingGet, useAccountingCommand } from "./use-accounting-command";

/**
 * The one thing the books need next, wherever the owner is. Bank access
 * first, then mapping, then the year's tax setup; the rest waits behind
 * "N more after this". Every step clears when the data says so or when the
 * owner says so; acknowledgements are saved with the books and reversible.
 */
export function SetupGuide({
  year,
  enabled = ACCOUNTING_ENABLED && !isDemoMode(),
  onApplied,
}: {
  year: number;
  enabled?: boolean;
  /** After treatments are applied from here, so the host can refresh its own reads. */
  onApplied?: () => void;
}) {
  const { data, refresh } = useSetupGuide(year, enabled);
  const cmd = useAccountingCommand(refresh);
  const [expanded, setExpanded] = React.useState(false);
  const [reviewing, setReviewing] = React.useState(false);
  const listId = React.useId();

  if (!data) return null;
  const open = data.steps.filter((s) => !s.acknowledged);
  const done = data.steps.filter((s) => s.acknowledged);
  if (open.length === 0) return null;
  const [first, ...rest] = open;
  const style = STYLE[first.level];
  const Icon = style.icon;

  const acknowledge = (step: SetupStep, acknowledged: boolean) => {
    if (!step.acknowledge) return;
    void cmd.execute({
      type: "setup.acknowledge",
      id: crypto.randomUUID(),
      key: step.acknowledge.key,
      acknowledged,
    });
  };

  const applied = () => {
    setReviewing(false);
    onApplied?.();
    // The guide and the sidebar badge both follow this.
    window.dispatchEvent(new Event("accounting-refreshed"));
  };

  const toggleLabel =
    rest.length > 0
      ? `${rest.length} more after this${done.length > 0 ? `, ${done.length} done` : ""}`
      : `${done.length} done`;

  return (
    <>
      <section
        aria-label="Setup guide"
        role={first.level === "critical" ? "alert" : "status"}
        className={cn("rounded-xl border px-4 py-3", style.box)}
      >
        <div className="flex flex-wrap items-start gap-3">
          <Icon
            size={18}
            aria-hidden="true"
            className={cn("mt-0.5 shrink-0", style.tone)}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Next step
            </p>
            <p className="text-sm font-medium">{first.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{first.detail}</p>
          </div>
          <div className="flex basis-full items-center justify-end gap-2 self-center sm:ml-auto sm:basis-auto">
            {first.acknowledge && (
              <Button
                size="sm"
                variant="ghost"
                disabled={cmd.busy}
                onClick={() => acknowledge(first, true)}
              >
                {first.acknowledge.label}
              </Button>
            )}
            <StepAction
              step={first}
              variant={first.level === "critical" ? "default" : "outline"}
              onReview={() => setReviewing(true)}
            />
          </div>
        </div>

        {cmd.error && (
          <p role="alert" className="mt-2 pl-[30px] text-sm text-error">
            {cmd.error}
          </p>
        )}

        {(rest.length > 0 || done.length > 0) && (
          <div className="mt-2 pl-[30px]">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown
                size={13}
                aria-hidden="true"
                className={cn("transition-transform", expanded && "rotate-180")}
              />
              {toggleLabel}
            </button>
            {expanded && (
              <div id={listId} className="mt-2 border-t border-border">
                {rest.length > 0 && (
                  <ol className="divide-y divide-border">
                    {rest.map((step, i) => (
                      <li
                        key={step.key}
                        className="flex flex-wrap items-center gap-3 py-2 text-sm"
                      >
                        <span
                          aria-hidden="true"
                          className="w-4 text-xs tabular-nums text-muted-foreground"
                        >
                          {i + 2}
                        </span>
                        <span className="min-w-0 flex-1">{step.title}</span>
                        <span className="flex basis-full items-center gap-1 pl-7 sm:ml-auto sm:basis-auto sm:pl-0">
                          {step.acknowledge && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={cmd.busy}
                              onClick={() => acknowledge(step, true)}
                            >
                              {step.acknowledge.label}
                            </Button>
                          )}
                          <StepAction
                            step={step}
                            variant="ghost"
                            onReview={() => setReviewing(true)}
                          />
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                {done.length > 0 && (
                  <ul
                    aria-label="Done"
                    className={cn(
                      "divide-y divide-border",
                      rest.length > 0 && "border-t border-border",
                    )}
                  >
                    {done.map((step) => (
                      <li
                        key={step.key}
                        className="flex flex-wrap items-center gap-3 py-2 text-sm text-muted-foreground"
                      >
                        <Check
                          size={14}
                          aria-hidden="true"
                          className="w-4 shrink-0 text-success"
                        />
                        <span className="min-w-0 flex-1">
                          {step.title}
                          <span className="sr-only"> (done)</span>
                        </span>
                        <button
                          type="button"
                          disabled={cmd.busy}
                          onClick={() => acknowledge(step, false)}
                          className="rounded text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        >
                          Reopen
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {reviewing && (
        <WorkflowDialog
          title="Suggest treatments"
          size="md"
          onClose={() => setReviewing(false)}
        >
          <TreatmentReview
            year={data.year}
            through={data.through}
            onApplied={applied}
            onCancel={() => setReviewing(false)}
          />
        </WorkflowDialog>
      )}
    </>
  );
}

/** One read per year shown; any command the shell runs refreshes it. */
export function useSetupGuide(year: number, enabled: boolean) {
  const [data, setData] = React.useState<SetupGuideData | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    const abort = new AbortController();
    accountingGet<SetupGuideData>(
      { view: "setup", year: String(year) },
      abort.signal,
    )
      .then((result) => {
        if (!abort.signal.aborted) setData(result);
      })
      .catch(() => {
        /* A guide that cannot load shows nothing; the page carries on. */
      });
    return () => abort.abort();
  }, [year, enabled, attempt]);

  React.useEffect(() => {
    const bump = () => setAttempt((n) => n + 1);
    window.addEventListener("accounting-refreshed", bump);
    return () => window.removeEventListener("accounting-refreshed", bump);
  }, []);

  const refresh = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { data, refresh };
}

// ---------------------------------------------------------------------------

function StepAction({
  step,
  variant,
  onReview,
}: {
  step: SetupStep;
  variant: "default" | "outline" | "ghost";
  onReview: () => void;
}) {
  const { label, target } = step.action;
  if (target.kind === "treatments")
    return (
      <Button size="sm" variant={variant} onClick={onReview}>
        {label}
        <ArrowRight size={14} aria-hidden="true" />
      </Button>
    );
  return (
    <Button size="sm" variant={variant} asChild>
      <Link
        href={target.href}
        onClick={(e) => {
          // Already on the books: swap the view in place instead of a
          // server round trip, exactly as the sidebar does.
          if (
            window.location.pathname === "/accounting" &&
            target.href.startsWith("/accounting")
          ) {
            e.preventDefault();
            window.history.pushState(null, "", target.href);
          }
        }}
      >
        {label}
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
    </Button>
  );
}

const STYLE: Record<SetupLevel, { box: string; icon: typeof Info; tone: string }> = {
  critical: {
    box: "border-error/40 bg-error/5",
    icon: OctagonAlert,
    tone: "text-error",
  },
  warning: {
    box: "border-warning/40 bg-warning/5",
    icon: AlertTriangle,
    tone: "text-warning",
  },
  info: {
    box: "border-primary/30 bg-primary/5",
    icon: Info,
    tone: "text-teal-light",
  },
};
