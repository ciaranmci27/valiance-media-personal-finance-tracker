'use client';

import { useLayoutEffect, useState, type Ref, type RefCallback, type RefObject } from 'react';

export type InputSize = 'sm' | 'default' | 'lg';

/** Shared border, surface and focus treatment for every field in the bank. */
export function fieldChrome(error?: string, disabled?: boolean): string {
  return [
    'rounded-input border bg-input-bg text-input-text transition-colors duration-150 motion-reduce:transition-none',
    error
      ? 'border-input-border-error focus-within:border-input-border-error focus-within:ring-2 focus-within:ring-input-ring-error'
      : 'border-input-border hover:border-input-border-hover focus-within:border-input-border-focus focus-within:ring-2 focus-within:ring-input-ring',
    disabled ? 'cursor-not-allowed opacity-50 bg-input-bg-disabled' : '',
  ].join(' ');
}

/** The 1px border completes the 28px, 36px and 44px control heights. */
export function fieldSize(size: InputSize): string {
  return size === 'sm'
    ? 'py-[5px] text-xs'
    : size === 'lg'
      ? 'py-[9px] text-base'
      : 'py-[7px] text-sm';
}

/** Shared viewport placement, derived from MultiSelect's portal positioning. */
export function popupPosition(trigger: HTMLElement, maxHeight = 280, minWidth = 0) {
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 8;
  const above = rect.top - 8;
  const openAbove = below < maxHeight && above > below;
  const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - 16);
  return {
    top: openAbove ? rect.top - 4 : rect.bottom + 4,
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    width,
    maxHeight: Math.max(80, Math.min(maxHeight, openAbove ? above : below)),
    openAbove,
  };
}

export const popupChrome =
  'fixed inset-auto m-0 z-[9999] overflow-auto rounded-input border border-input-border bg-surface-overlay text-input-text shadow-[var(--shadow-overlay)]';

/** Keep a portal in its dialog's focus scope. The native top layer escapes
 * overflow clipping and transformed ancestors without moving focus outside it. */
export function useInputPopup(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
) {
  const [host, setHost] = useState<Element | null>(null);
  const prepare = () => {
    setHost(trigger.current?.closest('[role="dialog"]') || document.body);
  };
  useLayoutEffect(() => {
    if (!open || !host) return;
    const element = popup.current;
    element?.showPopover?.();
    return () => {
      if (element?.isConnected) element.hidePopover?.();
    };
  }, [open, host, popup]);
  return { host, prepare };
}

/**
 * Merge multiple refs into a single ref callback.
 * Supports both callback refs and RefObject refs.
 */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined | null>): RefCallback<T> {
  return (node) => {
    refs.forEach((ref) => {
      if (!ref) return;
      if (typeof ref === 'function') ref(node);
      else (ref as { current: T | null }).current = node;
    });
  };
}

/**
 * Return the Tailwind text-size class for a label based on input size.
 */
export function labelSizeClass(size: 'sm' | 'default' | 'lg'): string {
  if (size === 'sm') return 'text-xs';
  if (size === 'lg') return 'text-base';
  return 'text-sm';
}

/**
 * Inject shared keyframe animations into the document head.
 * Safe to call multiple times; only injects once.
 * Must be called from useEffect (client-side only).
 */
let animationsInjected = false;

export function injectAnimations(): void {
  if (typeof document === 'undefined') return;
  // Check both module flag and DOM to handle HMR re-evaluation
  if (animationsInjected || document.querySelector('style[data-ui-inputs]')) {
    animationsInjected = true;
    return;
  }
  animationsInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-ui-inputs', '');
  style.textContent = [
    '@keyframes ui-check-pop { 0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); } }',
    '@keyframes ui-radio-pop { 0% { transform: scale(0); } 60% { transform: scale(1.3); } 100% { transform: scale(1); } }',
  ].join('\n');
  document.head.appendChild(style);
}
