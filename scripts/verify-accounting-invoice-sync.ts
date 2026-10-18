import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId as account,
} from "../src/lib/accounting/fixtures";
import {
  booksInvoice,
  publicAddress,
  sourceBaseUrl,
  toCents,
  type SourceTransport,
} from "../supabase/functions/_shared/invoices/contract.ts";
import {
  runInvoiceSources,
  type InvoiceRpc,
} from "../supabase/functions/_shared/invoices/sync.ts";

/** A small invoicing system that follows the published contract, with failures that can be scripted. */
type AppPayment = {
  id: string;
  amount: number;
  paid_date: string;
  external_id: string | null;
  recorded_via: "app" | "api";
};
type AppInvoice = {
  id: string;
  invoice_number: string;
  status: "draft" | "sent" | "overdue" | "paid" | "cancelled";
  date: string;
  due_date: string | null;
  amount: number;
  updated_at: string;
  project: { id: string; name: string };
  customer: {
    name: string | null;
    company: string | null;
    email: string | null;
  };
  line_items: {
    id: string;
    item_type: string;
    description: string;
    amount: number;
    service_start_date: string | null;
    service_end_date: string | null;
  }[];
  payments: AppPayment[];
  tax?: number;
};
function fakeApp() {
  const state = {
    key: "secret-key",
    invoices: new Map<string, AppInvoice>(),
    time: [] as { project_id: string; date: string; amount: number }[],
    scheduled: [] as {
      project_id: string;
      retainer_id: string;
      period_start: string;
      period_end: string;
      amount: number;
    }[],
    failures: [] as {
      method: string;
      status: number;
      store?: boolean;
      body?: string;
    }[],
    requests: [] as string[],
  };
  const reply = (status: number, body: unknown) => ({
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const outstanding = (i: AppInvoice) =>
    Math.round(
      (i.amount - i.payments.reduce((s, p) => s + p.amount, 0)) * 100,
    ) / 100;
  const settle = (i: AppInvoice) => {
    i.status =
      outstanding(i) <= 0 ? "paid" : i.status === "paid" ? "sent" : i.status;
  };
  const transport: SourceTransport = async ({ method, url, apiKey, body }) => {
    const u = new URL(url);
    state.requests.push(`${method} ${u.pathname}`);
    if (apiKey !== state.key)
      return reply(401, {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Invalid API key" },
      });
    const failure =
      state.failures[0]?.method === method ? state.failures.shift() : undefined;
    if (failure && !failure.store)
      return reply(
        failure.status,
        failure.body ?? {
          success: false,
          error: { code: "X", message: `Scripted ${failure.status}` },
        },
      );
    if (method === "GET" && u.pathname === "/api/v1/invoices") {
      const page = Number(u.searchParams.get("page")),
        limit = Number(u.searchParams.get("limit"));
      const all = [...state.invoices.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
      );
      const data = all.slice((page - 1) * limit, page * limit).map((i) => ({
        id: i.id,
        invoice_number: i.invoice_number,
        status: i.status,
        date: i.date,
        due_date: i.due_date,
        amount: i.amount,
        tax_amount: i.tax ?? 0,
        total: Math.round((i.amount + (i.tax ?? 0)) * 100) / 100,
        outstanding: outstanding(i),
        updated_at: i.updated_at,
        project: i.project,
        customer: i.customer,
        lines: i.line_items.map((l) => ({
          key: l.id,
          type: l.item_type,
          description: l.description,
          amount: l.amount,
          service_from: l.service_start_date,
          service_to: l.service_end_date,
        })),
        payments: i.payments,
      }));
      return reply(200, {
        success: true,
        data,
        meta: {
          page,
          limit,
          total: all.length,
          total_pages: Math.ceil(all.length / limit),
        },
      });
    }
    if (method === "GET" && u.pathname === "/api/v1/billing/earned-work") {
      const from = u.searchParams.get("from")!,
        to = u.searchParams.get("to")!;
      return reply(200, {
        success: true,
        data: {
          from,
          to,
          timezone: "America/Phoenix",
          projects: [
            ...new Set([
              ...state.time.map((x) => x.project_id),
              ...state.scheduled.map((x) => x.project_id),
            ]),
          ].map((project) => ({
            project: { id: project, name: `Project ${project}` },
            time: state.time
              .filter(
                (x) =>
                  x.project_id === project && x.date >= from && x.date <= to,
              )
              .map((x) => ({ date: x.date, hours: 1, amount: x.amount })),
            scheduled: state.scheduled
              .filter((x) => x.project_id === project && x.period_start <= to)
              .map(({ project_id: _p, ...x }) => x),
          })),
        },
      });
    }
    const m = u.pathname.match(
      /^\/api\/v1\/projects\/([^/]+)\/invoices\/([^/]+)\/payments(?:\/([^/]+))?$/,
    );
    if (!m)
      return reply(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "No route" },
      });
    const invoice = state.invoices.get(decodeURIComponent(m[2]));
    if (!invoice || invoice.project.id !== decodeURIComponent(m[1]))
      return reply(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "Invoice not found" },
      });
    if (method === "POST") {
      const input = body as {
        amount: number;
        paid_date: string;
        external_id: string;
      };
      const existing = invoice.payments.find(
        (p) => p.external_id === input.external_id,
      );
      if (existing)
        return existing.amount === input.amount &&
          existing.paid_date === input.paid_date
          ? reply(200, {
              success: true,
              data: { payment: existing, replayed: true },
            })
          : reply(409, {
              success: false,
              error: { code: "CONFLICT", message: "Different payment" },
            });
      if (
        invoice.status === "draft" ||
        invoice.status === "cancelled" ||
        input.amount > outstanding(invoice)
      )
        return reply(422, {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Payment exceeds the amount owed",
          },
        });
      const payment: AppPayment = {
        id: randomUUID(),
        amount: input.amount,
        paid_date: input.paid_date,
        external_id: input.external_id,
        recorded_via: "api",
      };
      invoice.payments.push(payment);
      settle(invoice);
      if (failure?.store)
        return reply(failure.status, {
          success: false,
          error: { code: "X", message: "Lost response" },
        });
      return reply(201, { success: true, data: { payment, replayed: false } });
    }
    if (method === "DELETE") {
      const payment = invoice.payments.find(
        (p) => p.id === decodeURIComponent(m[3] ?? ""),
      );
      if (!payment)
        return reply(404, {
          success: false,
          error: { code: "NOT_FOUND", message: "Payment not found" },
        });
      if (payment.recorded_via === "app")
        return reply(403, {
          success: false,
          error: { code: "FORBIDDEN", message: "Recorded by hand" },
        });
      invoice.payments = invoice.payments.filter((p) => p !== payment);
      settle(invoice);
      return reply(200, { success: true });
    }
    return reply(405, {});
  };
  const invoice = (
    id: string,
    project: string,
    date: string,
    amount: number,
    lines: AppInvoice["line_items"],
    status: AppInvoice["status"] = "sent",
  ) =>
    state.invoices.set(id, {
      id,
      invoice_number: `INV-${id}`,
      status,
      date,
      due_date: null,
      amount,
      updated_at: `${date}T00:00:00Z`,
      project: { id: project, name: `Project ${project}` },
      customer: { name: "Pat", company: "Acme Estates", email: null },
      line_items: lines,
      payments: [],
    });
  return { state, transport, invoice };
}

async function main() {
  let checks = 0;
  const check = (actual: unknown, expected: unknown, label?: string) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };

  // ---- Contract pieces ------------------------------------------------------
  check(toCents(0.29), BigInt(29));
  check(toCents(1234.5), BigInt(123450));
  for (const bad of [
    "http://pm.example.com",
    "https://localhost",
    "https://10.0.0.8",
    "https://pm.example.com:8443",
    "https://u:p@pm.example.com",
    "https://pm.example.com/?x=1",
    "https://box.internal",
  ])
    (assert.throws(() => sourceBaseUrl(bad), /address/i), checks++);
  check(
    sourceBaseUrl("https://pm.example.com/base/").href,
    "https://pm.example.com/base",
  );
  check(
    [
      publicAddress("8.8.8.8"),
      publicAddress("192.168.1.2"),
      publicAddress("169.254.1.1"),
      publicAddress("2606:4700::1"),
      publicAddress("fe80::1"),
    ],
    [true, false, false, true, false],
  );
  const corrected = booksInvoice({
    id: "x",
    invoice_number: "X",
    status: "overdue",
    date: "2026-01-01",
    due_date: null,
    amount: 100,
    tax_amount: 8.25,
    total: 108.25,
    updated_at: null,
    project: { id: "p", name: "P" },
    customer: null,
    payments: [],
    lines: [
      {
        key: "l1",
        type: "hourly",
        description: "",
        amount: 120,
        service_from: null,
        service_to: null,
      },
    ],
  });
  // Tax is its own line; a gap between the lines and the amount is one correction line.
  check(
    [
      corrected.status,
      corrected.total_cents,
      corrected.lines.map((l) => `${l.type}:${l.amount_cents}`),
    ],
    ["issued", "10825", ["hourly:12000", "tax:825", "fixed:-2000"]],
  );
  const lineless = booksInvoice({
    id: "y",
    invoice_number: null,
    status: "cancelled",
    date: "2026-01-01",
    due_date: null,
    amount: 50,
    total: 50,
    updated_at: null,
    project: { id: "p", name: null },
    customer: null,
    payments: [],
    lines: [],
  });
  check(
    [lineless.status, lineless.lines[0].key, lineless.lines[0].amount_cents],
    ["void", "legacy:y", "5000"],
  );

  // ---- Books -----------------------------------------------------------------
  const db = await accountingTestDb();
  const cmd = async (c: object, key = randomUUID()) =>
    (
      await db
        .query<{
          r: any;
        }>(
          "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
          [key, JSON.stringify(c)],
        )
        .catch((e) => {
          throw new Error(`${JSON.stringify(c)}: ${e.message}`);
        })
    ).rows[0].r;
  const asSystem = async <T>(fn: () => Promise<T>) => {
    await db.exec("RESET ROLE");
    try {
      return await fn();
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const sql = <T>(text: string, params: unknown[] = []) =>
    asSystem(async () => (await db.query<{ r: T }>(text, params)).rows[0]?.r);
  const rpc: InvoiceRpc = async (command) => {
    await db.exec("RESET ROLE; SET ROLE service_role");
    try {
      return (
        await db.query<{ r: unknown }>(
          "SELECT accounting.invoice_sync_server($1) r",
          [JSON.stringify(command)],
        )
      ).rows[0].r;
    } finally {
      await db.exec("RESET ROLE; SET ROLE authenticated");
    }
  };
  const app = fakeApp();
  const run = (options: { pushOnly?: boolean } = {}) =>
    runInvoiceSources({
      rpc,
      transport: app.transport,
      decrypt: (cipher) => {
        if (cipher === "v1:first") return "secret-key";
        if (cipher === "v1:second") return "second-key";
        throw new Error("unknown key");
      },
      source: "test",
      only: source,
      force: true,
      ...options,
    });
  const link = (entry: string) =>
    sql<any>(
      "SELECT to_jsonb(p) r FROM accounting.invoice_payments p WHERE p.entry_id=$1 ORDER BY created_at DESC LIMIT 1",
      [entry],
    );
  const revision = () =>
    sql<string>("SELECT financial_revision::text r FROM accounting.settings");
  const source = randomUUID();
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: [1, 9].some((n) => account(n) === a.id)
          ? "bank"
          : a.id === account(3)
            ? "card"
            : "none",
      })),
    });
    const suspense = await sql<string>(
      "SELECT id r FROM accounting.accounts WHERE system_purpose='uncategorized_income'",
    );
    const client = randomUUID();
    await cmd({
      type: "party.save",
      id: client,
      expected_version: 0,
      name: "Acme Estates",
      roles: ["client"],
    });
    await cmd({
      type: "invoice_source.save",
      id: source,
      expected_version: 0,
      name: "PM app",
      base_url: "https://pm.example.com",
      api_key_encrypted: "v1:first",
      account_map: {
        hourly: account(5),
        fixed: account(5),
        recurring: account(5),
      },
      party_map: { "proj-a": client },
    });
    // The source has been connected since January, so the year's deposits are new money that links on its own.
    await sql(
      "UPDATE accounting.invoice_sources SET created_at='2026-01-01T12:00:00Z' WHERE id=$1 RETURNING 1 r",
      [source],
    );
    const deposit = async (date: string, cents: string) =>
      cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: `Deposit ${cents}`,
        payee_id: client,
        lines: [
          { account_id: account(1), amount_cents: cents, memo: "" },
          { account_id: suspense, amount_cents: `-${cents}`, memo: "" },
        ],
      });
    app.invoice("1", "proj-a", "2026-03-01", 5000, [
      {
        id: "1a",
        item_type: "hourly",
        description: "Hours",
        amount: 5000,
        service_start_date: null,
        service_end_date: null,
      },
    ]);
    app.invoice("2", "proj-a", "2026-04-01", 3000, [
      {
        id: "2a",
        item_type: "recurring",
        description: "April",
        amount: 3000,
        service_start_date: "2026-04-01",
        service_end_date: "2026-04-30",
      },
    ]);
    app.invoice("3", "proj-a", "2026-02-01", 1200, [
      {
        id: "3a",
        item_type: "fixed",
        description: "Setup",
        amount: 1200,
        service_start_date: null,
        service_end_date: null,
      },
    ]);
    app.state.invoices.get("3")!.payments.push({
      id: "hand",
      amount: 1200,
      paid_date: "2026-02-10",
      external_id: null,
      recorded_via: "app",
    });
    app.state.invoices.get("3")!.status = "paid";
    app.state.time.push(
      { project_id: "proj-a", date: "2026-02-20", amount: 1200 },
      { project_id: "proj-a", date: "2026-02-21", amount: 300 },
    );
    app.state.scheduled.push({
      project_id: "proj-a",
      retainer_id: "r1",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      amount: 3000,
    });

    // ---- A first pull ---------------------------------------------------------
    let result = await run();
    check(result.sources[0].status, "synced", result.sources[0].error);
    check(
      await sql<number>(
        "SELECT count(*)::int r FROM accounting.invoices WHERE source_id=$1",
        [source],
      ),
      3,
    );
    check(
      await sql<string>(
        "SELECT status r FROM accounting.invoices WHERE external_id='3'",
      ),
      "paid",
    );
    check(
      await sql<any>(
        "SELECT jsonb_agg(kind||':'||external_ref||':'||amount_cents ORDER BY kind,external_ref) r FROM accounting.earned_work",
      ),
      [
        "scheduled:r1:2026-05-01:300000",
        "time:proj-a:2026-02-20:120000",
        "time:proj-a:2026-02-21:30000",
      ],
    );
    check(
      await sql<string>(
        "SELECT to_char(last_synced_at,'YYYY') r FROM accounting.invoice_sources",
      ),
      String(new Date().getFullYear()),
    );
    // A quiet hour changes nothing and never moves the books revision.
    const quiet = await revision();
    result = await run();
    check(
      [result.sources[0].changed, result.sources[0].removed, await revision()],
      [0, 0, quiet],
    );

    // ---- An exact match links, and the source records the payment --------------
    const d1 = await deposit("2026-03-12", "500000");
    result = await run();
    check(result.sources[0].linked, 1);
    let l1 = await link(d1.id);
    check(
      [l1.sync_state, l1.matched_by, app.state.invoices.get("1")!.status],
      ["synced", "rule", "paid"],
    );
    const recorded = app.state.invoices.get("1")!.payments[0];
    check(
      [
        recorded.external_id,
        recorded.amount,
        recorded.paid_date,
        l1.external_payment_id,
      ],
      [l1.id, 5000, "2026-03-12", recorded.id],
    );

    // ---- Already paid at the source by hand: linked in the books, nothing recorded twice ----
    const d3 = await deposit("2026-02-10", "120000");
    await run();
    const l3 = await link(d3.id);
    check(
      [
        l3.sync_state,
        l3.external_payment_id,
        app.state.invoices.get("3")!.payments.length,
      ],
      ["synced", null, 1],
    );

    // ---- Unlinking removes the payment the books recorded ------------------------
    await cmd({
      type: "invoice.unlink",
      id: l1.id,
      expected_version: l1.version,
      reason: "Wrong invoice",
    });
    await run({ pushOnly: true });
    l1 = await link(d1.id);
    check(
      [
        l1.sync_state,
        app.state.invoices.get("1")!.payments.length,
        app.state.invoices.get("1")!.status,
      ],
      ["removed", 0, "sent"],
    );

    // ---- A server error backs off; a lost response is recorded once -------------------
    await cmd({
      type: "invoice.link",
      id: randomUUID(),
      entry_id: d1.id,
      allocations: [
        {
          invoice_id: await sql<string>(
            "SELECT id r FROM accounting.invoices WHERE external_id='1'",
          ),
          amount_cents: "500000",
        },
      ],
    });
    app.state.failures.push({ method: "POST", status: 500 });
    await run({ pushOnly: true });
    let l1b = await link(d1.id);
    check(
      [
        l1b.sync_state,
        l1b.attempts,
        l1b.last_error,
        Date.parse(l1b.next_attempt_at) > Date.now(),
      ],
      ["pending", 1, "The invoicing system answered HTTP 500.", true],
    );
    const before = app.state.requests.length;
    await run({ pushOnly: true });
    check(
      app.state.requests.slice(before).filter((r) => r.startsWith("POST"))
        .length,
      0,
      "not due yet",
    );
    await sql(
      "UPDATE accounting.invoice_payments SET next_attempt_at=now()-interval '1 minute' WHERE id=$1 RETURNING 1 r",
      [l1b.id],
    );
    app.state.failures.push({ method: "POST", status: 502, store: true });
    await run({ pushOnly: true });
    check((await link(d1.id)).sync_state, "pending");
    await sql(
      "UPDATE accounting.invoice_payments SET next_attempt_at=now()-interval '1 minute' WHERE id=$1 RETURNING 1 r",
      [l1b.id],
    );
    await run({ pushOnly: true });
    l1b = await link(d1.id);
    check(
      [
        l1b.sync_state,
        app.state.invoices.get("1")!.payments.length,
        l1b.external_payment_id,
      ],
      ["synced", 1, app.state.invoices.get("1")!.payments[0].id],
    );

    // ---- A refusal stops for the owner, and a retry goes back in line ------------------
    app.invoice("4", "proj-a", "2026-05-02", 1000, [
      {
        id: "4a",
        item_type: "fixed",
        description: "Extra",
        amount: 1000,
        service_start_date: null,
        service_end_date: null,
      },
    ]);
    const d4 = await deposit("2026-05-03", "100000");
    app.state.failures.push({ method: "POST", status: 422 });
    await run();
    let l4 = await link(d4.id);
    check([l4.sync_state, l4.last_error], ["failed", "Scripted 422"]);
    await cmd({
      type: "invoice.retry",
      id: l4.id,
      expected_version: l4.version,
    });
    await run({ pushOnly: true });
    l4 = await link(d4.id);
    check(
      [l4.sync_state, app.state.invoices.get("4")!.status],
      ["synced", "paid"],
    );

    // ---- A discarded deposit takes its payment back off the source ----------------------
    const entry4 = await cmd({
      type: "draft.discard",
      id: d4.id,
      expected_version: (
        await db.query<{ r: any }>("SELECT accounting.entry_detail($1) r", [
          d4.id,
        ])
      ).rows[0].r.version,
      reason: "Duplicate",
    });
    check(!!entry4, true);
    await run();
    l4 = await link(d4.id);
    check(
      [
        l4.sync_state,
        l4.removed_reason,
        app.state.invoices.get("4")!.payments.length,
      ],
      ["removed", "Deposit discarded or reversed", 0],
    );

    // ---- An invoice gone from a complete listing is marked, and comes back ----------------
    const parked = app.state.invoices.get("2")!;
    app.state.invoices.delete("2");
    result = await run();
    check(
      [
        result.sources[0].removed,
        await sql<boolean>(
          "SELECT removed_at IS NOT NULL r FROM accounting.invoices WHERE external_id='2'",
        ),
      ],
      [1, true],
    );
    app.state.invoices.set("2", parked);
    await run();
    check(
      await sql<boolean>(
        "SELECT removed_at IS NULL r FROM accounting.invoices WHERE external_id='2'",
      ),
      true,
    );

    // ---- Data the books do not understand changes nothing -----------------------------
    const count = await sql<number>(
      "SELECT count(*)::int r FROM accounting.invoices",
    );
    app.invoice("bad", "proj-a", "2026-06-01", 10, []);
    (app.state.invoices.get("bad") as any).status = "weird";
    result = await run();
    check(
      [
        result.sources[0].status,
        await sql<number>("SELECT count(*)::int r FROM accounting.invoices"),
      ],
      ["error", count],
    );
    check(
      await sql<string>("SELECT last_error r FROM accounting.invoice_sources"),
      "The source returned invoices the books do not understand.",
    );
    app.state.invoices.delete("bad");

    // ---- A refused key stops the source until the owner pastes a new one -------------------
    app.state.key = "second-key";
    result = await run();
    check(
      [
        result.sources[0].status,
        await sql<string>("SELECT status r FROM accounting.invoice_sources"),
      ],
      ["error", "auth_failed"],
    );
    check(
      await sql<boolean>(
        "SELECT lease_run_id IS NULL r FROM accounting.invoice_sources",
      ),
      true,
    );
    check(await rpc({ action: "due" }), []);
    const saved = await sql<number>(
      "SELECT version r FROM accounting.invoice_sources",
    );
    await cmd({
      type: "invoice_source.save",
      id: source,
      expected_version: saved,
      api_key_encrypted: "v1:second",
    });
    check(
      [
        await sql<string>("SELECT status r FROM accounting.invoice_sources"),
        await sql<string>(
          "SELECT last_error r FROM accounting.invoice_sources",
        ),
      ],
      ["active", ""],
    );
    result = await run();
    check(result.sources[0].status, "synced");

    // ---- Deposits from before the connection wait for the owner's batch review ----------
    await sql(
      "UPDATE accounting.invoice_sources SET created_at='2026-05-01T12:00:00Z' WHERE id=$1 RETURNING 1 r",
      [source],
    );
    app.invoice("5", "proj-a", "2026-04-01", 900, [
      {
        id: "5a",
        item_type: "fixed",
        description: "April extra",
        amount: 900,
        service_start_date: null,
        service_end_date: null,
      },
    ]);
    const d5 = await deposit("2026-04-10", "90000");
    result = await run();
    check(
      [result.sources[0].status, result.sources[0].linked, await link(d5.id)],
      ["synced", 0, undefined],
    );
    const review = await db.query<{ r: any }>(
      "SELECT accounting.receivables($1) r",
      [JSON.stringify({ matches: "true" })],
    );
    const match = review.rows[0].r.matches.find(
      (m: any) => m.entry_id === d5.id,
    );
    check(
      [match?.suggestion.reason, match?.suggestion.auto, match?.amount_cents],
      ["exact_client", true, "90000"],
    );
    const batch = await cmd({ type: "invoice.auto_link", id: randomUUID() });
    check(
      batch.links.some((l: any) => l.entry_id === d5.id),
      true,
    );
    await run({ pushOnly: true });
    check(
      [(await link(d5.id)).sync_state, app.state.invoices.get("5")!.status],
      ["synced", "paid"],
    );

    // ---- Only the worker reaches the sync entry point -------------------------------------
    await assert.rejects(
      db.query('SELECT accounting.invoice_sync_server(\'{"action":"due"}\')'),
      /permission denied|ACCT_WORKER_REQUIRED/,
    );
    checks++;

    console.log(`Invoice source sync and push: ${checks} checks passed.`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
