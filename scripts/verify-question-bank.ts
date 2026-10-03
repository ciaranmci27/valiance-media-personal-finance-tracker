/**
 * The Alex question bank in oracle mode: representative owner questions,
 * each answered the way the bank says Alex should answer it, through the
 * finance MCP server in this process (the real /api/mcp route, the real v1
 * handlers, supabase-js against the pglite fixture), with an Alex-scoped key.
 *
 * Every case asserts: each call answers ok, each result is under the
 * 40,000-character cap, the case stays within its call budget, every tool it
 * uses is on Alex's tool list and none of them writes, and the answer equals
 * the pinned fixture figure. Fixture accounts carry other names than the
 * production books ("Software" stands in for Meal Expense), and the fixture
 * pins dates with as_of, so relative phrasing ("last month") resolves the same
 * way every run. A renamed report row, a dropped filter, a page that outgrows
 * the cap or a changed default fails here before Alex meets it.
 *
 * Run: npx tsx --tsconfig tsconfig.api-test.json scripts/verify-question-bank.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { seedApiFixture, seedCardGap } from "./api-test-fixture";
import { fixtureAccountId as account, fixtureOwner } from "../src/lib/accounting/fixtures";
import { MCP_TOOLS, toolsForScopes } from "../src/lib/mcp/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool payloads are read field by field
type Payload = Record<string, any>;
type Vars = Record<string, unknown>;

/** The MCP result cap (MAX_RESULT_CHARS in src/lib/mcp/server.ts, checked below). */
const MAX_RESULT_CHARS = 40_000;

/** The scopes on Alex's production key: books read and drafts, and the owner's trackers and tax read. */
const ALEX_SCOPES = ["accounting.read", "accounting.draft", "income.read", "expenses.read", "net_worth.read", "tax.read"];

interface Step {
  tool: string;
  /** Template strings: {{last_month.from}}, {{ytd.to}}, {{var}} from an earlier step. */
  args: Record<string, unknown>;
  /** Binds a value from this step's data for later steps and the answer. */
  as?: string;
  pick?: (data: Payload, vars: Vars) => unknown;
}
interface Case {
  id: string;
  section: "spending" | "profit" | "cash" | "tax" | "subscriptions" | "health";
  question: string;
  as_of: string;
  verdict: "answerable";
  budget: { max_calls: number; max_result_chars: number };
  oracle: Step[];
  answer: (vars: Vars) => string;
  fixture_expect: string | RegExp;
}

const AS_OF = "2026-02-03";
const bank = (alias: string) => ({ "Meal Expense": "Software", "Computer - Software": "Software", "Chase Checking": "Checking", "Amex card": "Business card" })[alias] ?? alias;

const CASES: Case[] = [
  {
    id: "spend_food_last_month",
    section: "spending",
    question: "How much did we spend on food last month?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_get_report", args: { id: "profit-loss", from: "{{last_month.from}}", to: "{{last_month.to}}" }, as: "meals", pick: (d) => d.rows.find((r: Payload) => r.label === bank("Meal Expense"))?.values[0] }],
    answer: (v) => String(v.meals),
    fixture_expect: "21500",
  },
  {
    id: "spend_total_last_month",
    section: "spending",
    question: "What were our total expenses last month?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_summary", args: { from: "{{last_month.from}}", to: "{{last_month.to}}" }, as: "expense", pick: (d) => d.expense_cents }],
    answer: (v) => String(v.expense),
    fixture_expect: "121500",
  },
  {
    id: "spend_top_vendors_ytd",
    section: "spending",
    question: "Who are our top 10 vendors this year?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_get_report",
        args: { id: "vendor-expenses", from: "{{ytd.from}}", to: "{{ytd.to}}", top: 10 },
        as: "top",
        pick: (d) => d.rows.filter((r: Payload) => r.kind === "account").map((r: Payload) => `${r.label}=${r.values[0]}`).join(";"),
      },
    ],
    answer: (v) => String(v.top),
    fixture_expect: "Unassigned=115000;OpenAI=6500",
  },
  {
    id: "spend_contact_all_time",
    section: "spending",
    question: "How much have we paid OpenAI in total, ever?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 2, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      { tool: "books_list_contacts", args: { q: "openai", view: "compact" }, as: "contact", pick: (d) => d.contacts[0] },
      { tool: "books_search_transactions", args: { contact: "{{contact.id}}", from: "2022-12-01", to: "{{as_of}}", view: "compact", limit: 1 }, as: "totals", pick: (d) => d.totals },
    ],
    // The contact row and the register's totals must agree; the answer is money out.
    answer: (v) => ((v.contact as Payload).out_cents === (v.totals as Payload).out_cents ? String((v.totals as Payload).out_cents) : "disagree"),
    fixture_expect: "7000",
  },
  {
    id: "spend_biggest_last_month",
    section: "spending",
    question: "What were the 5 biggest expenses last month?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_search_transactions",
        args: { from: "{{last_month.from}}", to: "{{last_month.to}}", kind: "expense", transfers: "exclude", sort: "amount_desc", view: "compact", limit: 5 },
        as: "rows",
        pick: (d) => d.transactions.map((r: Payload) => r.amount_cents).join(","),
      },
    ],
    answer: (v) => String(v.rows),
    fixture_expect: "-5000,-2000",
  },
  {
    id: "spend_did_we_pay",
    section: "spending",
    question: "Did we pay OpenAI last month?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_search_transactions", args: { q: "openai", from: "{{last_month.from}}", to: "{{last_month.to}}", view: "compact", limit: 10 }, as: "totals", pick: (d) => d.totals }],
    answer: (v) => `${(v.totals as Payload).count} out=${(v.totals as Payload).out_cents} in=${(v.totals as Payload).in_cents}`,
    fixture_expect: "3 out=7000 in=500",
  },
  {
    id: "spend_who_in_category",
    section: "spending",
    question: "Which restaurants did we spend the most at this year?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 2, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      { tool: "books_list_accounts", args: { type: "expense", q: bank("Meal Expense") }, as: "meals", pick: (d) => d.accounts[0]?.id },
      {
        tool: "books_get_report",
        args: { id: "vendor-expenses", from: "{{ytd.from}}", to: "{{ytd.to}}", category: "{{meals}}", top: 10 },
        as: "rows",
        pick: (d) => d.rows.map((r: Payload) => `${r.label}=${r.values[0]}`).join(";"),
      },
    ],
    answer: (v) => String(v.rows),
    fixture_expect: "Unassigned=15000;OpenAI=6500;Total=21500",
  },
  {
    id: "spend_category_vs_prior_period",
    section: "spending",
    question: "What did we spend on software last month compared to the month before?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_get_report",
        args: { id: "profit-loss", from: "{{last_month.from}}", to: "{{last_month.to}}", compare_from: "{{prior_month.from}}", compare_to: "{{prior_month.to}}" },
        as: "row",
        pick: (d) => d.rows.find((r: Payload) => r.label === bank("Computer - Software"))?.values.join(","),
      },
    ],
    answer: (v) => String(v.row),
    fixture_expect: "21500,0,21500",
  },
  {
    id: "spend_new_vendors",
    section: "spending",
    question: "Any new vendors last month?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_list_contacts",
        args: { role: "vendor", view: "compact" },
        as: "fresh",
        pick: (d, v) => d.contacts.filter((c: Payload) => c.first_date && c.first_date >= (v["last_month.from"] as string) && c.first_date <= (v["last_month.to"] as string)).map((c: Payload) => c.name).join(","),
      },
    ],
    answer: (v) => String(v.fresh),
    fixture_expect: "OpenAI",
  },
  {
    id: "profit_ytd",
    section: "profit",
    question: "What's our profit so far this year?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_summary", args: { from: "{{ytd.from}}", to: "{{ytd.to}}" }, as: "net", pick: (d) => d.net_income_cents }],
    answer: (v) => String(v.net),
    fixture_expect: "368500",
  },
  {
    id: "profit_best_month",
    section: "profit",
    question: "What was our best month ever for revenue?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_summary",
        args: { from: "2025-12-01", to: "{{as_of}}" },
        as: "best",
        pick: (d) => {
          const best = [...d.monthly].sort((a: Payload, b: Payload) => (BigInt(b.income_cents) > BigInt(a.income_cents) ? 1 : -1))[0];
          return `${best.month}=${best.income_cents}`;
        },
      },
    ],
    answer: (v) => String(v.best),
    fixture_expect: "2026-01-01=490000",
  },
  {
    id: "profit_top_clients",
    section: "profit",
    question: "Who are our biggest clients this year?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_get_report", args: { id: "customer-income", from: "{{ytd.from}}", to: "{{ytd.to}}", top: 5 }, as: "first", pick: (d) => `${d.rows[0].label}=${d.rows[0].values[0]}` }],
    answer: (v) => String(v.first),
    fixture_expect: "Acme=300000",
  },
  {
    id: "cash_now",
    section: "cash",
    question: "How much cash do we have right now?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_summary", args: { from: "{{ytd.from}}", to: "{{as_of}}" }, as: "cash", pick: (d) => d.cash_ending_cents }],
    answer: (v) => String(v.cash),
    fixture_expect: "1571500",
  },
  {
    id: "cash_bank_matches_books",
    section: "cash",
    question: "Does the Amex balance in the books match what Amex shows?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_reconciliation",
        args: {},
        as: "card",
        pick: (d) => d.accounts.find((a: Payload) => a.account.name === bank("Amex card")),
      },
    ],
    answer: (v) => `${(v.card as Payload).status} books=${(v.card as Payload).book_cents} bank=${(v.card as Payload).bank_cents} gap=${(v.card as Payload).gap_cents} since=${(v.card as Payload).off_since ? "set" : "none"}`,
    fixture_expect: "gap books=0 bank=971 gap=-971 since=set",
  },
  {
    id: "cash_card_owed",
    section: "cash",
    question: "What do we owe on the credit cards?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_list_accounts", args: { type: "liability", as_of: "{{as_of}}" }, as: "cards", pick: (d) => d.accounts.filter((a: Payload) => a.cash_kind === "card").map((a: Payload) => `${a.name}=${a.balance_cents}`).join(";") }],
    answer: (v) => String(v.cards),
    fixture_expect: /^Business card=0(;Business credit card=0)?$/,
  },
  {
    id: "health_feeds",
    section: "health",
    question: "When did the feeds last sync? Is anything disconnected?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [
      {
        tool: "books_reconciliation",
        args: {},
        as: "feeds",
        pick: (d) => d.accounts.filter((a: Payload) => a.feed).map((a: Payload) => `${a.feed.connection}:${a.feed.status}:${a.feed.stale}`).join(";"),
      },
    ],
    answer: (v) => String(v.feeds),
    fixture_expect: "Synthetic Amex:active:false",
  },
  {
    id: "health_anything_wrong",
    section: "health",
    question: "Anything weird or wrong in the books?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_attention", args: { include_info: "false" }, as: "attention", pick: (d) => `${d.alert}:${d.items.map((i: Payload) => i.kind).join(",")}` }],
    answer: (v) => String(v.attention),
    fixture_expect: "true:recon_gap",
  },
  {
    id: "health_needs_review",
    section: "health",
    question: "Anything need my review?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_search_transactions", args: { review: "needed", view: "compact", limit: 25 }, as: "total", pick: (d) => d.total }],
    answer: (v) => String(v.total),
    fixture_expect: "0",
  },
  {
    id: "health_no_contact",
    section: "health",
    question: "Which transactions have no contact this year?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_search_transactions", args: { contact: "none", from: "{{ytd.from}}", to: "{{ytd.to}}", view: "compact", limit: 100 }, as: "count", pick: (d) => d.totals.count }],
    answer: (v) => String(v.count),
    fixture_expect: "9",
  },
  {
    id: "health_suggested_contacts",
    section: "health",
    question: "Which contacts are waiting for my approval?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "books_list_contacts", args: { review_status: "suggested", view: "compact" }, as: "total", pick: (d) => d.total }],
    answer: (v) => String(v.total),
    fixture_expect: "0",
  },
  {
    id: "tax_owed",
    section: "tax",
    question: "How much tax do I owe for 2026?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "tax_estimate", args: { year: 2026 }, as: "remaining", pick: (d) => d.remaining_cents }],
    answer: (v) => String(v.remaining),
    fixture_expect: /^-?\d+$/,
  },
  {
    id: "subscriptions_list",
    section: "subscriptions",
    question: "What are my fixed business costs per month?",
    as_of: AS_OF,
    verdict: "answerable",
    budget: { max_calls: 1, max_result_chars: MAX_RESULT_CHARS },
    oracle: [{ tool: "tracker_list_expenses", args: { type: "business" }, as: "monthly", pick: (d) => d.monthly_total_cents }],
    answer: (v) => String(v.monthly),
    fixture_expect: "2500",
  },
];

function periods(asOf: string): Vars {
  const [y, m] = asOf.split("-").map(Number);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lastFrom = new Date(Date.UTC(y, m - 2, 1)),
    lastTo = new Date(Date.UTC(y, m - 1, 0)),
    priorFrom = new Date(Date.UTC(y, m - 3, 1)),
    priorTo = new Date(Date.UTC(y, m - 2, 0));
  return {
    as_of: asOf,
    "ytd.from": `${y}-01-01`,
    "ytd.to": asOf,
    "last_month.from": iso(lastFrom),
    "last_month.to": iso(lastTo),
    "prior_month.from": iso(priorFrom),
    "prior_month.to": iso(priorTo),
  };
}

function resolve(value: unknown, vars: Vars): unknown {
  if (typeof value !== "string") return value;
  const whole = /^\{\{([\w.]+)\}\}$/.exec(value);
  const lookup = (name: string): unknown => {
    if (name in vars) return vars[name];
    const [head, ...rest] = name.split(".");
    return rest.reduce<unknown>((v, key) => (v as Payload | undefined)?.[key], vars[head]);
  };
  if (whole) return lookup(whole[1]);
  return value.replace(/\{\{([\w.]+)\}\}/g, (_, name: string) => String(lookup(name)));
}

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

async function main() {
  // The bank itself: unique ids, Alex can reach every tool it names, and no case writes.
  const alexTools = new Set(toolsForScopes(ALEX_SCOPES).map((t) => t.definition.name));
  const readTools = new Set(MCP_TOOLS.filter((t) => t.definition.annotations.readOnlyHint).map((t) => t.definition.name));
  check("bank: at least 15 cases", CASES.length >= 15, CASES.length);
  check("bank: ids are unique", new Set(CASES.map((c) => c.id)).size === CASES.length);
  for (const c of CASES)
    for (const step of c.oracle) {
      check(`${c.id}: ${step.tool} is on Alex's tool list`, alexTools.has(step.tool));
      check(`${c.id}: ${step.tool} only reads`, readTools.has(step.tool));
    }

  const fixture = await seedApiFixture({ maxRows: 1000 });
  const { db, server, agentId } = fixture;
  try {
    // Questions need a little more than the shared fixture: two contacts and January activity with kinds.
    await db.exec("RESET ROLE; SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [fixtureOwner]);
    const owner = async (command: Payload) =>
      (await db.query<{ r: Payload }>("SELECT accounting.operate($1) r", [JSON.stringify({ key: randomUUID(), command })])).rows[0].r;
    const openai = randomUUID(),
      acme = randomUUID();
    await owner({ type: "party.save", id: openai, expected_version: 0, name: "OpenAI", roles: ["vendor"] });
    await owner({ type: "party.save", id: acme, expected_version: 0, name: "Acme", roles: ["client"] });
    for (const [date, memo, cents, other, kind, payee] of [
      ["2026-01-12", "OPENAI CHATGPT", "-2000", 6, "expense", openai],
      ["2026-01-14", "OPENAI API", "-5000", 6, "expense", openai],
      ["2026-01-22", "Acme retainer", "300000", 5, "income", acme],
      ["2026-01-24", "OpenAI refund", "500", 6, "refund", openai],
    ] as const) {
      const saved = await owner({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo,
        kind,
        payee_id: payee,
        lines: [
          { account_id: account(1), amount_cents: cents },
          { account_id: account(other), amount_cents: (-BigInt(cents)).toString() },
        ],
      });
      await owner({ type: "entry.post", id: saved.id, expected_version: saved.version });
    }
    await db.exec("RESET ROLE;");
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    await seedCardGap(db);

    // Alex's key, with the production scopes.
    const alexKey = `vmfin_${randomUUID().replaceAll("-", "")}`;
    await db.query("INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,created_by,scopes) VALUES('alex',$1,$2,$3,$3,$4)", [
      alexKey.slice(0, 14),
      createHash("sha256").update(alexKey).digest("hex"),
      agentId,
      ALEX_SCOPES,
    ]);

    check("server: the result cap is still 40,000 characters", (await import("../src/lib/mcp/server")).MAX_RESULT_CHARS === MAX_RESULT_CHARS);
    const mcpRoute = await import("../src/app/api/mcp/route");
    const client = new Client({ name: "verify-question-bank", version: "1.0.0" }, {});
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
        requestInit: { headers: { "x-api-key": alexKey } },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new NextRequest(input instanceof Request ? input : String(input), init as ConstructorParameters<typeof NextRequest>[1]);
          if (request.method === "POST") return mcpRoute.POST(request);
          return request.method === "DELETE" ? mcpRoute.DELETE() : mcpRoute.GET();
        },
      }),
    );
    try {
      const listed = new Set((await client.listTools()).tools.map((t) => t.name));
      check("server: Alex's key lists exactly Alex's tools", listed.size === alexTools.size && [...alexTools].every((t) => listed.has(t)), [...listed]);

      const rows: string[] = [];
      for (const c of CASES) {
        const vars: Vars = periods(c.as_of);
        let calls = 0,
          chars = 0,
          ok = true;
        for (const step of c.oracle) {
          const args = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, resolve(v, vars)]));
          const result = (await client.callTool({ name: step.tool, arguments: args })) as { structuredContent?: Payload; content?: { text?: string }[] };
          calls++;
          const size = (result.content?.[0]?.text ?? "").length;
          chars += size;
          const payload = result.structuredContent;
          if (payload?.ok !== true) {
            ok = false;
            check(`${c.id}: ${step.tool} answers ok`, false, payload);
            break;
          }
          check(`${c.id}: ${step.tool} is under the result cap`, size < c.budget.max_result_chars, size);
          if (step.as) vars[step.as] = step.pick ? step.pick(payload.data, vars) : payload.data;
        }
        check(`${c.id}: within ${c.budget.max_calls} call(s)`, calls <= c.budget.max_calls, calls);
        if (!ok) continue;
        const got = c.answer(vars);
        const expected = c.fixture_expect;
        const match = typeof expected === "string" ? got === expected : expected.test(got);
        check(`${c.id}: "${c.question}" answers ${expected}`, match, got);
        rows.push(`${match ? "PASS" : "FAIL"} ${c.id.padEnd(32)} calls ${calls}/${c.budget.max_calls} chars ${String(chars).padStart(6)} answer ${got}`);
      }
      console.log(rows.join("\n"));
      // Let the request log writes that run after each answer finish before the server closes.
      await new Promise((done) => setTimeout(done, 300));
    } finally {
      await client.close();
    }
  } finally {
    await server.close();
    await db.close();
  }
  if (failures.length) {
    console.error(`Question bank: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else console.log(`Question bank: ${CASES.length} questions, ${passed} checks passed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
