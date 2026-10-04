"use client";

import { useEffect, useState } from "react";
import { loadBusinessProfile } from "@/lib/business-profile";
import { normalizeMonth } from "@/lib/accounting/fiscal-year";

/**
 * The fiscal year's start month from the business settings (the record the
 * Business settings screen edits), read when the report opens so a change
 * there shows at once. January until it has loaded, when it cannot be read,
 * and in the demo.
 */
export function useFiscalStartMonth(demo = false): number {
  const [month, setMonth] = useState(1);
  useEffect(() => {
    if (demo) return;
    let alive = true;
    loadBusinessProfile()
      .then((r) => alive && setMonth(normalizeMonth(r.profile.fiscal_year_start_month)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [demo]);
  return month;
}
