"use client";

import {
  useEffect,
  useState,
  type AnimationEvent,
  type CSSProperties,
} from "react";
import { siteConfig } from "@/config/site";

/** How long each status line stays before the next one takes over. */
export const LOADER_STEP_MS = 700;

// The orbit around the mark: a hairline track and a quarter turn of brand light.
const ORBIT = 120;
const ORBIT_R = 56;
const ORBIT_C = 2 * Math.PI * ORBIT_R;
const ARC = ORBIT_C / 4;

/**
 * Where the emblem sits in the lockup files, in pixels of the 3443 x 820
 * artwork (the light and dark lockups share it): a circle of radius 397
 * centred at (403, 413.5). The crop is a slightly larger circle so the ring's
 * edge is never clipped, and round so the top of the wordmark's first letter,
 * which starts just past the ring, stays out.
 */
const MARK = { cx: 403, cy: 413.5, r: 402, fileHeight: 820 };
const MARK_D = MARK.r * 2;
const MARK_CROP: CSSProperties = {
  height: `${(MARK.fileHeight / MARK_D) * 100}%`,
  left: `${(-(MARK.cx - MARK.r) / MARK_D) * 100}%`,
  top: `${(-(MARK.cy - MARK.r) / MARK_D) * 100}%`,
};

/** Walks a status sequence one line at a time and stops on the last one. */
function useStepIndex(count: number) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (index >= count - 1) return;
    const timer = window.setTimeout(
      () => setIndex((i) => Math.min(i + 1, count - 1)),
      LOADER_STEP_MS,
    );
    return () => window.clearTimeout(timer);
  }, [index, count]);
  return index;
}

/**
 * The one loading screen, shared with the app. The emblem cropped out of the
 * lockup (the dark or light one, following the nearest `data-theme`), a
 * hairline orbit with a quarter turn of brand light going round, and a
 * status line beneath that narrates what is coming up, one short line at a
 * time. The orbit is the only indicator; the words carry no dots or spinner
 * of their own.
 *
 * The line advances on a timer by default; a host that knows which phase is
 * really running passes `step` and the line follows that instead.
 *
 * `leaving` dissolves the stage, and `onLeft` fires once that dissolve has
 * finished playing, for hosts that hand off to their content in phases.
 * `continuing` marks a second instance taking over from a first in the same
 * place, so the emblem does not arrive twice. Styles live in globals.css
 * under "Brand loader".
 */
export function BrandLoader({
  steps,
  announcement,
  step: controlledStep,
  leaving = false,
  continuing = false,
  onLeft,
  className = "",
}: {
  /** The lines the status reads, in order; the last one holds. */
  steps: readonly string[];
  /** The one thing a screen reader hears, instead of every line. */
  announcement: string;
  /** Which line to show, when the host tracks the real phase; omit to advance on a timer. */
  step?: number;
  leaving?: boolean;
  continuing?: boolean;
  onLeft?: () => void;
  className?: string;
}) {
  const timedStep = useStepIndex(steps.length);
  const step =
    controlledStep === undefined
      ? timedStep
      : Math.min(Math.max(controlledStep, 0), steps.length - 1);

  // Every animation inside the stage bubbles its end up here; only the
  // stage's own dissolve means the loader is gone.
  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (leaving && event.target === event.currentTarget) onLeft?.();
  };

  return (
    <div
      className={`brand-loader ${leaving ? "is-leaving" : ""} ${continuing ? "is-continuing" : ""} ${className}`.trim()}
    >
      <div className="brand-loader-stage" onAnimationEnd={handleAnimationEnd}>
        <div className="brand-splash">
          <svg
            className="brand-splash-orbit"
            viewBox={`0 0 ${ORBIT} ${ORBIT}`}
            aria-hidden="true"
          >
            <circle
              className="brand-splash-track"
              cx={ORBIT / 2}
              cy={ORBIT / 2}
              r={ORBIT_R}
            />
            <circle
              className="brand-splash-arc"
              cx={ORBIT / 2}
              cy={ORBIT / 2}
              r={ORBIT_R}
              strokeDasharray={`${ARC} ${ORBIT_C - ARC}`}
            />
          </svg>
          {/* Both lockups are rendered and the theme shows one, so a theme
              change never swaps an image mid-load. */}
          <span className="brand-splash-mark">
            {/* eslint-disable-next-line @next/next/no-img-element -- a cropped window over the lockup, positioned by the constants above */}
            <img
              src={siteConfig.logos.horizontalInverted}
              alt={siteConfig.companyName}
              className="brand-splash-mark-img is-dark"
              style={MARK_CROP}
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- the light lockup, same crop */}
            <img
              src={siteConfig.logos.horizontal}
              alt={siteConfig.companyName}
              className="brand-splash-mark-img is-light"
              style={MARK_CROP}
            />
          </span>
        </div>

        {/* The outgoing and incoming lines share one grid cell, so the swap
            moves nothing: the old line lifts out as the new one rises in. */}
        <div className="brand-loader-steps" aria-hidden="true">
          {step > 0 && (
            <span key={`out-${step - 1}`} className="brand-step brand-step-out">
              {steps[step - 1]}
            </span>
          )}
          <span key={`in-${step}`} className="brand-step brand-step-in">
            {steps[step]}
          </span>
        </div>
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>
    </div>
  );
}
