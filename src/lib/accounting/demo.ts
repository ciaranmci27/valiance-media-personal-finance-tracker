import { fixtureAccountId, fixtureAccounts, fixtureEntries } from "./fixtures";
import type { AccountingWorkspace } from "./contracts";
import type { FeedData, FeedIdentity } from "./feeds";
import { RULE_NO_MAXIMUM, type RuleEvidenceRow, type RulesView } from "./rules";
import type { AccountProfile } from "./workflows";

/** A card the demo owner closed: it keeps its history and shows in the chart only. */
export const DEMO_CLOSED_CARD = {
  id: "20000000-0000-4000-8000-0000000000c1",
  code: "2010",
  name: "Cash Rewards card (6208)",
  account_type: "liability" as const,
  normal_side: "credit" as const,
  is_archived: false,
  closed_on: "2024-03-04",
};

/** Profiles for demo accounts the default chart does not carry. */
export const DEMO_EXTRA_PROFILES: AccountProfile[] = [
  {
    account_id: DEMO_CLOSED_CARD.id,
    version: 4,
    purpose: null,
    cash_kind: "card",
    parent_account_id: null,
    subtype: "card",
    closed_on: DEMO_CLOSED_CARD.closed_on,
    last_activity_on: DEMO_CLOSED_CARD.closed_on,
  },
];

/** Fixed, independently checked fixture report. Never used for live reporting. */
export function getAccountingDemo(): AccountingWorkspace {
  const opening = [
    "1200000",
    "0",
    "0",
    "-1000000",
    "-200000",
    "0",
    "0",
    "0",
    "0",
    "0",
  ];
  const debits = [
    "200000",
    "50000",
    "12000",
    "0",
    "10000",
    "15000",
    "100000",
    "100000",
    "50000",
    "0",
  ];
  const credits = [
    "172000",
    "50000",
    "12000",
    "0",
    "200000",
    "0",
    "0",
    "100000",
    "0",
    "3000",
  ];
  const accounts = fixtureAccounts.map((a) => ({ ...a, is_archived: false }));
  return {
    legal_name: "Synthetic company",
    revision: "0",
    from: "2026-01-01",
    to: "2026-02-28",
    accounts: [...accounts, DEMO_CLOSED_CARD],
    entry_count: 9,
    draft_count: 0,
    needs_review_count: 0,
    sync_due: false,
    entries: fixtureEntries
      .slice(2)
      .map((e, i) => ({
        id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        entry_date: e.date,
        memo: e.memo,
        status: "posted" as const,
        version: 2,
        primary_origin: "manual",
        source_description: null,
        descriptor_key: null,
        prior_treatment: null,
        reverses_entry_id: null,
        reversed_by_entry_id: null,
        created_at: `${e.date}T12:00:00Z`,
        lines: e.lines.map(([n, amount], j) => ({
          id: `${i}-${j}`,
          account_id: fixtureAccounts[Number(n) - 1].id,
          amount_cents: amount,
          memo: "",
        })),
      }))
      .reverse(),
    balances: [
      ...accounts.map((a, i) => ({
        ...a,
        opening_cents: opening[i],
        debit_cents: debits[i],
        credit_cents: credits[i],
        period_cents: String(BigInt(debits[i]) - BigInt(credits[i])),
        ending_cents: String(
          BigInt(opening[i]) + BigInt(debits[i]) - BigInt(credits[i]),
        ),
      })),
      {
        ...DEMO_CLOSED_CARD,
        opening_cents: "0",
        debit_cents: "0",
        credit_cents: "0",
        period_cents: "0",
        ending_cents: "0",
      },
    ],
    reports: {
      income_cents: "190000",
      expense_cents: "115000",
      net_income_cents: "75000",
      assets_cents: "1278000",
      liabilities_cents: "3000",
      equity_cents: "1000000",
      retained_cents: "200000",
      year_income_cents: "75000",
      balance_difference_cents: "0",
      trial_balance_cents: "0",
    },
  };
}

/**
 * A fixed bank connection for the demo's Bank connections screen: checking
 * feeding normally, an American Express card that went quiet after a reissue
 * with its new number waiting to be linked, and the closed card's retired feed.
 */
export function getAccountingDemoFeeds(): FeedData {
  const connection = "50000000-0000-4000-8000-000000000001";
  const stamp = (date: string) =>
    String(Date.parse(`${date}T07:00:00Z`) / 1000);
  const link = (
    id: string,
    account_id: string,
    last: string | null,
    closed_on: string | null = null,
  ) => ({
    id,
    account_id,
    history_start: stamp("2024-01-01"),
    checkpoint: stamp(last ?? "2024-01-01"),
    posting_timezone: "America/Phoenix" as const,
    movement_sign: 1 as const,
    balance_sign: 1 as const,
    version: 2,
    can_edit_settings: false,
    is_closed: closed_on !== null,
    closed_on,
    last_movement_on: last,
    created_at: "2024-01-02T16:00:00Z",
  });
  const accounts = [
    link(
      "50000000-0000-4000-8000-0000000000b1",
      fixtureAccountId(1),
      "2026-02-26",
    ),
    link(
      "50000000-0000-4000-8000-0000000000b2",
      fixtureAccountId(3),
      "2026-01-14",
    ),
    link(
      "50000000-0000-4000-8000-0000000000b3",
      DEMO_CLOSED_CARD.id,
      "2024-03-04",
      "2024-03-04",
    ),
  ];
  const identity = (
    id: string,
    name: string,
    institution: string,
    balance: string,
    seenAt: string,
    account: (typeof accounts)[number] | null,
  ): FeedIdentity => ({
    id,
    connection_id: connection,
    provider_connection_id: "demo",
    provider_account_id: id,
    name,
    institution,
    currency: "USD",
    ownership: account ? "company" : "unreviewed",
    version: account ? account.version : 0,
    feed_account_id: account?.id ?? null,
    last_seen_at: "2026-02-27T15:00:00Z",
    seen_at: Number(stamp(seenAt)),
    account,
    balance: {
      balance_cents: balance,
      available_cents: null,
      balance_at: Number(stamp(seenAt)),
      issues: [],
      created_at: "2026-02-27T15:00:00Z",
    },
  });
  return {
    owner_id: "demo-owner",
    connections: [
      {
        id: connection,
        name: "Company banking",
        status: "active",
        version: 3,
        scheduled: true,
        next_sync_at: null,
        last_success_at: "2026-02-27T15:00:00Z",
        last_error: "",
        lease_until: null,
      },
    ],
    accounts,
    identities: [
      identity(
        "50000000-0000-4000-8000-0000000000b1",
        "Business Checking (-4410)",
        "Chase",
        "1228000",
        "2026-02-27",
        accounts[0],
      ),
      identity(
        "50000000-0000-4000-8000-0000000000b2",
        "Business Gold Card (-2005)",
        "American Express",
        "-3000",
        "2026-01-20",
        accounts[1],
      ),
      identity(
        "50000000-0000-4000-8000-0000000000b4",
        "Business Gold Card (-3007)",
        "American Express",
        "-48210",
        "2026-02-27",
        null,
      ),
      identity(
        "50000000-0000-4000-8000-0000000000b3",
        "Customized Cash Rewards (-6208)",
        "Bank of America",
        "0",
        "2024-03-04",
        accounts[2],
      ),
    ],
    runs: [],
    queue: accounts.map((a) => ({
      feed_account_id: a.id,
      ready: 0,
      pending: 0,
    })),
    worker: null,
  };
}

/**
 * Fixed demo rules: one an agent suggested, one of the owner's that is on,
 * and one an edit paused. Enough for every state on the Rules screen.
 */
export function getAccountingDemoRules(): RulesView {
  const rule = {
    priority: 100,
    description_mode: "contains" as const,
    match_payee_id: null,
    assign_payee_id: null,
    reason: "",
  };
  return {
    revision: "0",
    aliases: [],
    rules: [
      {
        ...rule,
        id: "40000000-0000-4000-8000-000000000001",
        version: 1,
        name: "Northwind Traders receipts",
        enabled: false,
        description: "NORTHWIND TRADERS",
        bank_account_id: fixtureAccountId(1),
        direction: "increase",
        min_cents: "0",
        max_cents: RULE_NO_MAXIMUM,
        category_account_id: fixtureAccountId(5),
        review_status: "suggested",
        suggested_by: "40000000-0000-4000-8000-0000000000a1",
        suggested_by_name: "Alex A.",
        paused: { cause: "never_on", at: "2026-02-26T16:00:00Z" },
        suggestion: {
          matches: 3,
          posted: 3,
          in_category: 3,
          ready: 0,
          note: "Verified three posted imported receipts with this exact descriptor (NORTHWIND TRADERS ACH CREDIT). Prior treatment confirms count 3 in Consulting revenue; no conflicting rule or alias matches.",
        },
      },
      {
        ...rule,
        id: "40000000-0000-4000-8000-000000000002",
        version: 3,
        name: "Figma seats",
        priority: 10,
        enabled: true,
        description: "FIGMA",
        bank_account_id: fixtureAccountId(1),
        direction: "decrease",
        min_cents: "0",
        max_cents: "50000",
        category_account_id: fixtureAccountId(6),
        review_status: "confirmed",
        suggested_by: null,
        suggested_by_name: null,
        paused: null,
        suggestion: null,
      },
      {
        ...rule,
        id: "40000000-0000-4000-8000-000000000003",
        version: 4,
        name: "Hosting",
        priority: 20,
        enabled: false,
        description: "AMAZON WEB SERVICES",
        bank_account_id: fixtureAccountId(1),
        direction: "decrease",
        min_cents: "10000",
        max_cents: RULE_NO_MAXIMUM,
        category_account_id: fixtureAccountId(6),
        review_status: "confirmed",
        suggested_by: null,
        suggested_by_name: null,
        paused: { cause: "edited", at: "2026-02-20T17:00:00Z" },
        suggestion: null,
      },
    ],
  };
}

/** The demo suggestion's past matches: three deposits already in Consulting revenue. */
export function getAccountingDemoRuleEvidence(ruleId: string): {
  total: number;
  rows: RuleEvidenceRow[];
} {
  if (ruleId !== "40000000-0000-4000-8000-000000000001")
    return { total: 0, rows: [] };
  const rows = ["2026-02-03", "2026-01-05", "2025-12-04"].map((date, i) => ({
    id: `40000000-0000-4000-8000-0000000001${i}0`,
    entry_date: date,
    status: "posted",
    bank_account_id: fixtureAccountId(1),
    bank_amount_cents: "450000",
    lines: [
      { account_id: fixtureAccountId(1), amount_cents: "450000", memo: "" },
      { account_id: fixtureAccountId(5), amount_cents: "-450000", memo: "" },
    ],
  }));
  return { total: rows.length, rows };
}
