import assert from "node:assert/strict";
import {
  categoryGroups,
  categoryKind,
  categoryMenu,
  isCategoryAccount,
} from "../src/lib/accounting/categories";
import { simpleTransactionLines } from "../src/lib/accounting/transactions";
import type { AccountingAccount } from "../src/lib/accounting/contracts";
import type { AccountProfile } from "../src/lib/accounting/workflows";

/**
 * The category menu is direction-aware: money in leads with income, money
 * out with expenses, the other side stays reachable under a closed refund
 * group, owner equity is its own closed group, and system accounts never
 * appear. Pure functions, no database.
 */
let checks = 0;
function check(name: string, ok: boolean) {
  assert.ok(ok, name);
  checks++;
}

type Seed = [
  id: string,
  code: string,
  name: string,
  type: AccountingAccount["account_type"],
  subtype: string,
  purpose?: string | null,
  archived?: boolean,
];
const seeds: Seed[] = [
  ["checking", "1000", "Checking", "asset", "bank", "checking"],
  ["card", "2100", "Business card", "liability", "card", "business_card"],
  [
    "undeposited",
    "1100",
    "Undeposited funds",
    "asset",
    "undeposited",
    "undeposited_funds",
  ],
  [
    "transit",
    "1200",
    "Transfers in transit",
    "asset",
    "transit",
    "transfers_in_transit",
  ],
  ["receivable", "1300", "Accounts receivable", "asset", "receivable"],
  ["equipment", "1500", "Equipment", "asset", "fixed_asset"],
  [
    "accum",
    "1510",
    "Accumulated depreciation",
    "asset",
    "accumulated_depreciation",
  ],
  ["loan", "2600", "Loans payable", "liability", "loan"],
  [
    "payroll",
    "2400",
    "Payroll taxes payable",
    "liability",
    "payroll_liability",
  ],
  [
    "contrib",
    "3100",
    "Shareholder contributions",
    "equity",
    "owner_equity",
    "contributions",
  ],
  [
    "distrib",
    "3200",
    "Shareholder distributions",
    "equity",
    "owner_equity",
    "distributions",
  ],
  ["retained", "3800", "Retained earnings", "equity", "retained_earnings"],
  [
    "obe",
    "3900",
    "Opening balance equity",
    "equity",
    "opening_balance",
    "opening_balance_equity",
  ],
  ["sales", "4000", "Sales", "income", "revenue"],
  ["interest", "4300", "Interest income", "income", "other"],
  [
    "uncat_in",
    "4900",
    "Uncategorized income",
    "income",
    "uncategorized",
    "uncategorized_income",
  ],
  ["software", "6100", "Software", "expense", "operating_expense"],
  ["meals", "6200", "Meals", "expense", "operating_expense"],
  [
    "uncat_out",
    "6990",
    "Uncategorized expense",
    "expense",
    "uncategorized",
    "uncategorized_expense",
  ],
  [
    "old",
    "6300",
    "Old subscription",
    "expense",
    "operating_expense",
    null,
    true,
  ],
];
const accounts: AccountingAccount[] = seeds.map(
  ([id, code, name, account_type, , , archived]) => ({
    id,
    code,
    name,
    account_type,
    normal_side:
      account_type === "asset" || account_type === "expense"
        ? "debit"
        : "credit",
    is_archived: !!archived,
  }),
);
const profiles: AccountProfile[] = seeds.map(
  ([id, , , , subtype, purpose]) => ({
    account_id: id,
    version: 1,
    purpose: purpose ?? null,
    cash_kind:
      subtype === "bank" || subtype === "cash" || subtype === "card"
        ? subtype
        : "none",
    parent_account_id: null,
    subtype,
  }),
);
const values = (groups: ReturnType<typeof categoryGroups>) =>
  groups.flatMap((g) => g.options.map((o) => o.value));
const groupOf = (groups: ReturnType<typeof categoryGroups>, id: string) =>
  groups.find((g) => g.options.some((o) => o.value === id));

{
  const moneyIn = categoryGroups(accounts, profiles, "in");
  check(
    "money in leads with Income, open",
    moneyIn[0].id === "income" && !moneyIn[0].collapsed,
  );
  check(
    "income accounts are the first group's options, sorted by name",
    moneyIn[0].options.map((o) => o.value).join(",") === "interest,sales",
  );
  check(
    "expenses sit under a closed refund group on money in",
    groupOf(moneyIn, "software")?.id === "refund" &&
      groupOf(moneyIn, "software")?.label === "Refund of an expense" &&
      groupOf(moneyIn, "software")?.collapsed === true,
  );
  check(
    "owner accounts are their own closed group",
    groupOf(moneyIn, "contrib")?.label === "Owner contribution" &&
      groupOf(moneyIn, "distrib")?.id === "owner" &&
      groupOf(moneyIn, "contrib")?.collapsed === true,
  );
  check(
    "assets and liabilities stay reachable, closed",
    groupOf(moneyIn, "receivable")?.id === "asset" &&
      groupOf(moneyIn, "equipment")?.id === "asset" &&
      groupOf(moneyIn, "loan")?.id === "liability" &&
      groupOf(moneyIn, "payroll")?.id === "liability" &&
      moneyIn
        .filter((g) => g.id === "asset" || g.id === "liability")
        .every((g) => g.collapsed),
  );
  const hidden = [
    "checking",
    "card",
    "undeposited",
    "transit",
    "accum",
    "retained",
    "obe",
    "uncat_in",
    "uncat_out",
    "old",
  ];
  check(
    "cash, suspense, system and archived accounts never appear",
    hidden.every((id) => !values(moneyIn).includes(id)),
  );
  check(
    "no group is empty and the order is income, refund, owner, asset, liability",
    moneyIn.every((g) => g.options.length > 0) &&
      moneyIn.map((g) => g.id).join(",") ===
        "income,refund,owner,asset,liability",
  );
}
{
  const moneyOut = categoryGroups(accounts, profiles, "out");
  check(
    "money out leads with Expenses, open",
    moneyOut[0].id === "expense" && !moneyOut[0].collapsed,
  );
  check(
    "income sits under a closed refund group on money out",
    groupOf(moneyOut, "sales")?.label === "Refund to a customer" &&
      groupOf(moneyOut, "sales")?.collapsed === true,
  );
  check(
    "owner group reads as a draw on money out",
    groupOf(moneyOut, "distrib")?.label === "Owner draw",
  );
}
{
  const any = categoryGroups(accounts, profiles, "any");
  check(
    "a mixed bulk menu opens both income and expenses and has no refund or owner groups",
    any[0].id === "income" &&
      any[1].id === "expense" &&
      !any[0].collapsed &&
      !any[1].collapsed &&
      !any.some((g) => g.id === "refund" || g.id === "owner"),
  );
  check(
    "owner accounts fold into Equity for a mixed menu",
    groupOf(any, "contrib")?.id === "equity",
  );
}
{
  const base = categoryGroups(accounts, profiles, "in");
  const plain = categoryMenu(base, accounts, {});
  check("no context adds nothing", plain.length === base.length);
  const placeholder = categoryMenu(base, accounts, { current: "uncat_in" });
  check(
    "an uncategorized placeholder is not offered as a choice",
    !placeholder.some((g) => g.id === "current"),
  );
  const archived = categoryMenu(base, accounts, { current: "old" });
  check(
    "an archived category still on the entry stays choosable, marked as such",
    archived.at(-1)?.id === "current" &&
      archived.at(-1)?.label === "Archived" &&
      archived.at(-1)?.options[0].value === "old",
  );
  const visibleCurrent = categoryMenu(base, accounts, { current: "sales" });
  check(
    "a visible current category adds no group",
    !visibleCurrent.some((g) => g.id === "current"),
  );
  const suggested = categoryMenu(base, accounts, {
    prior: { last_category: "sales", payee_id: null, count: 3 },
    payeeDefault: "interest",
  });
  check(
    "prior category and payee default form a Suggested group, prior first",
    suggested[0].id === "suggested" &&
      suggested[0].options.map((o) => o.value).join(",") === "sales,interest" &&
      suggested[0].options[0].detail === "Chosen 3 times before" &&
      suggested[0].options[1].detail === "Payee default",
  );
  const same = categoryMenu(base, accounts, {
    prior: { last_category: "sales", payee_id: null, count: 1 },
    payeeDefault: "sales",
  });
  check(
    "the same account is suggested once",
    same[0].options.length === 1 &&
      same[0].options[0].detail === "Chosen once before",
  );
  const hiddenPrior = categoryMenu(base, accounts, {
    prior: { last_category: "uncat_in", payee_id: null, count: 2 },
  });
  check(
    "a hidden prior category is not suggested",
    !hiddenPrior.some((g) => g.id === "suggested"),
  );
}
{
  const kind = (id: string, d: "in" | "out") =>
    categoryKind(id, accounts, profiles, d);
  check("expense on money in is a refund", kind("software", "in") === "refund");
  check("income on money out is a refund", kind("sales", "out") === "refund");
  check(
    "owner equity is an owner movement either way",
    kind("contrib", "in") === "owner" && kind("distrib", "out") === "owner",
  );
  check(
    "loan and fixed asset keep their register kinds",
    kind("loan", "out") === "loan" && kind("equipment", "out") === "asset",
  );
  check(
    "income in and expense out are the plain kinds",
    kind("sales", "in") === "income" && kind("meals", "out") === "expense",
  );
  check(
    "other balance sheet accounts follow the direction",
    kind("receivable", "in") === "income" &&
      kind("payroll", "out") === "expense",
  );
  check(
    "unknown and hidden accounts return null",
    kind("nope", "in") === null &&
      kind("checking", "in") === null &&
      kind("uncat_in", "in") === null,
  );
}
{
  check(
    "a profile-less account counts as a category",
    isCategoryAccount(accounts[13], undefined),
  );
  const lines = simpleTransactionLines(
    {
      account: "checking",
      direction: "in",
      amount: "12.34",
      splits: [{ account: "software", amount: "12.34", memo: "" }],
    },
    accounts,
    profiles,
  );
  check(
    "the line builder accepts an expense account on money in, so refunds post as negative expense",
    lines[0].amount_cents === "1234" &&
      lines[1].account_id === "software" &&
      lines[1].amount_cents === "-1234",
  );
}
console.log(`Accounting categories: ${checks} checks passed.`);
