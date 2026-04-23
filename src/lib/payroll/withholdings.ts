// Withholding line-item categorization.
//
// Splits a list of WithholdingLineItems into the three buckets the engine
// needs to adjust taxable-wage bases:
//
//   - preTax401k: reduces FIT + SIT wages (not FICA/FUTA/SUTA)
//   - preTax125:  reduces FIT + SIT + FICA + FUTA + SUTA wages
//   - postTax:    reduces net pay only (no tax base impact)
//
// Legacy items with no `category` field are treated as post_tax to preserve
// the pre-change behavior for runs finalized before pre-tax support landed.

import type { WithholdingLineItem } from "@/types/payroll";

export interface WithholdingSplit {
  preTax401k: number;
  preTax125: number;
  postTax: number;
  /** Sum of all three buckets - equals the amount subtracted from net pay. */
  total: number;
}

export function splitWithholdings(
  items: WithholdingLineItem[] | undefined | null,
): WithholdingSplit {
  let preTax401k = 0;
  let preTax125 = 0;
  let postTax = 0;
  for (const item of items ?? []) {
    const amount = Math.max(0, Number(item.amount) || 0);
    if (amount === 0) continue;
    const category = item.category ?? "post_tax";
    if (category === "pre_tax_401k") preTax401k += amount;
    else if (category === "pre_tax_125") preTax125 += amount;
    else postTax += amount;
  }
  return {
    preTax401k,
    preTax125,
    postTax,
    total: preTax401k + preTax125 + postTax,
  };
}
