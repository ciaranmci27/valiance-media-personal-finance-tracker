"use client";

import * as React from "react";
import { usePrivacy } from "@/contexts/privacy-context";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";

interface MaskedValueProps {
  value: string | number;
  className?: string;
  /** Custom mask character pattern. Default: "•••••" */
  mask?: string;
  /** If true, the entire parent element handles hover reveal */
  inheritHover?: boolean;
}

/**
 * MaskedValue component that hides sensitive financial data.
 * - Shows masked value (•••••) when privacy mode is enabled
 * - Reveals actual value on hover
 * - Smooth transition between states
 */
export function MaskedValue({
  value,
  className,
  mask = "•••••",
  inheritHover = false,
}: MaskedValueProps) {
  const { isHidden } = usePrivacy();
  const [isHovered, setIsHovered] = React.useState(false);
  const [isRevealed, setIsRevealed] = React.useState(false);

  // Handle hover with slight delay for smoother UX
  React.useEffect(() => {
    if (isHovered && isHidden) {
      const timer = setTimeout(() => setIsRevealed(true), 50);
      return () => clearTimeout(timer);
    } else {
      setIsRevealed(false);
    }
  }, [isHovered, isHidden]);

  // If not hidden, just render the value directly
  if (!isHidden) {
    return <span className={className}>{value}</span>;
  }

  // Calculate if we should show the real value
  const showValue = isRevealed || !isHidden;

  // For inherited hover, we don't add our own hover handlers
  // The parent component should use data-privacy-hover attribute
  if (inheritHover) {
    return (
      <span
        className={cn(
          "transition-opacity duration-150",
          className
        )}
        data-masked="true"
      >
        {showValue ? value : mask}
      </span>
    );
  }

  const spanElement = (
    <span
      className={cn(
        "transition-opacity duration-150 cursor-default",
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {showValue ? value : mask}
    </span>
  );

  if (isHidden && !isRevealed) {
    return (
      <Tooltip content="Hover to reveal">
        {spanElement}
      </Tooltip>
    );
  }

  return spanElement;
}

/**
 * Hook for creating hover-to-reveal containers.
 * Use this when you want an entire card/row to reveal values on hover.
 */
export function useMaskedHover() {
  const { isHidden } = usePrivacy();
  const [isHovered, setIsHovered] = React.useState(false);

  const hoverProps = React.useMemo(
    () =>
      isHidden
        ? {
            onMouseEnter: () => setIsHovered(true),
            onMouseLeave: () => setIsHovered(false),
          }
        : {},
    [isHidden]
  );

  return {
    isHidden,
    isRevealed: isHovered,
    showValue: !isHidden || isHovered,
    hoverProps,
  };
}

/**
 * Simple utility to format a value as masked or real
 */
export function getMaskedValue(
  value: string | number,
  isHidden: boolean,
  isRevealed: boolean,
  mask = "•••••"
): string {
  if (!isHidden || isRevealed) {
    return String(value);
  }
  return mask;
}
