"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
  /** When true, renders children directly without tooltip functionality */
  disabled?: boolean;
}

export function Tooltip({
  children,
  content,
  position = "top",
  delay = 200,
  className,
  disabled = false,
}: TooltipProps) {
  // When disabled, render children directly without any wrapper
  if (disabled) {
    return <>{children}</>;
  }
  const [isVisible, setIsVisible] = React.useState(false);
  const [shouldRender, setShouldRender] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [coords, setCoords] = React.useState({ top: 0, left: 0 });
  const [actualPosition, setActualPosition] = React.useState(position);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const tooltipRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const calculatePosition = React.useCallback(() => {
    if (!triggerRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    const tooltipWidth = tooltipEl?.offsetWidth || 0;
    const tooltipHeight = tooltipEl?.offsetHeight || 0;
    const padding = 8; // Gap between trigger and tooltip
    const viewportPadding = 8; // Minimum distance from viewport edges

    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    // Calculate positions for each direction
    const positions = {
      top: {
        top: triggerRect.top - tooltipHeight - padding,
        left: triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2,
      },
      bottom: {
        top: triggerRect.bottom + padding,
        left: triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2,
      },
      left: {
        top: triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2,
        left: triggerRect.left - tooltipWidth - padding,
      },
      right: {
        top: triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2,
        left: triggerRect.right + padding,
      },
    };

    // Check if position fits in viewport
    const fitsInViewport = (pos: "top" | "bottom" | "left" | "right") => {
      const coords = positions[pos];
      switch (pos) {
        case "top":
          return coords.top >= viewportPadding;
        case "bottom":
          return coords.top + tooltipHeight <= viewport.height - viewportPadding;
        case "left":
          return coords.left >= viewportPadding;
        case "right":
          return coords.left + tooltipWidth <= viewport.width - viewportPadding;
      }
    };

    // Determine the best position
    let bestPosition = position;

    if (!fitsInViewport(position)) {
      // Try opposite direction first
      const opposites: Record<string, "top" | "bottom" | "left" | "right"> = {
        top: "bottom",
        bottom: "top",
        left: "right",
        right: "left",
      };

      if (fitsInViewport(opposites[position])) {
        bestPosition = opposites[position];
      } else {
        // Try all positions and pick the first that fits
        const allPositions: ("top" | "bottom" | "left" | "right")[] = ["bottom", "top", "right", "left"];
        for (const pos of allPositions) {
          if (fitsInViewport(pos)) {
            bestPosition = pos;
            break;
          }
        }
      }
    }

    let { top, left } = positions[bestPosition];

    // Clamp horizontal position to stay within viewport
    if (bestPosition === "top" || bestPosition === "bottom") {
      left = Math.max(viewportPadding, Math.min(left, viewport.width - tooltipWidth - viewportPadding));
    }

    // Clamp vertical position to stay within viewport
    if (bestPosition === "left" || bestPosition === "right") {
      top = Math.max(viewportPadding, Math.min(top, viewport.height - tooltipHeight - viewportPadding));
    }

    setActualPosition(bestPosition);
    setCoords({ top, left });
  }, [position]);

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      setShouldRender(true);
      requestAnimationFrame(() => {
        calculatePosition();
        setIsVisible(true);
      });
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
    setTimeout(() => setShouldRender(false), 150);
  };

  React.useEffect(() => {
    if (!shouldRender) return;

    const handleReposition = () => calculatePosition();
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);

    return () => {
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [shouldRender, calculatePosition]);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Reset actual position when preferred position changes
  React.useEffect(() => {
    setActualPosition(position);
  }, [position]);

  const tooltipContent = shouldRender && mounted ? (
    <div
      ref={tooltipRef}
      role="tooltip"
      className={cn(
        "fixed z-[9999] pointer-events-none transition-all duration-150 ease-out",
        isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"
      )}
      style={{ top: coords.top, left: coords.left }}
    >
      <div className="relative px-2.5 py-1.5 text-xs font-medium text-foreground bg-card rounded-md shadow-lg border border-border whitespace-nowrap">
        {content}
      </div>
    </div>
  ) : null;

  return (
    <span
      ref={triggerRef}
      className={cn("relative inline-flex", className)}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {mounted && tooltipContent && createPortal(tooltipContent, document.body)}
    </span>
  );
}
