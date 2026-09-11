"use client";

import { cn } from "@/lib/utils";
import { INSTITUTION_ICONS } from "@/lib/institution-icons";

/**
 * One tile for every place a bank or card account appears. The institution
 * comes from the feed when the account is mapped, and from the account's own
 * name until then. Known brands get their mark on a brand-colored tile;
 * everything else gets a two-letter monogram so the row still scans.
 */

type Resolved = {
  slug: string | null;
  title: string;
  color: string;
};

/** Brands without a glyph in the icon set still get their color for the monogram tile. */
const BRAND_COLORS: Record<string, { title: string; color: string }> = {
  capitalone: { title: "Capital One", color: "#004977" },
  mercury: { title: "Mercury", color: "#1f1f3d" },
  citi: { title: "Citi", color: "#003b70" },
  usbank: { title: "U.S. Bank", color: "#0c2074" },
  pnc: { title: "PNC", color: "#f58025" },
  truist: { title: "Truist", color: "#4b286d" },
  ally: { title: "Ally", color: "#6e2585" },
  schwab: { title: "Charles Schwab", color: "#00a0df" },
  fidelity: { title: "Fidelity", color: "#4f8a10" },
  novo: { title: "Novo", color: "#1a1a1a" },
  bluevine: { title: "Bluevine", color: "#0a6cff" },
  relay: { title: "Relay", color: "#1d4ed8" },
  td: { title: "TD Bank", color: "#54b848" },
  square: { title: "Square", color: "#1a1a1a" },
};

/** Ordered keyword rules. The first match wins, so brand names come before product names. */
const RULES: [RegExp, string][] = [
  [/american\s*express|\bamex\b|cash magnet|blue cash/i, "americanexpress"],
  [
    /\bchase\b|jp\s?morgan|bus(iness)? complete chk|business complete/i,
    "chase",
  ],
  [
    /bank of america|\bbofa\b|business adv(antage)?|customized cash rewards|\bcorp account\b/i,
    "bankofamerica",
  ],
  [/wells\s*fargo/i, "wellsfargo"],
  [/capital\s*one/i, "capitalone"],
  [/\bmercury\b/i, "mercury"],
  [/\bbrex\b/i, "brex"],
  [/\bstripe\b/i, "stripe"],
  [/\bpaypal\b/i, "paypal"],
  [/\bvenmo\b/i, "venmo"],
  [/\bdiscover\b/i, "discover"],
  [/\brobinhood\b/i, "robinhood"],
  [/\bcoinbase\b/i, "coinbase"],
  [/\brevolut\b/i, "revolut"],
  [/\bwise\b|transferwise/i, "wise"],
  [/\bshopify\b/i, "shopify"],
  [/\bciti(bank)?\b/i, "citi"],
  [/u\.?s\.? bank/i, "usbank"],
  [/\bpnc\b/i, "pnc"],
  [/\btruist\b/i, "truist"],
  [/\bally\b/i, "ally"],
  [/schwab/i, "schwab"],
  [/fidelity/i, "fidelity"],
  [/\bnovo\b/i, "novo"],
  [/bluevine/i, "bluevine"],
  [/\brelay\b/i, "relay"],
  [/\btd bank\b|\btd\b/i, "td"],
  [/\bsquare\b/i, "square"],
];

export function resolveInstitution(
  ...sources: (string | null | undefined)[]
): Resolved {
  for (const text of sources) {
    if (!text) continue;
    for (const [pattern, slug] of RULES) {
      if (!pattern.test(text)) continue;
      const icon = INSTITUTION_ICONS[slug];
      if (icon) return { slug, title: icon.title, color: icon.color };
      const brand = BRAND_COLORS[slug];
      if (brand) return { slug: null, title: brand.title, color: brand.color };
    }
  }
  const fallback = sources.find((s) => s && s.trim()) ?? "";
  return { slug: null, title: fallback.trim(), color: "" };
}

function monogram(text: string) {
  const words = text
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function InstitutionLogo({
  institution,
  name,
  size = 32,
  className,
}: {
  /** Institution as reported by the bank feed, when the account is mapped. */
  institution?: string | null;
  /** The account's own name, used to infer the institution before mapping. */
  name?: string | null;
  /** Tile edge in pixels. */
  size?: number;
  className?: string;
}) {
  const resolved = resolveInstitution(institution, name);
  const icon = resolved.slug ? INSTITUTION_ICONS[resolved.slug] : null;
  const radius = size >= 40 ? "rounded-xl" : "rounded-lg";
  const label = resolved.title || name || "Account";
  if (icon)
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden shadow-[inset_0_0_0_1px_rgba(var(--ink),0.14)]",
          radius,
          className,
        )}
        style={{ width: size, height: size, backgroundColor: icon.color }}
      >
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.58)}
          height={Math.round(size * 0.58)}
          aria-hidden="true"
          focusable="false"
        >
          <path d={icon.path} fill="#ffffff" />
        </svg>
      </span>
    );
  const branded = Boolean(resolved.color);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center font-semibold uppercase tracking-wide shadow-[inset_0_0_0_1px_rgba(var(--ink),0.14)]",
        radius,
        branded ? "text-white" : "bg-primary/12 text-teal-light",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.34)),
        ...(branded ? { backgroundColor: resolved.color } : {}),
      }}
    >
      {monogram(label)}
    </span>
  );
}
