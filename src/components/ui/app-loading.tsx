"use client";

import { useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BrandLoader } from "@/components/ui/brand-loader";
import { cn } from "@/lib/utils";

const subscribe = () => () => {};

/**
 * The loading screen taking over the whole viewport: the brand loader
 * centred on the page's own canvas, with nothing else showing. When the page
 * is ready the overlay fades as the emblem dissolves, and the finished page
 * is underneath.
 *
 * Page content sits in a wrapper with its own stacking order under the
 * sidebar, so on the client the overlay is portalled to the body, where it
 * covers everything. The server pass renders it in place; hydration swaps
 * it out without replaying the arrival. `continuing` says another loader was
 * just on screen in the same place, so neither the fade-in nor the emblem's
 * arrival plays again. `fadeIn` false makes the overlay opaque from its first
 * frame (the emblem still arrives): for a loader that must never let the
 * page underneath show through, such as the boot screen.
 */
export function AppLoading({
  steps,
  step,
  announcement = "Loading",
  leaving,
  continuing,
  fadeIn = true,
  onLeft,
}: {
  steps: readonly string[];
  step?: number;
  announcement?: string;
  leaving?: boolean;
  continuing?: boolean;
  fadeIn?: boolean;
  onLeft?: () => void;
}) {
  const host = useSyncExternalStore(
    subscribe,
    () => document.body,
    () => null,
  );
  // Hydration renders the server's inline copy first, then the portal takes
  // over in the next render: that swap must not replay the arrival.
  const startedInline = useRef(host === null).current;
  const quiet = continuing || (startedInline && host !== null);
  const overlay = (
    <div
      className={cn(
        "brand-loader-overlay",
        leaving && "is-leaving",
        quiet && "is-continuing",
        !fadeIn && "is-instant",
      )}
    >
      <BrandLoader
        steps={steps}
        step={step}
        announcement={announcement}
        leaving={leaving}
        continuing={quiet}
        onLeft={onLeft}
      />
    </div>
  );
  return host ? createPortal(overlay, host) : overlay;
}
