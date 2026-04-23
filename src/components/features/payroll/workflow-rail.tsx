"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Banknote, Play, Send } from "lucide-react";
import { cn } from "@/lib/utils";

interface WorkflowStep {
  n: 1 | 2 | 3;
  label: string;
  caption: string;
  href: string;
  icon: React.ReactNode;
}

const STEPS: WorkflowStep[] = [
  {
    n: 1,
    label: "Calculate payroll",
    caption: "Review and approve",
    href: "/payroll/run",
    icon: <Play className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    n: 2,
    label: "Pay the employee",
    caption: "Send wages, mark paid",
    href: "/payroll/runs",
    icon: <Send className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    n: 3,
    label: "Pay taxes",
    caption: "Federal + state deposits",
    href: "/payroll/deposits",
    icon: <Banknote className="h-3.5 w-3.5" aria-hidden="true" />,
  },
];

/**
 * Maps a pathname to the active workflow step, or null when the user is on
 * a page outside the step flow. Forms live outside this cycle (quarterly /
 * annual cadence), so form routes return null and hide the rail.
 */
function activeStepFor(pathname: string | null): 1 | 2 | 3 | null {
  if (!pathname) return null;
  if (pathname.startsWith("/payroll/deposits")) return 3;
  if (pathname.startsWith("/payroll/cycles")) return 2;
  if (pathname.startsWith("/payroll/runs")) return 2;
  // `/payroll/run` (singular) is the build step. Guard against `/payroll/runs`
  // by checking `runs` above first.
  if (pathname.startsWith("/payroll/run")) return 1;
  return null;
}

/**
 * Persistent workflow stepper shown above the page content on every
 * transactional payroll route. Gives the user a constant answer to "where am
 * I in the process?" and lets them jump between the three phases of a single
 * pay cycle without hunting through nav.
 *
 * Hidden on /payroll (the overview owns orientation there), /payroll/employees,
 * /payroll/config, and /payroll/forms since those aren't part of a single
 * cycle's journey.
 */
export function PayrollWorkflowRail() {
  const pathname = usePathname();
  const active = activeStepFor(pathname);
  if (active == null) return null;
  return <RailUI active={active} />;
}

function RailUI({ active }: { active: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Payroll workflow">
      <ol className="flex items-stretch gap-1.5">
        {STEPS.map((step, idx) => {
          const isActive = step.n === active;
          const isDone = step.n < active;
          const isUpcoming = step.n > active;

          return (
            <React.Fragment key={step.n}>
              <li className="flex-1 min-w-0">
                <Link
                  href={step.href}
                  aria-current={isActive ? "step" : undefined}
                  className={cn(
                    "flex w-full h-full items-center gap-2.5 rounded-lg px-3 py-2 border transition-all duration-200",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    isActive &&
                      "bg-primary/10 border-primary/40 text-foreground shadow-sm",
                    isDone &&
                      "bg-secondary/40 border-border text-foreground hover:border-primary/30 hover:bg-secondary/60",
                    isUpcoming &&
                      "bg-transparent border-border text-muted-foreground hover:border-primary/30 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-md flex-shrink-0",
                      isActive && "bg-primary text-primary-foreground",
                      isDone && "bg-success/15 text-success",
                      isUpcoming && "bg-secondary text-muted-foreground",
                    )}
                    aria-hidden="true"
                  >
                    {step.icon}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-xs font-semibold leading-tight truncate",
                        isActive && "text-foreground",
                        isDone && "text-foreground",
                        isUpcoming && "text-muted-foreground",
                      )}
                    >
                      {step.n}. {step.label}
                    </span>
                    <span className="block text-[10px] leading-tight text-muted-foreground truncate">
                      {step.caption}
                    </span>
                  </span>
                </Link>
              </li>
              {idx < STEPS.length - 1 && (
                <li
                  aria-hidden="true"
                  className="self-center text-muted-foreground/40 text-xs flex-shrink-0"
                >
                  →
                </li>
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
