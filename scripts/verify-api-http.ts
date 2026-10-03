/**
 * Finance API end to end: the real v1 route handlers and the real supabase-js
 * service client, against the pglite fixture behind a small PostgREST
 * stand-in (scripts/fake-postgrest.ts). Books are seeded as the books
 * suites seed them; tracker rows are added; an agent with a key reads
 * everything. Numbers are compared with what the screens compute from the
 * same database: buildReportModel for reports, calculateFullTax for tax.
 *
 * Run: npx tsx --tsconfig tsconfig.api-test.json scripts/verify-api-http.ts
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { seedApiFixture } from "./api-test-fixture";
import { fixtureAccounts, fixtureAccountId as account, fixtureOwner } from "../src/lib/accounting/fixtures";
import { buildReportModel } from "../src/lib/accounting/report-model";
import type { ReportData } from "../src/lib/accounting/reports";
import { calculateFullTax } from "../src/lib/tax/calculations";
import { getTaxYearConfig } from "../src/lib/tax/constants";
import { API_OPERATIONS } from "../src/lib/api/operations";

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const { db, server, fullKey, booksOnly, agentId, side, taxInputs, registerTotal, ownerRead } = await seedApiFixture();
  try {
    const routes = {
      summary: await import("../src/app/api/v1/books/summary/route"),
      accounts: await import("../src/app/api/v1/books/accounts/route"),
      ledger: await import("../src/app/api/v1/books/accounts/[id]/ledger/route"),
      transactions: await import("../src/app/api/v1/books/transactions/route"),
      transaction: await import("../src/app/api/v1/books/transactions/[id]/route"),
      reports: await import("../src/app/api/v1/books/reports/route"),
      report: await import("../src/app/api/v1/books/reports/[id]/route"),
      revision: await import("../src/app/api/v1/books/revision/route"),
      income: await import("../src/app/api/v1/tracker/income/route"),
      expenses: await import("../src/app/api/v1/tracker/expenses/route"),
      netWorth: await import("../src/app/api/v1/tracker/net-worth/route"),
      tax: await import("../src/app/api/v1/tax/estimate/route"),
      openapi: await import("../src/app/api/v1/openapi.json/route"),
      payees: await import("../src/app/api/v1/books/payees/route"),
      rules: await import("../src/app/api/v1/books/rules/route"),
      drafts: await import("../src/app/api/v1/books/drafts/route"),
      draft: await import("../src/app/api/v1/books/drafts/[id]/route"),
      categorize: await import("../src/app/api/v1/books/transactions/[id]/categorize/route"),
      split: await import("../src/app/api/v1/books/transactions/[id]/split/route"),
      bulk: await import("../src/app/api/v1/books/transactions/categorize/route"),
      incomeItems: await import("../src/app/api/v1/tracker/income/items/route"),
      incomeItem: await import("../src/app/api/v1/tracker/income/items/[id]/route"),
      expense: await import("../src/app/api/v1/tracker/expenses/[id]/route"),
      netWorthEntry: await import("../src/app/api/v1/tracker/net-worth/[id]/route"),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field below
    type Json = { success: boolean; source?: string; data?: any; error?: { code: string; details?: { reason?: string } }; request_id: string };
    const call = async (
      route: { GET: (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response> },
      path: string,
      key: string | null = fullKey,
      params: Record<string, string> = {},
    ) => {
      const response = await route.GET(
        new NextRequest(`http://localhost${path}`, { headers: key ? { "x-api-key": key } : {} }),
        { params: Promise.resolve(params) },
      );
      return { status: response.status, headers: response.headers, json: (await response.json()) as Json };
    };
    const reason = (r: { json: Json }) => r.json.error?.details?.reason;

    // Authentication and authorization.
    const missing = await call(routes.summary, "/api/v1/books/summary", null);
    check("no key: 401 missing_api_key", missing.status === 401 && reason(missing) === "missing_api_key", missing.json);
    const bogus = await call(routes.summary, "/api/v1/books/summary", "vmfin_nope");
    check("unknown key: 401 invalid_api_key", bogus.status === 401 && reason(bogus) === "invalid_api_key", bogus.json);
    const narrow = await call(routes.income, "/api/v1/tracker/income", booksOnly);
    check("books-only key on the tracker: 403 missing_key_scope", narrow.status === 403 && reason(narrow) === "missing_key_scope", narrow.json);

    // Books: summary.
    const summary = await call(routes.summary, "/api/v1/books/summary?from=2026-01-01&to=2026-12-31");
    const d = summary.json.data;
    check("summary: 200 from the books", summary.status === 200 && summary.json.source === "books", summary.json);
    check("summary: income, expense, net", d?.income_cents === "190000" && d?.expense_cents === "115000" && d?.net_income_cents === "75000", d);
    check("summary: balance sheet", d?.assets_cents === "1278000" && d?.liabilities_cents === "3000" && d?.equity_cents === "1000000", d);
    check("summary: working mode by default", d?.book_mode === "working");
    check("summary: quality block", typeof d?.quality?.draft_count === "number");
    check("summary: rate limit headers", summary.headers.get("x-ratelimit-limit") === "120" && !!summary.headers.get("x-ratelimit-remaining"));
    check("summary: request id", summary.headers.get("x-request-id") === summary.json.request_id);
    const strict = await call(routes.summary, "/api/v1/books/summary?form=2026-01-01");
    check("unknown parameter: 422", strict.status === 422 && reason(strict) === "invalid_parameters", strict.json);
    const backwards = await call(routes.summary, "/api/v1/books/summary?from=2026-03-01&to=2026-01-01");
    check("reversed range: 422 invalid_range", backwards.status === 422 && reason(backwards) === "invalid_range", backwards.json);
    const badDate = await call(routes.summary, "/api/v1/books/summary?from=2026-1-1");
    check("bad date: 422", badDate.status === 422, badDate.json);
    const noSuchDay = await call(routes.summary, "/api/v1/books/summary?from=2026-02-30");
    check("non-calendar date: 422", noSuchDay.status === 422 && reason(noSuchDay) === "invalid_parameters", noSuchDay.json);

    // Books: accounts and ledger.
    const accounts = await call(routes.accounts, "/api/v1/books/accounts?as_of=2026-12-31");
    const checking = accounts.json.data?.accounts?.find((a: { id: string }) => a.id === account(1));
    check("accounts: checking balance", checking?.balance_cents === "1228000" && checking?.type === "asset", checking);
    const liabilities = (accounts.json.data?.accounts ?? []).filter((a: { type: string }) => a.type === "liability");
    const owed = liabilities.reduce((sum: bigint, a: { balance_cents: string }) => sum + BigInt(a.balance_cents), BigInt(0));
    check("accounts: liabilities read as amounts owed, as on the screen", owed === BigInt(3000), owed.toString());
    const incomeAccounts = (accounts.json.data?.accounts ?? []).filter((a: { type: string }) => a.type === "income");
    const earned = incomeAccounts.reduce((sum: bigint, a: { period_cents: string }) => sum + BigInt(a.period_cents), BigInt(0));
    check("accounts: income reads as earned", earned === BigInt(190000), earned.toString());
    const ledger = await call(routes.ledger, `/api/v1/books/accounts/${account(1)}/ledger?from=2026-01-01&to=2026-12-31`, fullKey, { id: account(1) });
    const lines = ledger.json.data?.lines ?? [];
    check("ledger: opening and movement", ledger.json.data?.opening_cents === "1200000" && ledger.json.data?.total_cents === "28000", ledger.json);
    check("ledger: running balance ends at the balance", lines.at(-1)?.running_cents === "1228000", lines.at(-1));
    const badAccount = await call(routes.ledger, "/api/v1/books/accounts/nope/ledger", fullKey, { id: "nope" });
    check("ledger: bad id 422", badAccount.status === 422, badAccount.json);
    const noAccount = randomUUID();
    const ghostLedger = await call(routes.ledger, `/api/v1/books/accounts/${noAccount}/ledger`, fullKey, { id: noAccount });
    check("ledger: unknown account 404", ghostLedger.status === 404, ghostLedger.json);
    const quietAccount = account(Number(fixtureAccounts.at(-1)!.id.slice(-2)));
    const quiet = await call(routes.ledger, `/api/v1/books/accounts/${quietAccount}/ledger?from=2030-01-01&to=2030-01-31`, fullKey, { id: quietAccount });
    check("ledger: a real account with no activity is 200", quiet.status === 200 && quiet.json.data?.total === 0, quiet.json);

    // Books: transactions.
    const page = await call(routes.transactions, "/api/v1/books/transactions?from=2026-01-01&to=2026-12-31&limit=2");
    const tx = page.json.data;
    check("transactions: total and paging", tx?.total === registerTotal && tx?.total > 2 && tx?.transactions?.length === 2 && tx?.next_offset === 2, tx && { total: tx.total, next: tx.next_offset });
    const first = tx?.transactions?.[0];
    check("transactions: names on every line", first?.lines?.every((l: { account_name: string }) => l.account_name && l.account_name !== "Unknown account"), first);
    check("transactions: no audit history in the API", first && !("audit" in first));
    check("transactions: rows carry version and rule descriptors", typeof first?.version === "number" && "descriptor_key" in first && "prior_treatment" in first, first);
    const one = await call(routes.transaction, `/api/v1/books/transactions/${first?.id}`, fullKey, { id: first?.id });
    check("transaction: same row by id", one.status === 200 && same(one.json.data, first), one.json);
    const ghost = randomUUID();
    const missingTx = await call(routes.transaction, `/api/v1/books/transactions/${ghost}`, fullKey, { id: ghost });
    check("transaction: unknown id 404", missingTx.status === 404, missingTx.json);
    const reversedRange = await call(routes.transactions, "/api/v1/books/transactions?from=2026-05-01&to=2026-01-01");
    check("transactions: reversed range 422", reversedRange.status === 422 && reason(reversedRange) === "invalid_range", reversedRange.json);
    const searched = await call(routes.transactions, "/api/v1/books/transactions?review=needed");
    check("transactions: review filter", searched.status === 200 && searched.json.data?.total === searched.json.data?.needs_review_count, searched.json.data);

    // Books: reports equal the screen's model for the same read.
    const catalog = await call(routes.reports, "/api/v1/books/reports");
    check("reports: catalog of 8", catalog.json.data?.reports?.length === 8, catalog.json);
    await db.exec("SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
    const params = { from: "2026-01-01", to: "2026-12-31", mode: "working" };
    const screenSummary = await ownerRead<ReportData>("SELECT accounting.report('summary',$1) r", [JSON.stringify(params)]);
    const screenLedger = await ownerRead<ReportData>("SELECT accounting.report('general_ledger',$1) r", [JSON.stringify(params)]);
    await db.exec("RESET ROLE;");
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    for (const id of ["profit-loss", "balance-sheet", "trial-balance", "cash-flow", "general-ledger", "owner-activity"] as const) {
      const api = await call(routes.report, `/api/v1/books/reports/${id}?from=2026-01-01&to=2026-12-31`, fullKey, { id });
      const screen = buildReportModel(id, id === "general-ledger" ? screenLedger : screenSummary);
      const rows = screen.rows.map(({ key, label, kind, code, values }) => ({ key, label, kind, ...(code ? { code } : {}), values }));
      check(`report ${id}: rows equal the screen`, api.status === 200 && same(api.json.data?.rows, rows) && same(api.json.data?.columns, screen.columns), api.json.error ?? { api: api.json.data?.rows?.length, screen: rows.length });
    }
    const unknownReport = await call(routes.report, "/api/v1/books/reports/nope", fullKey, { id: "nope" });
    check("report: unknown id 422", unknownReport.status === 422, unknownReport.json);
    const revision = await call(routes.revision, "/api/v1/books/revision");
    check("revision equals the books", revision.json.data?.revision === screenSummary.revision, { api: revision.json.data, books: screenSummary.revision });

    // Tracker.
    const income = await call(routes.income, "/api/v1/tracker/income?from=2026-07-01&to=2026-09-30");
    const months = income.json.data?.months ?? [];
    check("income: from the tracker", income.json.source === "tracker");
    check("income: deleted months are left out", months.length === 2, months);
    check("income: month totals in cents", months[0]?.total_cents === "525050" && months[1]?.total_cents === "500000", months);
    check("income: zero amounts are dropped per source", months[1]?.by_source?.length === 1, months[1]);
    check("income: range total", income.json.data?.total_cents === "1025050", income.json.data);
    const decades = await call(routes.income, "/api/v1/tracker/income?from=2000-01-01&to=2026-09-30");
    check("income: more than 120 months is 422", decades.status === 422 && reason(decades) === "invalid_range", decades.json);
    const expenses = await call(routes.expenses, "/api/v1/tracker/expenses");
    const list = expenses.json.data?.expenses ?? [];
    const byName = (n: string) => list.find((e: { name: string }) => e.name === n);
    check("expenses: active only by default", list.length === 3, list);
    check("expenses: annual to monthly", byName("Domain renewals")?.monthly_cents === "1000");
    check("expenses: weekly to monthly", byName("Gym")?.monthly_cents === "4333", byName("Gym"));
    // Rounded once, like the screen: (1500*12 + 12000*1 + 1000*52) / 12 = 6833.33.
    check("expenses: monthly total", expenses.json.data?.monthly_total_cents === "6833", expenses.json.data?.monthly_total_cents);
    const subscriptions = await call(routes.expenses, "/api/v1/tracker/expenses?category=subscriptions");
    check("expenses: category filter", subscriptions.json.data?.expenses?.length === 1);
    const all = await call(routes.expenses, "/api/v1/tracker/expenses?active=all");
    check("expenses: active=all includes paused rows", all.json.data?.expenses?.length === 4);
    const worth = await call(routes.netWorth, "/api/v1/tracker/net-worth");
    check("net worth: latest in cents", worth.json.data?.latest_cents === "13150025", worth.json.data);

    // Tax estimate equals the engine on the same inputs.
    const tax = await call(routes.tax, "/api/v1/tax/estimate?year=2026");
    const engine = calculateFullTax(taxInputs.income_sources as never, [], taxInputs.payments as never, 0, "single", getTaxYearConfig(2026)!, "AZ");
    const c = (n: number) => String(Math.round(n * 100));
    check("tax: source estimate", tax.json.source === "estimate", tax.json);
    check(
      "tax: liability, paid and remaining equal the engine",
      tax.json.data?.total_liability_cents === c(engine.totalLiability) &&
        tax.json.data?.total_paid_cents === c(engine.totalPaid) &&
        tax.json.data?.remaining_cents === c(engine.netRemaining),
      { api: tax.json.data, engine: { l: engine.totalLiability, p: engine.totalPaid, r: engine.netRemaining } },
    );
    const noYear = await call(routes.tax, "/api/v1/tax/estimate?year=2025");
    check("tax: no estimate for the year is 404", noYear.status === 404, noYear.json);
    check("tax: says when the inputs were saved", typeof tax.json.data?.saved_at === "string" && tax.json.data?.books_linked === false, tax.json.data);

    // ----- Writes -----
    type Handler = (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
    const send = async (
      handler: Handler,
      method: string,
      path: string,
      body: unknown,
      opts: { key?: string | null; idem?: string; params?: Record<string, string>; contentType?: string } = {},
    ) => {
      const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json" };
      const key = opts.key === undefined ? fullKey : opts.key;
      if (key) headers["x-api-key"] = key;
      if (opts.idem) headers["idempotency-key"] = opts.idem;
      const response = await handler(
        new NextRequest(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
        { params: Promise.resolve(opts.params ?? {}) },
      );
      return { status: response.status, headers: response.headers, json: (await response.json()) as Json };
    };
    // An agent only has what the API gives it: read the version through the
    // API (as books_get_transaction does), and hold it to the database.
    const versionOf = async (id: string) => {
      const read = await call(routes.transaction, `/api/v1/books/transactions/${id}`, fullKey, { id });
      await db.exec("RESET ROLE;");
      const stored = (await db.query<{ version: number }>("SELECT version FROM accounting.journal_entries WHERE id=$1", [id])).rows[0]?.version;
      check(`version: the API reports the stored version of ${id.slice(0, 8)}`, typeof read.json.data?.version === "number" && read.json.data.version === stored, { api: read.json.data?.version, stored });
      return read.json.data?.version as number;
    };

    // Books: drafts only.
    const draftBody = {
      entry_date: "2026-03-05",
      memo: "Figma subscription",
      // An accrual: API drafts are adjustments between non-cash accounts.
      lines: [
        { account_id: account(6), amount_cents: "1500" },
        { account_id: account(8), amount_cents: "-1500" },
      ],
      kind: "expense",
    };
    /** A bank draft as the feeds make them, by the owner: the API categorizes and splits these. */
    const ownerBankDraft = async (memo: string, bankCents: string, category: string) => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
      const made = (
        await db.query<{ r: { id: string } }>("SELECT accounting.operate($1) r", [
          JSON.stringify({
            key: randomUUID(),
            command: {
              type: "draft.save",
              id: randomUUID(),
              expected_version: 0,
              entry_date: "2026-03-05",
              memo,
              lines: [
                { account_id: account(1), amount_cents: bankCents },
                { account_id: category, amount_cents: (-BigInt(bankCents)).toString() },
              ],
            },
          }),
        ])
      ).rows[0].r;
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
      return made.id;
    };
    const idem = randomUUID();
    const d1 = await send(routes.drafts.POST, "POST", "/api/v1/books/drafts", draftBody, { idem });
    const draftId = d1.json.data?.id as string;
    check(
      "write: draft created as a draft, with a review link",
      d1.status === 200 && d1.json.data?.status === "draft" && !!draftId && String(d1.json.data?.review_url) === `http://localhost/accounting?view=journal&entry=${draftId}`,
      d1.json,
    );
    const again = await send(routes.drafts.POST, "POST", "/api/v1/books/drafts", draftBody, { idem });
    check("write: a retry replays the first answer", again.status === 200 && again.json.data?.id === draftId && again.headers.get("idempotent-replay") === "true", again.json);
    const reused = await send(routes.drafts.POST, "POST", "/api/v1/books/drafts", { ...draftBody, memo: "Other" }, { idem });
    check("write: same key, different body is 409", reused.status === 409 && reason(reused) === "idempotency_conflict", reused.json);
    const noIdem = await send(routes.drafts.POST, "POST", "/api/v1/books/drafts", draftBody);
    check("write: creates need an Idempotency-Key", noIdem.status === 422 && reason(noIdem) === "missing_idempotency_key", noIdem.json);
    const notJson = await send(routes.drafts.POST, "POST", "/api/v1/books/drafts", draftBody, { idem: randomUUID(), contentType: "text/plain" });
    check("write: a non-JSON body is 415", notJson.status === 415, notJson.json);
    const unbalanced = await send(
      routes.drafts.POST,
      "POST",
      "/api/v1/books/drafts",
      { ...draftBody, lines: [{ account_id: account(6), amount_cents: "1500" }, { account_id: account(1), amount_cents: "-1000" }] },
      { idem: randomUUID() },
    );
    check("write: unbalanced lines are 422", unbalanced.status === 422 && reason(unbalanced) === "invalid_parameters", unbalanced.json);
    const readOnly = await send(routes.drafts.POST, "POST", "/api/v1/books/drafts", draftBody, { idem: randomUUID(), key: booksOnly });
    check("write: a read-only key is 403", readOnly.status === 403 && reason(readOnly) === "missing_key_scope", readOnly.json);
    const staleDraft = await send(routes.draft.PUT, "PUT", `/api/v1/books/drafts/${draftId}`, { ...draftBody, expected_version: 99 }, { params: { id: draftId } });
    check("write: a stale version is 409", staleDraft.status === 409 && reason(staleDraft) === "stale_version", staleDraft.json);
    const replaced = await send(
      routes.draft.PUT,
      "PUT",
      `/api/v1/books/drafts/${draftId}`,
      { ...draftBody, memo: "Figma Professional", expected_version: await versionOf(draftId) },
      { params: { id: draftId } },
    );
    check("write: draft replaced", replaced.status === 200 && replaced.json.data?.status === "draft", replaced.json);
    await db.exec("RESET ROLE;");
    const postedId = (await db.query<{ id: string; version: number }>("SELECT id, version FROM accounting.journal_entries WHERE status='posted' LIMIT 1")).rows[0];
    const onPosted = await send(
      routes.draft.PUT,
      "PUT",
      `/api/v1/books/drafts/${postedId.id}`,
      { ...draftBody, expected_version: postedId.version },
      { params: { id: postedId.id } },
    );
    check("write: a posted entry is 409 not_a_draft", onPosted.status === 409 && reason(onPosted) === "not_a_draft", onPosted.json);
    const bankLine = await send(
      routes.drafts.POST,
      "POST",
      "/api/v1/books/drafts",
      { ...draftBody, lines: [{ account_id: account(6), amount_cents: "1500" }, { account_id: account(1), amount_cents: "-1500" }] },
      { idem: randomUUID() },
    );
    check("write: a draft with a bank line is 422 bank_lines_not_allowed", bankLine.status === 422 && reason(bankLine) === "bank_lines_not_allowed", bankLine.json);
    const bankId = await ownerBankDraft("Figma subscription (bank)", "-1500", account(6));
    const rewriteBank = await send(routes.draft.PUT, "PUT", `/api/v1/books/drafts/${bankId}`, { ...draftBody, expected_version: await versionOf(bankId) }, { params: { id: bankId } });
    check("write: a bank draft is categorized or split, never rewritten", rewriteBank.status === 422 && reason(rewriteBank) === "bank_lines_not_allowed", rewriteBank.json);
    const categorized = await send(
      routes.categorize.POST,
      "POST",
      `/api/v1/books/transactions/${bankId}/categorize`,
      { expected_version: await versionOf(bankId), account_id: account(7) },
      { params: { id: bankId } },
    );
    check("write: categorized, still a draft", categorized.status === 200 && categorized.json.data?.status === "draft", categorized.json);
    const cashCategory = await send(
      routes.categorize.POST,
      "POST",
      `/api/v1/books/transactions/${bankId}/categorize`,
      { expected_version: await versionOf(bankId), account_id: account(9) },
      { params: { id: bankId } },
    );
    check("write: a bank account as category is 422", cashCategory.status === 422 && reason(cashCategory) === "invalid_parameters", cashCategory.json);
    const split = await send(
      routes.split.POST,
      "POST",
      `/api/v1/books/transactions/${bankId}/split`,
      { expected_version: await versionOf(bankId), splits: [{ account_id: account(6), share_bps: 6000 }, { account_id: account(7), share_bps: 4000 }] },
      { params: { id: bankId } },
    );
    check("write: split by shares", split.status === 200, split.json);
    const secondId = await ownerBankDraft("Second (bank)", "-900", account(6));
    const bulk = await send(
      routes.bulk.POST,
      "POST",
      "/api/v1/books/transactions/categorize",
      {
        items: [
          { id: bankId, expected_version: await versionOf(bankId), account_id: account(7) },
          { id: secondId, expected_version: await versionOf(secondId), account_id: account(7) },
        ],
      },
      { idem: randomUUID() },
    );
    check("write: bulk categorize", bulk.status === 200 && bulk.json.data?.results?.length === 2, bulk.json);
    const rule = await send(
      routes.rules.POST,
      "POST",
      "/api/v1/books/rules",
      { name: "Figma", conditions: { descriptor_key: { contains: "FIGMA" } }, actions: { account_id: account(6) } },
      { idem: randomUUID() },
    );
    const autoPostRule = await send(
      routes.rules.POST,
      "POST",
      "/api/v1/books/rules",
      { name: "Sneaky", auto_post: true, conditions: { descriptor_key: { contains: "X" } }, actions: { account_id: account(6) } },
      { idem: randomUUID() },
    );
    const ruleList = await call(routes.rules, "/api/v1/books/rules");
    check("write: rule added", rule.status === 200 && !!rule.json.data?.id, rule.json);
    check("write: auto_post is not even accepted", autoPostRule.status === 422, autoPostRule.json);
    check(
      "write: listed rules never auto-post",
      ruleList.json.data?.rules?.length === 1 &&
        ruleList.json.data.rules.every((r: { auto_post: boolean; enabled: boolean }) => r.auto_post === false && r.enabled === false),
      ruleList.json,
    );
    const payee = await send(routes.payees.POST, "POST", "/api/v1/books/payees", { name: "Figma", kind: "vendor" }, { idem: randomUUID() });
    const payeeList = await call(routes.payees, "/api/v1/books/payees");
    check("write: payee added and listed", payee.status === 200 && payeeList.json.data?.payees?.some((x: { name: string }) => x.name === "Figma"), payeeList.json);
    check("write: rule and payee creates link to where the owner sees them", rule.json.data?.review_url === "http://localhost/accounting?view=manage&section=rules" && payee.json.data?.review_url === "http://localhost/accounting?view=manage&section=payees", { rule: rule.json.data, payee: payee.json.data });
    for (const name of ["Adobe", "Amazon Web Services", "Zoom"])
      await send(routes.payees.POST, "POST", "/api/v1/books/payees", { name, kind: name === "Zoom" ? "customer" : "vendor" }, { idem: randomUUID() });
    const payeeSearch = await call(routes.payees, "/api/v1/books/payees?q=AMAZON");
    check("lists: payees search names in any case", payeeSearch.json.data?.payees?.length === 1 && payeeSearch.json.data.payees[0].name === "Amazon Web Services" && payeeSearch.json.data.total === 1, payeeSearch.json.data);
    const paged = await call(routes.payees, "/api/v1/books/payees?limit=2");
    check("lists: payees page by name with a total and next_offset", paged.json.data?.payees?.length === 2 && paged.json.data.payees[0].name === "Adobe" && paged.json.data.total === 4 && paged.json.data.next_offset === 2, paged.json.data);
    const customers = await call(routes.payees, "/api/v1/books/payees?kind=customer");
    check("lists: payees filter by kind", customers.json.data?.payees?.length === 1 && customers.json.data.payees[0].name === "Zoom", customers.json.data);
    const ruleSearch = await call(routes.rules, "/api/v1/books/rules?q=figma&enabled=false");
    check("lists: rules search and filter", ruleSearch.json.data?.rules?.length === 1 && ruleSearch.json.data.total === 1 && ruleSearch.json.data.next_offset === null, ruleSearch.json.data);
    const onRules = await call(routes.rules, "/api/v1/books/rules?enabled=true");
    check("lists: rules switched on (none yet)", onRules.json.data?.rules?.length === 0, onRules.json.data);
    const categories = await call(routes.accounts, "/api/v1/books/accounts?type=expense");
    check("lists: accounts filter by type", categories.json.data?.accounts?.length > 0 && categories.json.data.accounts.every((a: { type: string }) => a.type === "expense"), categories.json.data?.accounts?.length);
    const uncategorized = await call(routes.accounts, "/api/v1/books/accounts?q=uncategorized");
    check("lists: accounts search finds the uncategorized accounts", uncategorized.json.data?.accounts?.length === 2 && uncategorized.json.data.accounts.every((a: { subtype: string; purpose: string | null }) => a.subtype === "uncategorized" && /^uncategorized_(income|expense)$/.test(a.purpose ?? "")), uncategorized.json.data?.accounts);
    const byDescriptor = await call(routes.transactions, "/api/v1/books/transactions?descriptor_key=nothing-matches-this");
    check("lists: transactions filter by descriptor_key", byDescriptor.status === 200 && byDescriptor.json.data?.total === 0, byDescriptor.json);
    const stale = await send(routes.draft.PUT, "PUT", `/api/v1/books/drafts/${draftId}`, { ...draftBody, expected_version: 1 }, { params: { id: draftId } });
    check("hints: a stale version says what to do", stale.status === 409 && /Read the transaction again/.test(String((stale.json.error as { details?: { hint?: string } })?.details?.hint)), stale.json);
    await db.exec("RESET ROLE;");
    const agentPosted = (
      await db.query(
        "SELECT 1 FROM accounting.journal_entries e WHERE e.status<>'draft' AND EXISTS(SELECT 1 FROM accounting.audit_log l WHERE l.row_id=e.id AND l.actor_kind='api')",
      )
    ).rows.length;
    check("write: nothing the agent wrote is posted", agentPosted === 0, agentPosted);

    // Tracker writes.
    const item = await send(
      routes.incomeItems.POST,
      "POST",
      "/api/v1/tracker/income/items",
      { received_date: "2026-10-15", source_id: side, amount_cents: "25000", notes: "Bonus" },
      { idem: randomUUID() },
    );
    const itemId = item.json.data?.id as string;
    check("tracker: income item added in cents", item.status === 200 && item.json.data?.amount_cents === "25000" && item.json.data?.month === "2026-10-01", item.json);
    await db.exec("RESET ROLE;");
    const stored = (await db.query<{ amount: string }>("SELECT amount::text FROM income_line_items WHERE id=$1", [itemId])).rows[0];
    check("tracker: stored as dollars", stored?.amount === "250.00", stored);
    const moved = await send(
      routes.incomeItem.PATCH,
      "PATCH",
      `/api/v1/tracker/income/items/${itemId}`,
      { amount_cents: "30000", received_date: "2026-11-02" },
      { params: { id: itemId } },
    );
    check("tracker: income item changed and moved month", moved.status === 200 && moved.json.data?.amount_cents === "30000" && moved.json.data?.month === "2026-11-01", moved.json);
    const emptyPatch = await send(routes.incomeItem.PATCH, "PATCH", `/api/v1/tracker/income/items/${itemId}`, {}, { params: { id: itemId } });
    check("tracker: an empty change is 422", emptyPatch.status === 422, emptyPatch.json);
    const gone = await send(routes.incomeItem.DELETE, "DELETE", `/api/v1/tracker/income/items/${itemId}`, undefined, { params: { id: itemId } });
    const items = await call(routes.incomeItems, "/api/v1/tracker/income/items");
    check(
      "tracker: deleted item leaves the list",
      gone.status === 200 && !items.json.data?.items?.some((x: { id: string }) => x.id === itemId),
      { gone: gone.json, items: items.json },
    );
    const goneAgain = await send(routes.incomeItem.DELETE, "DELETE", `/api/v1/tracker/income/items/${itemId}`, undefined, { params: { id: itemId } });
    check("tracker: deleting twice is 404", goneAgain.status === 404, goneAgain.json);
    const expense = await send(
      routes.expenses.POST,
      "POST",
      "/api/v1/tracker/expenses",
      { name: "Linear", amount_cents: "1000", frequency: "monthly", expense_type: "business", category: "subscriptions" },
      { idem: randomUUID() },
    );
    const expenseId = expense.json.data?.id as string;
    check("tracker: expense added", expense.status === 200 && expense.json.data?.monthly_cents === "1000", expense.json);
    const paused = await send(routes.expense.PATCH, "PATCH", `/api/v1/tracker/expenses/${expenseId}`, { is_active: false }, { params: { id: expenseId } });
    check("tracker: expense paused", paused.status === 200 && paused.json.data?.is_active === false, paused.json);
    const badCategory = await send(
      routes.expenses.POST,
      "POST",
      "/api/v1/tracker/expenses",
      { name: "X", amount_cents: "100", expense_type: "business", category: "nonsense" },
      { idem: randomUUID() },
    );
    check("tracker: unknown category is 422", badCategory.status === 422, badCategory.json);
    const expenseGone = await send(routes.expense.DELETE, "DELETE", `/api/v1/tracker/expenses/${expenseId}`, undefined, { params: { id: expenseId } });
    check("tracker: expense to Trash", expenseGone.status === 200, expenseGone.json);
    const worthNew = await send(routes.netWorth.POST, "POST", "/api/v1/tracker/net-worth", { date: "2026-10-31", amount_cents: "14000000" }, { idem: randomUUID() });
    const worthId = worthNew.json.data?.id as string;
    check("tracker: net worth added", worthNew.status === 200 && worthNew.json.data?.amount_cents === "14000000", worthNew.json);
    const sameDay = await send(routes.netWorth.POST, "POST", "/api/v1/tracker/net-worth", { date: "2026-10-31", amount_cents: "1" }, { idem: randomUUID() });
    check("tracker: a second entry for the date is 409", sameDay.status === 409 && reason(sameDay) === "duplicate", sameDay.json);
    const worthPatch = await send(routes.netWorthEntry.PATCH, "PATCH", `/api/v1/tracker/net-worth/${worthId}`, { amount_cents: "14100000" }, { params: { id: worthId } });
    check("tracker: net worth changed", worthPatch.status === 200 && worthPatch.json.data?.amount_cents === "14100000", worthPatch.json);
    const worthGone = await send(routes.netWorthEntry.DELETE, "DELETE", `/api/v1/tracker/net-worth/${worthId}`, undefined, { params: { id: worthId } });
    check("tracker: net worth to Trash", worthGone.status === 200, worthGone.json);
    const trackerReadOnly = await send(
      routes.expenses.POST,
      "POST",
      "/api/v1/tracker/expenses",
      { name: "Y", amount_cents: "100", expense_type: "business" },
      { idem: randomUUID(), key: booksOnly },
    );
    check("tracker: a key without the edit scope is 403", trackerReadOnly.status === 403, trackerReadOnly.json);

    // Suspending the agent stops every key at once.
    await db.query("UPDATE public.team_members SET status='suspended' WHERE id=$1", [agentId]);
    const suspended = await call(routes.summary, "/api/v1/books/summary");
    check("suspended member: 403", suspended.status === 403 && reason(suspended) === "member_inactive", suspended.json);
    await db.query("UPDATE public.team_members SET status='active' WHERE id=$1", [agentId]);

    // Every request was logged, refusals included.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const logged = await db.query<{ status: number; api_key_id: string | null; operation: string }>("SELECT status, api_key_id, operation FROM public.api_requests");
    check("request log: every call", logged.rows.length >= 30, logged.rows.length);
    check("request log: calls without a usable key are not logged", !logged.rows.some((r) => r.status === 401 && r.api_key_id === null));
    check("request log: refusals of a real key are", logged.rows.some((r) => r.status === 403 && r.api_key_id !== null));
    check("request log: successes carry the key", logged.rows.some((r) => r.status === 200 && r.api_key_id !== null && r.operation === "books.summary"));

    // OpenAPI is generated from the registry.
    const doc = (await (routes.openapi.GET(new NextRequest("http://localhost/api/v1/openapi.json")) as Response).json()) as {
      paths: Record<string, Record<string, { operationId: string; parameters: { name: string }[]; requestBody?: unknown }>>;
    };
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    check("openapi: every operation", ids.length === API_OPERATIONS.length && ids.includes("books.draft_create") && ids.includes("tax.estimate"), ids);
    check("openapi: path parameters", doc.paths["/api/v1/books/reports/{id}"]?.get?.parameters.length === 6);
    const create = doc.paths["/api/v1/books/drafts"]?.post;
    check(
      "openapi: creates carry a body and the Idempotency-Key",
      !!create?.requestBody && create.parameters.some((p) => p.name === "Idempotency-Key"),
      create,
    );
  } finally {
    await server.close();
    await db.close();
  }
  if (failures.length) {
    console.error(`API over HTTP handlers: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`API over HTTP handlers: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
