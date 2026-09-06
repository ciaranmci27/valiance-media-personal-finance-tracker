import assert from "node:assert/strict";
import {
  parseUsd,
  readCents,
  formatCents,
  allocateCents,
} from "../src/lib/accounting/money";
import { dateSchema, requestSchema } from "../src/lib/accounting/contracts";
import { rulesCommandSchema } from "../src/lib/accounting/rules";
import { closeCommandSchema } from "../src/lib/accounting/close";
import { statementCommandSchema } from "../src/lib/accounting/statement-files";

let checks = 0;
for (const [text, expected] of [
  ["10", "1000"],
  ["10.5", "1050"],
  ["-0.01", "-1"],
  ["10.50000", "1050"],
  ["92233720368547758.07", "9223372036854775807"],
]) {
  assert.equal(parseUsd(text).toString(), expected);
  checks++;
}
for (const text of [
  "1.001",
  "NaN",
  "1e3",
  "1,200.00",
  "",
  "Infinity",
  "92233720368547758.08",
  "--1",
]) {
  assert.throws(() => parseUsd(text));
  checks++;
}
assert.equal(formatCents("9007199254740993"), "$90,071,992,547,409.93");
checks++;
assert.throws(() => readCents("-9223372036854775808"));
checks++;
assert.equal(dateSchema.safeParse("2026-02-29").success, false);
checks++;
assert.equal(dateSchema.safeParse("2024-02-29").success, true);
checks++;
assert.equal(
  requestSchema.safeParse({ key: "fake", command: { type: "period.lock" } })
    .success,
  false,
);
checks++;
for (let amount = -1000; amount <= 1000; amount += 7) {
  const total = BigInt(amount);
  const result = allocateCents(total, [BigInt(1), BigInt(2), BigInt(3)]);
  assert.equal(
    result.reduce((a, b) => a + b, BigInt(0)),
    total,
  );
  assert.ok(
    result.every((n) => (total < BigInt(0) ? n <= BigInt(0) : n >= BigInt(0))),
  );
  checks += 2;
}
assert.deepEqual(allocateCents(BigInt(1), [BigInt(1), BigInt(1)]), [
  BigInt(1),
  BigInt(0),
]);
checks++;
const uuid = "20000000-0000-4000-8000-000000000001";
for (const invalid of [
  "garbage",
  "1.3",
  "1e3",
  "Infinity",
  "",
  "9223372036854775808",
  "-9223372036854775808",
]) {
  const controls = {
    id: uuid,
    from: "2026-01-01",
    to: "2026-01-31",
    document_id: uuid,
    opening_cents: "0",
    ending_cents: "0",
    declared_count: 1,
    declared_debits_cents: invalid,
    declared_credits_cents: "0",
    predecessor_id: null,
  };
  assert.equal(
    closeCommandSchema.safeParse({
      ...controls,
      type: "reconciliation.create",
      account_id: uuid,
    }).success,
    false,
  );
  assert.equal(
    statementCommandSchema.safeParse({
      ...controls,
      type: "statement.amend",
      expected_version: 1,
      notes: "",
      reason: "Invalid input regression",
    }).success,
    false,
  );
  assert.equal(
    rulesCommandSchema.safeParse({
      type: "rule.save",
      id: uuid,
      expected_version: 0,
      name: "Validation",
      priority: 10,
      description_mode: "prefix",
      description: "test",
      bank_account_id: uuid,
      direction: "decrease",
      min_cents: "0",
      max_cents: invalid,
      match_payee_id: null,
      category_account_id: uuid,
      assign_payee_id: null,
      reason: "Invalid input regression",
    }).success,
    false,
  );
  checks += 3;
}
console.log(`Accounting money/contracts: ${checks} checks passed.`);
