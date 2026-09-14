"use client";

import { useEffect, useRef, useState } from "react";
import {
  bootQueries,
  viewQueries,
  type PreloadContext,
} from "@/lib/accounting/preload";
import type {
  AccountingQuery,
  AccountingReadCache,
} from "@/lib/accounting/read-cache";
import type { AccountingView } from "@/lib/accounting/views";
import type { RegisterFilter } from "@/lib/accounting/workflows";
import { loadView, peekView } from "./accounting-views";

export type ViewGate = {
  /** The screen may mount: its chunk and first reads are in memory. */
  ready: boolean;
  /** While the first screen loads: 1 for the shell's own reads, 2 for the screen's. */
  step: 1 | 2;
};

/**
 * Holds a screen back until its chunk and first reads are here, so it mounts
 * whole. When everything is already in memory the gate is open on the very
 * render that asked, and no loader is shown. What a screen needs is decided
 * once, when it is asked for, from the books as they are at that moment; an
 * answer marked stale by a write counts as missing, so a screen never opens
 * on a pre-write value.
 */
export function useViewGate(input: {
  view: AccountingView;
  /** Changes whenever the screen must mount afresh, like the ledger's remount key. */
  mountKey: string;
  ctx: PreloadContext;
  initialFilter?: Partial<RegisterFilter>;
  demo: boolean;
  cache: AccountingReadCache;
}): ViewGate {
  const { view, mountKey, ctx, initialFilter, demo, cache } = input;
  const booted = useRef(false);
  const key = `${view}:${mountKey}`;
  const missing = (query: AccountingQuery) => {
    const entry = cache.entry(query);
    return !entry || entry.stale;
  };
  const needed = () => ({
    boot: booted.current || demo ? [] : bootQueries(ctx).filter(missing),
    reads: demo ? [] : viewQueries(view, ctx, initialFilter).filter(missing),
    chunk: !peekView(view),
  });
  const open = (n: ReturnType<typeof needed>) =>
    n.boot.length === 0 && n.reads.length === 0 && !n.chunk;
  const [gate, setGate] = useState(() => ({ key, ready: open(needed()) }));
  if (gate.key !== key) setGate({ key, ready: open(needed()) });
  const [step, setStep] = useState<1 | 2>(1);

  useEffect(() => {
    if (gate.ready) {
      booted.current = true;
      return;
    }
    let cancelled = false;
    const n = needed();
    setStep(n.boot.length > 0 ? 1 : 2);
    void (async () => {
      await Promise.allSettled(n.boot.map((query) => cache.read(query)));
      if (cancelled) return;
      setStep(2);
      await Promise.allSettled([
        loadView(view),
        ...n.reads.map((query) => cache.read(query)),
      ]);
      if (cancelled) return;
      booted.current = true;
      setGate((current) =>
        current.key === gate.key ? { key: current.key, ready: true } : current,
      );
    })();
    return () => {
      cancelled = true;
    };
    // What is needed is decided when the key changes, from that moment's context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.key, gate.ready, cache, view]);

  return { ready: gate.ready, step };
}
