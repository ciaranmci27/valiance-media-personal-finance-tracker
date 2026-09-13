import assert from "node:assert/strict";
import { accountBalances } from "../src/lib/accounting/account-balances";
import { getAccountingDemo } from "../src/lib/accounting/demo";
import type { FeedData } from "../src/lib/accounting/feeds";
import type { AccountProfile } from "../src/lib/accounting/workflows";

const data = getAccountingDemo();
const bank = data.balances[0],
  card = data.balances[2];
bank.ending_cents = "1353109";
card.ending_cents = "-499";
const profiles: AccountProfile[] = [bank, card].map((a) => ({
  account_id: a.id,
  version: 1,
  cash_kind: a === bank ? "bank" : "card",
  purpose: null,
  parent_account_id: null,
  subtype: "",
}));
const feeds: FeedData = {
  owner_id: "fixture",
  connections: [],
  runs: [],
  queue: [],
  accounts: [bank, card].map((a) => ({
    id: a.id,
    account_id: a.id,
    history_start: "1",
    checkpoint: null,
    posting_timezone: "UTC",
    movement_sign: 1,
    balance_sign: a === card ? -1 : 1,
    version: 1,
    can_edit_settings: true,
  })),
  identities: [bank, card].map((a) => ({
    id: a.id,
    connection_id: "old",
    provider_connection_id: "old",
    provider_account_id: a.id,
    name: a.name,
    institution: "Fixture bank",
    currency: "USD",
    ownership: "company",
    version: 1,
    feed_account_id: a.id,
    last_seen_at: "2026-09-11T12:00:00Z",
    account: null,
    balance: {
      balance_cents: a === card ? "-2136" : "2845076",
      available_cents: null,
      balance_at: 1789160400,
      issues: [],
      created_at: "2026-09-11T12:00:00Z",
    },
  })),
};
let result = accountBalances(data.balances, profiles, feeds);
assert.equal(result.get(bank.id)?.amount, BigInt(2845076));
assert.equal(result.get(bank.id)?.book, BigInt(1353109));
assert.equal(
  result.get(card.id)?.amount,
  BigInt(2136),
  "Use the configured provider balance sign once",
);
assert.equal(
  result.get(card.id)?.book,
  BigInt(499),
  "Card book balances use the credit-side convention",
);
bank.ending_cents = "2845076";
result = accountBalances(data.balances, profiles, feeds);
assert.equal(
  result.get(bank.id)?.amount,
  BigInt(2845076),
  "Reviewing transactions cannot double-count receipts in the bank balance",
);
assert.equal(result.get(bank.id)?.observedAt, 1789160400);
feeds.identities[0].balance!.balance_cents = "0";
assert.equal(
  accountBalances(data.balances, profiles, feeds).get(bank.id)?.amount,
  BigInt(0),
  "A reported zero is a real balance",
);
feeds.identities[0].balance!.balance_cents = null;
result = accountBalances(data.balances, profiles, feeds);
assert.equal(result.get(bank.id)?.bank, null);
assert.equal(
  result.get(bank.id)?.amount,
  BigInt(2845076),
  "Missing bank observations fall back to labeled book balances",
);
assert.equal(
  accountBalances(data.balances, profiles, null).get(card.id)?.amount,
  BigInt(499),
);
console.log(
  "Accounting balances: bank observations, review independence, zero, card signs, timestamps, and missing-feed fallback passed.",
);
