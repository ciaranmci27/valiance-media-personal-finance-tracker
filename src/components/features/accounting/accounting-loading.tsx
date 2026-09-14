"use client";

import { AppLoading } from "@/components/ui/app-loading";

/**
 * What the loader reads while the books open, one line per phase. The first
 * line is the workspace boot screen's own, so the books carry on from it.
 */
export const BOOT_STEPS = [
  "Opening your workspace",
  "Loading accounts and feeds",
  "Preparing the view",
] as const;

/** The books' loading screen: the workspace loader with the books' lines. */
export function AccountingLoading({
  steps = BOOT_STEPS,
  announcement = "Loading the books",
  ...props
}: {
  steps?: readonly string[];
  step?: number;
  announcement?: string;
  leaving?: boolean;
  continuing?: boolean;
  onLeft?: () => void;
}) {
  return <AppLoading steps={steps} announcement={announcement} {...props} />;
}
