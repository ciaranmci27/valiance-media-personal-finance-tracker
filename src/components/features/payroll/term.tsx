"use client";

import * as React from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { GLOSSARY, type GlossarySlug } from "@/lib/payroll/labels";
import { cn } from "@/lib/utils";

interface TermProps {
  /** Glossary entry key. The title + body are fetched from labels.ts. */
  slug: GlossarySlug;
  /** What the user sees. Defaults to the entry's title so most usages are
   *  just <Term slug="941" />. Override when the label differs from the
   *  glossary title (e.g., rendering "941" while the entry title is "Form 941"). */
  children?: React.ReactNode;
  /** Inline style when true (dashed underline, muted cursor hint). When false,
   *  the child is rendered with no decoration - useful when the child already
   *  carries its own styling (pills, headings) but still wants explanation. */
  underline?: boolean;
  className?: string;
}

/**
 * Dotted-underlined term that surfaces a definition on hover/focus.
 *
 * Used everywhere payroll jargon shows up (941, FUTA, YTD, Schedule B, etc.)
 * so the user has a consistent affordance: a subtle underline + cursor-help
 * that they can trust means "hover me to learn what this is."
 */
export function Term({
  slug,
  children,
  underline = true,
  className,
}: TermProps) {
  const entry = GLOSSARY[slug];
  const label = children ?? entry.title;

  return (
    <Tooltip
      wide
      content={
        <span className="block text-left">
          <span className="font-semibold text-foreground block mb-1">
            {entry.title}
          </span>
          <span className="text-muted-foreground">{entry.body}</span>
        </span>
      }
      className={cn(
        underline &&
          "underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px] cursor-help",
        className,
      )}
    >
      <span>{label}</span>
    </Tooltip>
  );
}
