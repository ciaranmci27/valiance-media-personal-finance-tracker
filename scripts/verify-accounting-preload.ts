import assert from "node:assert/strict";
import {
  bootQueries,
  buildRegisterFilter,
  closeQueries,
  defaultReportFilter,
  journalFilterFromLocation,
  journalInitialState,
  monthsBefore,
  payrollListFilter,
  preloadContextFromLocation,
  registerQuery,
  registerSignature,
  reportSignature,
  viewQueries,
} from "../src/lib/accounting/preload";
import { accountingQueryKey } from "../src/lib/accounting/read-cache";

const INBOX =
  '{"status":"all","review":"needs_review","missing_receipt":false,"sort":"date_desc","offset":0,"limit":50}';
const EVERYTHING =
  '{"status":"all","missing_receipt":false,"sort":"date_desc","offset":0,"limit":50}';

const ctx = preloadContextFromLocation(new URLSearchParams(), "2026-01-15", 3);
assert.deepEqual(
  { from: ctx.from, to: ctx.to },
  { from: "2026-01-01", to: "2026-01-15" },
  "The address defaults mirror the page",
);

// The ledger's first page: the inbox while anything needs review.
assert.equal(
  registerSignature(buildRegisterFilter(journalInitialState({}, 3))),
  INBOX,
);
const journal = viewQueries("journal", ctx);
assert.equal(journal.length, 1);
assert.equal(journal[0].view, "register");
assert.equal(journal[0].filter, INBOX, "The warm-up asks for the inbox page");
assert.equal(
  registerSignature(buildRegisterFilter(journalInitialState({}, 0))),
  EVERYTHING,
  "An empty inbox lands on everything",
);
assert.equal(
  buildRegisterFilter(journalInitialState({ status: "draft" }, 0)).review,
  "needs_review",
  "A draft link opens the inbox even when it is empty",
);
const reviewed = buildRegisterFilter(
  journalInitialState({ review: "reviewed" }, 3),
);
assert.equal(reviewed.status, "all", "A reviewed link opens the full list");
assert.equal(reviewed.review, undefined);
assert.equal(journalInitialState({ status: "posted" }, 3).status, "all");
assert.equal(
  buildRegisterFilter(journalInitialState({ status: "discarded" }, 3)).status,
  "discarded",
);
const full = buildRegisterFilter(
  journalInitialState(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      account: "acct",
      query: "coffee",
      source: "csv",
      payee: "payee",
      missing_receipt: true,
      min_cents: "100",
      max_cents: "5000",
      sort: "amount_desc",
      offset: 50,
    },
    0,
  ),
);
assert.deepEqual(
  Object.keys(JSON.parse(registerSignature(full))),
  [
    "from",
    "to",
    "account",
    "status",
    "query",
    "source",
    "payee",
    "missing_receipt",
    "min_cents",
    "max_cents",
    "sort",
    "offset",
    "limit",
  ],
  "Filter keys keep the ledger's order",
);
assert.equal(full.limit, 50);
assert.equal(
  accountingQueryKey(
    registerQuery(buildRegisterFilter(journalInitialState({}, 3))),
  ),
  accountingQueryKey(journal[0]),
  "The ledger and the warm-up share one cache key",
);

// Overview: twelve months of cash flow, the inbox, recent activity, the month.
const overview = viewQueries("overview", ctx);
assert.equal(overview.length, 4);
assert.equal(overview[0].view, "report");
assert.equal(overview[0].report, "profit-loss");
assert.deepEqual(JSON.parse(overview[0].filter), {
  from: "2025-02-01",
  to: "2026-01-15",
  mode: "posted",
  offset: 0,
});
assert.equal(
  overview[1].filter,
  '{"review":"needs_review","sort":"date_desc","offset":0,"limit":5}',
);
assert.equal(
  overview[2].filter,
  '{"status":"posted","sort":"date_desc","offset":0,"limit":8}',
);
assert.deepEqual(overview[3], { view: "close", date: "2026-01-01" });
assert.equal(monthsBefore("2026-01-15", 11), "2025-02-01");
assert.equal(monthsBefore("2026-03-31", 0), "2026-03-01");
assert.equal(monthsBefore("2026-12-01", 12), "2025-12-01");

// Payroll: the current year, no search, first page.
const payroll = viewQueries("payroll", ctx);
assert.deepEqual(Object.keys(JSON.parse(payroll[0].filter)), [
  "year",
  "as_of",
  "query",
  "offset",
]);
assert.deepEqual(JSON.parse(payroll[0].filter), {
  year: 2026,
  as_of: "2026-01-15",
  query: "",
  offset: 0,
});
assert.equal(
  payroll[0].filter,
  payrollListFilter({ year: 2026, today: "2026-01-15", query: "", offset: 0 }),
);

// Month end follows a valid ?month= link and falls back to the books' month.
assert.deepEqual(viewQueries("close", ctx), closeQueries("2026-01"));
assert.deepEqual(viewQueries("close", ctx)[0], {
  view: "close",
  date: "2026-01-01",
});
assert.equal(
  viewQueries(
    "close",
    preloadContextFromLocation(
      new URLSearchParams("month=2025-11"),
      "2026-01-15",
      0,
    ),
  )[0].date,
  "2025-11-01",
);
assert.equal(
  viewQueries(
    "close",
    preloadContextFromLocation(
      new URLSearchParams("month=2025-13"),
      "2026-01-15",
      0,
    ),
  )[0].date,
  "2026-01-01",
  "A broken month link is ignored",
);

// Views that paint from the workspace alone warm nothing.
for (const view of ["accounts", "reports", "manage"] as const)
  assert.deepEqual(viewQueries(view, ctx), [], `${view} has no first read`);

// Boot: metadata, feeds, the setup guide, and a deep-linked entry's evidence.
assert.deepEqual(bootQueries(ctx), [
  { view: "manage" },
  { view: "feeds" },
  { view: "setup", year: "2026" },
]);
assert.deepEqual(bootQueries({ ...ctx, entry: "entry-1" }).at(-1), {
  view: "evidence",
  entry: "entry-1",
});

// A shared address carries its range, entry, section and ledger filter.
const linked = preloadContextFromLocation(
  new URLSearchParams(
    `from=2025-01-01&to=2025-12-31&entry=entry-2&section=rules&transactions=${encodeURIComponent('{"query":"amazon"}')}`,
  ),
  "2026-01-15",
  2,
);
assert.equal(linked.from, "2025-01-01");
assert.equal(linked.to, "2025-12-31");
assert.equal(linked.entry, "entry-2");
assert.equal(linked.section, "rules");
assert.equal(linked.journal?.query, "amazon");
assert.match(viewQueries("journal", linked)[0].filter, /"query":"amazon"/);
assert.deepEqual(
  journalFilterFromLocation(new URLSearchParams("transactions=%7Bbroken")),
  {},
  "A broken ledger link changes nothing",
);
assert.deepEqual(journalFilterFromLocation(new URLSearchParams()), {});

// A report from the catalog: the books' range, posted only.
assert.equal(
  reportSignature(defaultReportFilter("2026-01-01", "2026-01-15")),
  '{"from":"2026-01-01","to":"2026-01-15","mode":"posted","offset":0}',
);

console.log(
  "Accounting preload: ledger landing page, overview, payroll, month end, boot set and shared links passed.",
);
