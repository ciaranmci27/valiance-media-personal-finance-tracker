import { cn } from "@/lib/utils";

/**
 * A tiny trend line, ported from the app's Sparkline. Colored through
 * currentColor so it themes for free; the baseline floor is min(0, lowest
 * point), so a profit series that dips below zero keeps its shape. Purely
 * decorative: the figure it sits beside carries the meaning.
 */
export function Sparkline({
  data,
  className,
  width = 72,
  height = 22,
}: {
  data: number[];
  className?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2 || data.every((v) => v === 0)) return null;
  const pad = 2;
  const min = Math.min(0, ...data);
  const span = Math.max(Number.EPSILON, Math.max(...data) - min);
  const points = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - pad - ((v - min) / span) * (height - pad * 2),
  ]);
  const [lx, ly] = points[points.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", className)}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lx.toFixed(1)} cy={ly.toFixed(1)} r="2.25" fill="currentColor" />
    </svg>
  );
}
