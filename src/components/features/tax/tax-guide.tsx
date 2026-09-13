"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { GuideStepKey } from "./tax-estimator-model";

export interface GuideStep {
  key: GuideStepKey;
  title: string;
  /** Shown while the step is open. Written as the question the owner answers. */
  question: string;
  /** Shown once the step is done. */
  summary: string;
  done: boolean;
  action: { label: string; onSelect: () => void };
  /** Lets the owner answer "none" for a step the data cannot prove. */
  skip?: { label: string; onSelect: () => void };
}

/**
 * The way in for a thin year. Full card while there is no income yet, a
 * one-line strip once there is, gone when every step is done or hidden.
 */
export function TaxGuide({
  year,
  density,
  steps,
  onHide,
}: {
  year: number;
  density: "hero" | "strip";
  steps: GuideStep[];
  onHide: () => void;
}) {
  const doneCount = steps.filter((s) => s.done).length;
  const firstOpen = steps.findIndex((s) => !s.done);

  if (density === "strip") {
    const open = steps.filter((s) => !s.done);
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-[rgba(var(--ink),0.03)] px-4 py-2.5 text-sm">
        <span className="font-medium">
          {doneCount} of {steps.length} setup steps done
        </span>
        {open.map((s) => (
          <span key={s.key} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground">{s.question}</span>
            <Button size="sm" variant="ghost" onClick={s.action.onSelect}>
              {s.action.label}
            </Button>
            {s.skip && (
              <button
                type="button"
                onClick={s.skip.onSelect}
                className="rounded text-xs text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {s.skip.label}
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          onClick={onHide}
          className="ml-auto rounded text-xs text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Hide
        </button>
      </div>
    );
  }

  return (
    <Card glass className="animate-fade-up">
      <CardContent className="p-5 lg:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Getting started
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">
              Build your {year} estimate
            </h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Four short steps. Everything saves as you go and the estimate
              updates as you type.
            </p>
          </div>
          <Badge variant={doneCount === steps.length ? "success" : "default"}>
            {doneCount} of {steps.length} done
          </Badge>
        </div>

        <ol className="mt-5 grid gap-3 md:grid-cols-2">
          {steps.map((s, i) => {
            const current = !s.done && i === firstOpen;
            return (
              <li
                key={s.key}
                className={cn(
                  "flex gap-3 rounded-xl border p-4",
                  s.done
                    ? "border-border bg-[rgba(var(--ink),0.02)]"
                    : "border-border bg-[rgba(var(--ink),0.035)]",
                  current && "border-teal/50 ring-1 ring-teal/20",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    s.done
                      ? "bg-success/15 text-success"
                      : current
                        ? "bg-teal text-white"
                        : "bg-[rgba(var(--ink),0.08)] text-muted-foreground",
                  )}
                >
                  {s.done ? <Check size={13} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {s.title}
                    {s.done && <span className="sr-only"> (done)</span>}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {s.done ? s.summary : s.question}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={s.done ? "ghost" : current ? "default" : "outline"}
                      onClick={s.action.onSelect}
                    >
                      {s.done ? "Edit" : s.action.label}
                    </Button>
                    {!s.done && s.skip && (
                      <Button size="sm" variant="ghost" onClick={s.skip.onSelect}>
                        {s.skip.label}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onHide}
            className="rounded text-xs text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Hide this guide and show the estimate
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
