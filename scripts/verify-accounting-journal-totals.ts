import assert from "node:assert/strict";
import { journalTotals } from "../src/lib/accounting/money";

const payroll = ["350000", "26775", "-288642", "-88133"].map(
  (amount_cents) => ({ amount_cents }),
);
assert.deepEqual(journalTotals(payroll), {
  debit: BigInt(376775),
  credit: BigInt(376775),
});
const unbalanced = journalTotals(payroll.slice(0, -1));
assert.equal(unbalanced.debit - unbalanced.credit, BigInt(88133));
const reversal = journalTotals(
  payroll
    .slice(0, -1)
    .map((line) => ({ amount_cents: (-BigInt(line.amount_cents)).toString() })),
);
assert.equal(reversal.debit, unbalanced.credit);
assert.equal(reversal.credit, unbalanced.debit);
assert.deepEqual(journalTotals([]), { debit: BigInt(0), credit: BigInt(0) });
const large = "9223372036854775807";
assert.deepEqual(
  journalTotals([
    { amount_cents: large },
    { amount_cents: large },
    { amount_cents: `-${large}` },
    { amount_cents: `-${large}` },
  ]),
  { debit: BigInt(large) * BigInt(2), credit: BigInt(large) * BigInt(2) },
);
console.log(
  "Journal totals: payroll, imbalance, reversal, empty entry, and exact large totals passed.",
);
