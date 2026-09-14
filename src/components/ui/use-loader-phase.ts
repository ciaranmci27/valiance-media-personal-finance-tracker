"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** The loader stays up at least this long once shown, so a quick answer never flashes it. */
const DEFAULT_MIN_SHOW_MS = 350;
/**
 * The dissolve reports its own end (see `onLeft`); this only steps in if the
 * event never comes, for instance in a background tab where the animation is
 * not being played. Longer than .brand-loader-out so it never cuts it short.
 */
const EXIT_FALLBACK_MS = 1000;

export type LoaderPhase = "loading" | "leaving" | "done";

/**
 * Turns a `loading` flag into the three moments a loading screen has: on
 * screen, leaving, gone. The host renders the loader for the first two
 * (passing `leaving` so it can dissolve, and `onLeft` so it can say when the
 * dissolve has finished) and its real content only for `done`. Arrival then
 * reads as one hand-off rather than a cut from a half-drawn loader to a page
 * fading in from nothing.
 *
 * `minShowMs` holds a loader that was shown even when the data is quick.
 */
export function useLoaderPhase(
  loading: boolean,
  options: { minShowMs?: number } = {},
): { phase: LoaderPhase; onLeft: () => void } {
  const { minShowMs = DEFAULT_MIN_SHOW_MS } = options;
  const [settled, setSettled] = useState<Exclude<
    LoaderPhase,
    "loading"
  > | null>(loading ? null : "done");
  const [wasLoading, setWasLoading] = useState(loading);
  const shownAt = useRef(0);

  // A fresh load after the first one starts the sequence over.
  if (loading !== wasLoading) {
    setWasLoading(loading);
    if (loading) setSettled(null);
  }

  useEffect(() => {
    if (loading) {
      shownAt.current = performance.now();
      return;
    }
    // Never shown: nothing to hold or dissolve.
    if (shownAt.current === 0) return;
    const hold = Math.max(0, minShowMs - (performance.now() - shownAt.current));
    const leave = window.setTimeout(() => setSettled("leaving"), hold);
    const fallback = window.setTimeout(
      () => setSettled("done"),
      hold + EXIT_FALLBACK_MS,
    );
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(fallback);
    };
  }, [loading, minShowMs]);

  /** The loader's dissolve has finished playing. */
  const onLeft = useCallback(() => {
    setSettled((current) => (current === "leaving" ? "done" : current));
  }, []);

  return { phase: loading ? "loading" : (settled ?? "loading"), onLeft };
}
