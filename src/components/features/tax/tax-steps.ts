/**
 * What the loader reads while the estimator opens: the workspace line first,
 * then the books. Shared by the route fallback and the page so the line
 * carries on across the hand-off.
 */
export const TAX_STEPS = [
  "Opening your workspace",
  "Reading the books",
] as const;
