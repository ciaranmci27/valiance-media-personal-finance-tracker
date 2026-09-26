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

type Hold = { steps: readonly string[]; step?: number };

type Boot = {
  /** The boot screen is on: pages render underneath and it dissolves when they are ready. */
  active: boolean;
  hold: (id: string, hold: Hold) => void;
  release: (id: string) => void;
};

const BootContext = createContext<Boot>({
  active: false,
  hold: () => {},
  release: () => {},
});

/**
 * One loading screen for every hard load of the dashboard, the way the app
 * does it: the brand loader takes the whole viewport from the server's first
 * byte until the page is ready, then dissolves. A page that needs more than
 * hydration holds the boot open through `useBootHold`, naming what it is
 * doing. Once the boot is over, holds are ignored: a screen that loads later
 * runs its own loader.
 */
export function BootProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [holds, setHolds] = useState<Map<string, Hold>>(() => new Map());
  const over = useRef(false);
  useEffect(() => setMounted(true), []);
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
  const active = phase !== "done";
  const value = useMemo(
    () => ({ active, hold, release }),
    [active, hold, release],
  );
  const latest = [...holds.values()].at(-1);
  return (
    <BootContext.Provider value={value}>
      {active && (
        <AppLoading
          steps={latest?.steps ?? WORKSPACE_STEPS}
          step={latest?.step ?? 0}
          announcement="Loading your workspace"
          leaving={phase === "leaving"}
          // The page renders underneath from the first frame; an overlay that
          // fades in would let it show through for that moment.
          fadeIn={false}
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
