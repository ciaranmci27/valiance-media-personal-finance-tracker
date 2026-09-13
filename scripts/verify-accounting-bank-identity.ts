import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bankIdentitiesByAccount } from "../src/lib/accounting/bank-identity";
import type {
  FeedConnection,
  FeedData,
  FeedIdentity,
} from "../src/lib/accounting/feeds";
import {
  AccountingAccountLabel,
  AccountingBankIdentityProvider,
} from "../src/components/features/accounting/accounting-bank-identity";

const connection = (
  id: string,
  status: FeedConnection["status"],
): FeedConnection => ({
  id,
  status,
  name: id,
  version: 1,
  scheduled: false,
  next_sync_at: null,
  last_success_at: null,
  last_error: "",
  lease_until: null,
});
const canonical = (
  id: string,
  account_id: string,
): FeedData["accounts"][number] => ({
  id,
  account_id,
  history_start: "1",
  checkpoint: null,
  posting_timezone: "UTC",
  movement_sign: 1,
  balance_sign: 1,
  version: 1,
  can_edit_settings: true,
});
const identity = (
  id: string,
  connection_id: string,
  feed_account_id: string | null,
  institution: string,
): FeedIdentity => ({
  id,
  connection_id,
  feed_account_id,
  institution,
  name: "Alex Morgan (2005)",
  provider_connection_id: connection_id,
  provider_account_id: id,
  currency: "USD",
  ownership: "company",
  version: 1,
  last_seen_at: "2026-09-11T12:00:00Z",
  account: null,
  balance: null,
});
const feeds: FeedData = {
  owner_id: "fixture-owner",
  connections: [
    connection("old", "disconnected"),
    connection("live", "active"),
    connection("reconnect", "reconnect_required"),
  ],
  accounts: [
    canonical("feed-card", "card"),
    canonical("feed-checking", "checking"),
  ],
  identities: [
    identity("old-card", "old", "feed-card", "Old bank"),
    identity("reconnect-card", "reconnect", "feed-card", "Reconnect bank"),
    identity("current-card", "live", "feed-card", "American Express"),
    identity("current-checking", "live", "feed-checking", "Chase Bank"),
    identity("unmapped", "live", null, "Bank of America"),
    identity("orphan", "live", "missing-feed", "Wells Fargo"),
  ],
  runs: [],
  queue: [],
};

const mapped = bankIdentitiesByAccount(feeds);
assert.equal(
  mapped.size,
  2,
  "Only explicit book-account mappings receive a bank identity",
);
assert.equal(mapped.get("card")?.institution, "American Express");
assert.equal(
  mapped.get("checking")?.institution,
  "Chase Bank",
  "Matching owner names must not merge banks",
);
assert.equal(
  bankIdentitiesByAccount({
    ...feeds,
    identities: [...feeds.identities].reverse(),
  }).get("card")?.id,
  "current-card",
);
assert.equal(
  bankIdentitiesByAccount({
    ...feeds,
    identities: feeds.identities.filter((i) => i.id !== "current-card"),
  }).get("card")?.id,
  "reconnect-card",
);
assert.equal(
  bankIdentitiesByAccount({ ...feeds, identities: [feeds.identities[0]] }).get(
    "card",
  )?.id,
  "old-card",
  "Disconnecting must preserve identity for historical entries",
);
assert.equal(bankIdentitiesByAccount(null).size, 0);

function label(
  accountId: string,
  name: string,
  feedState: FeedData | null = feeds,
) {
  return renderToStaticMarkup(
    createElement(AccountingBankIdentityProvider, {
      feeds: feedState,
      profiles: [],
      children: createElement(AccountingAccountLabel, {
        accountId,
        name,
        showInstitution: true,
      }),
    }),
  );
}
assert.match(
  label("card", "Alex Morgan (2005)"),
  /aria-label="American Express"/,
);
assert.match(label("checking", "Alex Morgan (2005)"), /aria-label="Chase"/);
assert.match(
  label("card", "Renamed business card"),
  /aria-label="American Express"/,
  "Renaming the book account must not lose its mapped logo",
);
assert.match(
  label("card", "AMEX card", null),
  /aria-label="American Express"/,
  "Unloaded feeds retain the existing name fallback",
);
assert.doesNotMatch(
  label("unmapped", "Alex Morgan (2005)"),
  /<svg/,
  "An unknown account must not borrow a logo from another account",
);
assert.match(
  label("card", "Alex Morgan (2005)"),
  />American Express<\//,
  "Details can display the mapped institution as text",
);
console.log(
  "Bank identity: 13 mapping, history, fallback, and rendered-logo checks passed.",
);
