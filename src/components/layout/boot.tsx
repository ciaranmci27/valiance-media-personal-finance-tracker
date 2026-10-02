"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppLoading } from "@/components/ui/app-loading";
import { useLoaderPhase } from "@/components/ui/use-loader-phase";

/** The one line every page shows while it opens. */
export const WORKSPACE_STEPS = ["Opening your workspace"] as const;

/** A route's loading fallback, rendered under the boot screen. */
const PENDING = "[data-boot-pending]";
/** A page behind a loading fallback that has streamed in but not hydrated. */
const ARRIVING = "[data-boot-arrival]";
/** The hold kept while a streamed page is on its way. */
const STREAM = "stream";
/**
 * Once nothing is streaming, how long the boot waits for the page to say it
 * has arrived. Only a page that failed to render never says so.
 */
const ARRIVAL_GRACE_MS = 1500;

type Hold = { steps: readonly string[]; step?: number };

type Boot = {
  /** The boot screen is on: pages render underneath and it dissolves when they are ready. */
  active: boolean;
  hold: (id: string, hold: Hold) => void;
  release: (id: string) => void;
  /** The page behind a route's loading fallback has hydrated. */
  arrive: () => void;
};

const BootContext = createContext<Boot>({
  active: false,
  hold: () => {},
  release: () => {},
  arrive: () => {},
});

/**
 * One loading screen for every hard load of the dashboard, the way the app
 * does it: the brand loader takes the whole viewport from the server's first
 * byte until the page is ready, then dissolves. A page that needs more than
 * hydration holds the boot open through `useBootHold`, naming what it is
 * doing. Once the boot is over, holds are ignored: a screen that loads later
 * runs its own loader.
 *
 * The overlay is one node from the first byte to the dissolve, and its status
 * line only moves forward: it keeps the last hold's line while it leaves. A
 * route with a loading fallback streams its page after the shell hydrates, so
 * the boot stays up until that page has arrived (`RouteLoading`,
 * `withBootArrival`) instead of dissolving over an empty page and handing
 * over to a second loader.
 */
export function BootProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [holds, setHolds] = useState<Map<string, Hold>>(() => new Map());
  const over = useRef(false);
  const arrived = useRef(false);
  const pending = !mounted || holds.size > 0;
  const { phase, onLeft } = useLoaderPhase(pending, { minShowMs: 500 });
  useEffect(() => {
    if (phase === "done") over.current = true;
  }, [phase]);
  const hold = useCallback((id: string, next: Hold) => {
    if (over.current) return;
    setHolds((current) => new Map(current).set(id, next));
  }, []);
  const release = useCallback((id: string) => {
    setHolds((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);
  const arrive = useCallback(() => {
    arrived.current = true;
    release(STREAM);
  }, [release]);

  // Hydration gets here after every child that hydrated with the shell. A
  // page still streaming, or streamed in but not yet hydrated, is only in the
  // DOM so far: hold for it until it says it has arrived.
  useEffect(() => {
    setMounted(true);
    if (arrived.current || !document.querySelector(`${PENDING}, ${ARRIVING}`))
      return;
    hold(STREAM, { steps: WORKSPACE_STEPS });
    let grace = 0;
    const observer = new MutationObserver(() => check());
    const settle = () => {
      observer.disconnect();
      window.clearTimeout(grace);
    };
    const check = () => {
      if (arrived.current) return settle();
      if (document.querySelector(PENDING)) {
        window.clearTimeout(grace);
        grace = 0;
      } else if (!grace) {
        grace = window.setTimeout(() => {
          settle();
          release(STREAM);
        }, ARRIVAL_GRACE_MS);
      }
    };
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return settle;
  }, [hold, release]);

  const active = phase !== "done";
  const value = useMemo(
    () => ({ active, hold, release, arrive }),
    [active, hold, release, arrive],
  );
  // The line follows the newest hold and stays on it while the overlay
  // leaves, instead of falling back to the first line mid-dissolve.
  const latest = [...holds.values()].at(-1);
  const [shown, setShown] = useState<Hold>({ steps: WORKSPACE_STEPS });
  if (latest && latest !== shown) setShown(latest);
  return (
    <BootContext.Provider value={value}>
      {active && (
        <AppLoading
          steps={shown.steps}
          step={shown.step ?? 0}
          announcement="Loading your workspace"
          leaving={phase === "leaving"}
          // The page renders underneath from the first frame; an overlay that
          // fades in would let it show through for that moment.
          fadeIn={false}
          // Already outside the page content, so hydration keeps this node.
          inPlace
          onLeft={onLeft}
        />
      )}
      {children}
    </BootContext.Provider>
  );
}

export function useBoot(): { active: boolean } {
  const { active } = useContext(BootContext);
  return { active };
}

/**
 * Keep the boot screen up while `active`, showing `steps` at `step`. A page
 * uses this for the reads it needs before its first paint, so a hard load
 * hands off from the boot screen straight to the finished page.
 */
export function useBootHold(
  active: boolean,
  steps: readonly string[],
  step?: number,
) {
  const { hold, release } = useContext(BootContext);
  const id = useId();
  useEffect(() => {
    if (!active) return;
    hold(id, { steps, step });
    return () => release(id);
  }, [active, steps, step, id, hold, release]);
}

/**
 * A route's loading fallback (loading.tsx). Under the boot screen it is only
 * a marker that keeps the boot up, so a hard load shows one loader instead of
 * the boot dissolving into this one; after the boot, `children` is the loader.
 * Its page must be wrapped in `withBootArrival`.
 */
export function RouteLoading({ children }: { children: ReactNode }) {
  const { active } = useBoot();
  useBootHold(active, WORKSPACE_STEPS);
  return active ? <span hidden data-boot-pending="" /> : children;
}

/**
 * Says the page behind a route's loading fallback has hydrated, so the boot
 * can hand over to it. Rendered by `withBootArrival`, ahead of the page: its
 * effect flushes in the same commit as the page's own, so any hold the page
 * takes lands in the same update that drops the stream hold.
 */
export function BootArrival() {
  const { arrive } = useContext(BootContext);
  useEffect(arrive, [arrive]);
  return <span hidden data-boot-arrival="" />;
}

/**
 * Whether a component may play its entrance animation: not when it mounted
 * under the boot screen. The boot hands over to a finished page, and a chart
 * still drawing itself in after the dissolve reads as the page loading twice.
 */
export function useEntranceMotion(): boolean {
  const { active } = useBoot();
  const [animate] = useState(!active);
  return animate;
}
