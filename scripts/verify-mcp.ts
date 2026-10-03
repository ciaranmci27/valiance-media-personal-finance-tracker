/**
 * Finance MCP server end to end: the real /api/mcp route, the real v1 route
 * handlers it calls and the real supabase-js client, against the pglite
 * fixture behind the PostgREST stand-in. Clients are the official SDK client
 * in both protocol eras (the legacy initialize handshake Hermes sends, and
 * 2026-07-28), plus raw JSON-RPC posts shaped like Hermes's.
 *
 * Run: npx tsx --tsconfig tsconfig.api-test.json scripts/verify-mcp.ts
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AGENT, booksDay, seedApiFixture, seedCardGap } from "./api-test-fixture";
import { fixtureAccountId as account } from "../src/lib/accounting/fixtures";
import { API_OPERATIONS, type ApiOperation } from "../src/lib/api/operations";
import { GUIDE_TOOL, MCP_TOOLS, MCP_TOOL_NAMES } from "../src/lib/mcp/tools";

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool payloads are checked field by field
type Payload = Record<string, any>;
type ToolResult = { isError?: boolean; structuredContent?: Payload; content?: { type: string; text?: string }[] };

async function main() {
  // The catalog, before any database: one tool per operation, names and
  // leads within Hermes's limits, schemas with an object root.
  const names = MCP_TOOLS.map((tool) => tool.definition.name);
  check("catalog: one tool per operation plus the guide", MCP_TOOLS.length === API_OPERATIONS.length + 1 && names[0] === GUIDE_TOOL, MCP_TOOLS.length);
  check("catalog: names are unique", new Set(names).size === names.length);
  check(
    "catalog: names are snake_case, at most 50 characters, with a domain noun",
    names.every((name) => /^[a-z][a-z0-9_]{0,49}$/.test(name) && /^(books|tracker|tax|finance)_/.test(name)),
    names,
  );
  for (const [id, entry] of Object.entries(MCP_TOOL_NAMES)) {
    const tool = MCP_TOOLS.find((t) => t.operation?.id === id);
    check(`catalog: ${entry.tool} lead is one sentence of 60 characters or fewer`, entry.lead.length <= 60 && entry.lead.endsWith(".") && !entry.lead.slice(0, -1).includes(". "), entry.lead);
    check(`catalog: ${entry.tool} description opens with its lead`, !!tool?.definition.description.startsWith(entry.lead));
  }
  for (const tool of MCP_TOOLS) {
    const { definition, operation } = tool;
    const schema = definition.inputSchema as { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
    check(`schema: ${definition.name} has an object root`, schema.type === "object" && typeof schema.properties === "object" && schema.additionalProperties === false);
    check(`schema: ${definition.name} serializes`, JSON.stringify(schema).length > 0 && !JSON.stringify(schema).includes('"$schema"'));
    if (!operation) continue;
    check(`annotations: ${definition.name} read-only exactly when GET`, definition.annotations.readOnlyHint === (operation.method === "GET"));
    check(`annotations: ${definition.name} delete is destructive`, operation.method !== "DELETE" || definition.annotations.destructiveHint);
    check(`schema: ${definition.name} offers idempotency_key exactly on creates`, ("idempotency_key" in schema.properties) === !!operation.idempotent);
    check(`description: ${definition.name} has no header instructions`, !/Idempotency-Key/.test(definition.description));
    check(`description: ${definition.name} names tools, not REST paths`, !/(GET |POST )?\/(books|tracker|tax)\b/.test(JSON.stringify(definition)), definition.description);
    check(`annotations: ${definition.name} is additive only when it creates`, definition.annotations.destructiveHint === (operation.method !== "GET" && !operation.id.endsWith("_create")));
  }

  const fixture = await seedApiFixture({ maxRows: 1000 });
  const { db, server, fullKey, booksOnly, agentId } = fixture;
  try {
    const mcpRoute = await import("../src/app/api/mcp/route");
    const { routeHandler } = await import("../src/lib/mcp/handlers");
    const { runOperation } = await import("../src/lib/mcp/server");
    const summaryRoute = await import("../src/app/api/v1/books/summary/route");

    for (const op of API_OPERATIONS as readonly ApiOperation[])
      check(`handlers: ${op.id} runs ${op.method} ${op.path}`, !!routeHandler(op.path, op.method));

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      mcpRoute.POST(
        new NextRequest("http://localhost/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
          body: JSON.stringify(body),
        }),
      );
    // A legacy response may be JSON or one SSE event; read either.
    const rpc = async (response: Response): Promise<Payload> => {
      const text = await response.text();
      const data = /^data: (.*)$/m.exec(text)?.[1];
      return JSON.parse(data ?? text) as Payload;
    };
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hermes", version: "2026.7.20" } },
    };

    // The door: method, key, origin.
    const get = await mcpRoute.GET();
    check("http: GET is 405 with Allow: POST", get.status === 405 && get.headers.get("allow") === "POST");
    const noKey = await post(initialize);
    const noKeyBody = await rpc(noKey);
    check("http: no key is 401 missing_api_key", noKey.status === 401 && noKeyBody.error?.data?.reason === "missing_api_key", noKeyBody);
    const bogus = await post(initialize, { "x-api-key": "vmfin_nope" });
    check("http: unknown key is 401 invalid_api_key", bogus.status === 401 && (await rpc(bogus)).error?.data?.reason === "invalid_api_key");
    const foreign = await post(initialize, { "x-api-key": fullKey, origin: "https://evil.example" });
    check("http: a foreign Origin is 403", foreign.status === 403);
    const sameOrigin = await post(initialize, { "x-api-key": fullKey, origin: "http://localhost" });
    check("http: the app's own Origin is allowed", sameOrigin.status === 200, sameOrigin.status);
    const bearer = await post(initialize, { authorization: `Bearer ${fullKey}` });
    check("http: Authorization: Bearer works too", bearer.status === 200, bearer.status);

    // Hermes's legacy handshake, raw.
    const hello = await post(initialize, { "x-api-key": fullKey });
    const helloBody = await rpc(hello);
    check(
      "legacy: initialize answers with tools and the server's name",
      hello.status === 200 && helloBody.result?.serverInfo?.name === "valiance-finance" && !!helloBody.result?.capabilities?.tools,
      helloBody,
    );
    check("legacy: no session id (stateless)", !hello.headers.get("mcp-session-id"));
    const legacyHeaders = { "x-api-key": fullKey, "mcp-protocol-version": String(helloBody.result?.protocolVersion ?? "2025-06-18") };
    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, legacyHeaders);
    check("legacy: initialized notification is accepted", initialized.status === 202, initialized.status);
    const ping = await rpc(await post({ jsonrpc: "2.0", id: 2, method: "ping" }, legacyHeaders));
    check("legacy: ping", !!ping.result && !ping.error, ping);
    const rawList = await rpc(await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, legacyHeaders));
    check("legacy: tools/list without a session", rawList.result?.tools?.length === MCP_TOOLS.length, rawList.result?.tools?.length);

    // The SDK client, both eras.
    const connect = async (key: string, era: "legacy" | "modern") => {
      const client = new Client(
        { name: "verify-mcp", version: "1.0.0" },
        era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      );
      const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
        requestInit: { headers: { "x-api-key": key } },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new NextRequest(input instanceof Request ? input : String(input), init as ConstructorParameters<typeof NextRequest>[1]);
          if (request.method === "POST") return mcpRoute.POST(request);
          return request.method === "DELETE" ? mcpRoute.DELETE() : mcpRoute.GET();
        },
      });
      await client.connect(transport);
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolResult;

    const legacy = await connect(fullKey, "legacy");
    const modern = await connect(fullKey, "modern");
    const narrow = await connect(booksOnly, "legacy");
    try {
      const allTools = (await legacy.listTools()).tools;
      check("client legacy: a full key lists every tool", allTools.length === MCP_TOOLS.length, allTools.length);
      const modernTools = (await modern.listTools()).tools;
      check("client modern: the same list on 2026-07-28", modernTools.length === MCP_TOOLS.length && modernTools.every((t, i) => t.name === allTools[i]?.name), modernTools.length);
      const summaryTool = allTools.find((t) => t.name === "books_summary");
      check("client: annotations reach the client", summaryTool?.annotations?.readOnlyHint === true && summaryTool?.annotations?.openWorldHint === false, summaryTool?.annotations);
      const deleteTool = allTools.find((t) => t.name === "tracker_delete_expense");
      check("client: deletes are marked destructive", deleteTool?.annotations?.destructiveHint === true && deleteTool?.annotations?.readOnlyHint === false);

      const narrowTools = (await narrow.listTools()).tools.map((t) => t.name);
      const readBooks = MCP_TOOLS.filter((t) => t.scope === "accounting.read").map((t) => t.definition.name);
      check(
        "per key: a books-only key sees the guide and the books reads, nothing else",
        narrowTools.length === readBooks.length + 1 && narrowTools[0] === GUIDE_TOOL && readBooks.every((name) => narrowTools.includes(name)),
        narrowTools,
      );
      check("per key: no write tool for a read-only key", !narrowTools.some((name) => /create|replace|categorize|split|propose|add_|update|delete/.test(name)));
      const hidden = await call(narrow, "tracker_list_expenses");
      check("per key: an unlisted tool is refused, not an error", hidden.isError !== true && hidden.structuredContent?.error?.reason === "unknown_tool", hidden);

      // A member permission taken away hides its tools even on a key that has the scope.
      await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'tax.read','deny') ON CONFLICT (member_id, permission_key) DO UPDATE SET effect='deny'", [agentId]);
      const withoutTax = (await legacy.listTools()).tools.map((t) => t.name);
      check("per key: the member's own permissions also filter the list", !withoutTax.includes("tax_estimate") && withoutTax.includes("books_summary"));
      await db.query("UPDATE public.team_member_permissions SET effect='allow' WHERE member_id=$1 AND permission_key='tax.read'", [agentId]);

      // The guide.
      const guide = await call(legacy, GUIDE_TOOL);
      check("guide: read-only answer with conventions and this key's tools", guide.structuredContent?.ok === true && /integer cents/.test(guide.structuredContent?.guide) && guide.structuredContent?.tools?.length === MCP_TOOLS.length - 1, guide.structuredContent?.tools?.length);
      check("guide: says who the key acts as", guide.structuredContent?.you?.name === "Jeff" && guide.structuredContent?.you?.role === "agent");
      const narrowGuide = await call(narrow, GUIDE_TOOL);
      check("guide: lists only the narrow key's tools", narrowGuide.structuredContent?.tools?.length === readBooks.length);

      // A read equals REST.
      const viaMcp = await call(legacy, "books_summary", { from: "2026-01-01", to: "2026-12-31" });
      const viaRest = (await (
        await summaryRoute.GET(new NextRequest("http://localhost/api/v1/books/summary?from=2026-01-01&to=2026-12-31", { headers: { "x-api-key": fullKey } }), {
          params: Promise.resolve({}),
        })
      ).json()) as Payload;
      check("read: books_summary equals the REST answer", JSON.stringify(viaMcp.structuredContent?.data) === JSON.stringify(viaRest.data) && viaMcp.structuredContent?.source === "books", viaMcp.structuredContent);
      check("read: the text block carries the same JSON", JSON.parse(viaMcp.content?.find((c) => c.type === "text")?.text ?? "{}").data?.income_cents === viaRest.data?.income_cents);
      const viaModern = await call(modern, "books_summary", { from: "2026-01-01", to: "2026-12-31" });
      check("read: the same answer on 2026-07-28", JSON.stringify(viaModern.structuredContent?.data) === JSON.stringify(viaRest.data));
      const defaultPage = await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31" });
      const listed = defaultPage.structuredContent?.data;
      check("read: agents get 25 rows by default (REST keeps 50)", listed?.limit === 25, listed?.limit);
      check("read: list rows are compact: no lines, a line count, the version", listed?.transactions?.every((t: Payload) => !("lines" in t) && typeof t.line_count === "number" && typeof t.version === "number"), listed?.transactions?.[0]);
      const page = await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", limit: 2 });
      check("read: numbers in the query reach the API as numbers", page.structuredContent?.data?.transactions?.length === 2 && page.structuredContent?.data?.next_offset === 2, page.structuredContent);
      const report = await call(legacy, "books_get_report", { id: "profit-loss", from: "2026-01-01", to: "2026-12-31" });
      check("read: path parameters", report.structuredContent?.ok === true && report.structuredContent?.data?.id === "profit-loss", report.structuredContent);
      const tracker = await call(legacy, "tracker_list_expenses");
      check("read: tracker answers are labelled tracker", tracker.structuredContent?.source === "tracker");

      // Refusals the agent can fix come back as results, not errors.
      const badDate = await call(legacy, "books_summary", { from: "2026-1-1" });
      check("refusal: a bad date is ok:false 422, not isError", badDate.isError !== true && badDate.structuredContent?.ok === false && badDate.structuredContent?.status === 422 && badDate.structuredContent?.error?.reason === "invalid_parameters", badDate);
      const extra = await call(legacy, "books_summary", { form: "2026-01-01" });
      check("refusal: an unknown argument is 422", extra.structuredContent?.status === 422 && extra.isError !== true, extra.structuredContent);
      const ghost = await call(legacy, "books_get_transaction", { id: randomUUID() });
      check("refusal: an unknown id is ok:false 404, not isError", ghost.isError !== true && ghost.structuredContent?.status === 404, ghost.structuredContent);
      const noId = await call(legacy, "books_get_transaction");
      check("refusal: a missing path parameter is 422", noId.structuredContent?.status === 422, noId.structuredContent);
      const wrongBody = await call(legacy, "books_create_draft", { entry_date: "2026-03-01", memo: "x", lines: [{ account_id: account(6), amount_cents: "100" }] });
      check("refusal: an unbalanced draft is 422 with issues", wrongBody.structuredContent?.status === 422 && Array.isArray(wrongBody.structuredContent?.error?.issues), wrongBody.structuredContent);

      // A draft through MCP is a draft, audited as the API, logged as MCP.
      const draftArgs = {
        entry_date: "2026-03-15",
        memo: "Accrued hosting (MCP)",
        lines: [
          { account_id: account(6), amount_cents: "1500" },
          { account_id: account(8), amount_cents: "-1500" },
        ],
      };
      const created = await call(legacy, "books_create_draft", draftArgs);
      const draft = created.structuredContent;
      check("write: books_create_draft makes a draft with a review link", draft?.ok === true && draft?.data?.status === "draft" && String(draft?.data?.review_url).startsWith("http://localhost/accounting?view=journal&entry="), draft);
      check("write: the server made and returned an idempotency key", /^[0-9a-f-]{36}$/.test(draft?.idempotency_key ?? ""), draft?.idempotency_key);
      const stored = await db.query<{ status: string }>("SELECT status FROM accounting.journal_entries WHERE id=$1", [draft?.data?.id]);
      check("write: stored as a draft", stored.rows[0]?.status === "draft", stored.rows);
      const audit = await db.query<{ actor_kind: string; api_key_id: string | null }>("SELECT actor_kind, api_key_id FROM accounting.audit_log WHERE table_name='journal_entries' AND row_id=$1 LIMIT 1", [draft?.data?.id]);
      check("write: audited as the API with its key", audit.rows[0]?.actor_kind === "api" && !!audit.rows[0]?.api_key_id, audit.rows);

      const again = await call(legacy, "books_create_draft", { ...draftArgs, idempotency_key: draft?.idempotency_key });
      check("write: a retry with the same key replays, it does not write twice", again.structuredContent?.replayed === true && again.structuredContent?.data?.id === draft?.data?.id, again.structuredContent);
      const count = await db.query<{ n: number }>("SELECT count(*)::int n FROM accounting.journal_entries WHERE memo='Accrued hosting (MCP)'");
      check("write: still one draft", count.rows[0]?.n === 1, count.rows);
      const ownKey = randomUUID();
      const first = await call(modern, "books_create_draft", { ...draftArgs, memo: "Second (MCP)", idempotency_key: ownKey });
      check("write: an agent's own idempotency key is used", first.structuredContent?.idempotency_key === ownKey && first.structuredContent?.ok === true, first.structuredContent);
      const conflict = await call(modern, "books_create_draft", { ...draftArgs, memo: "Different", idempotency_key: ownKey });
      check("write: the same key for a different create is ok:false 409", conflict.isError !== true && conflict.structuredContent?.status === 409, conflict.structuredContent);

      // The agent's own loop, through MCP only: read the draft, send its version back.
      const readBack = await call(legacy, "books_get_transaction", { id: draft?.data?.id });
      check("workflow: a draft reads back with its version and lines", typeof readBack.structuredContent?.data?.version === "number" && readBack.structuredContent?.data?.lines?.length === 2, readBack.structuredContent?.data);
      const replaced = await call(legacy, "books_replace_draft", { id: draft?.data?.id, expected_version: readBack.structuredContent?.data?.version, ...draftArgs, memo: "Accrued hosting, corrected (MCP)" });
      check("workflow: replacing with the version just read succeeds", replaced.structuredContent?.ok === true && replaced.structuredContent?.data?.status === "draft", replaced.structuredContent);
      const stale = await call(legacy, "books_replace_draft", { id: draft?.data?.id, expected_version: readBack.structuredContent?.data?.version, ...draftArgs });
      check("workflow: the old version again is ok:false stale_version", stale.isError !== true && stale.structuredContent?.status === 409 && stale.structuredContent?.error?.reason === "stale_version", stale.structuredContent);

      const nullKey = await call(legacy, "books_create_draft", { ...draftArgs, memo: "Null key (MCP)", idempotency_key: null });
      check("write: a null idempotency_key is treated as left out", nullKey.structuredContent?.ok === true && /^[0-9a-f-]{36}$/.test(nullKey.structuredContent?.idempotency_key ?? ""), nullKey.structuredContent);

      const contactPage = await call(legacy, "books_list_contacts", {});
      check("read: contacts default to 100 a page over MCP", contactPage.structuredContent?.data?.limit === 100, contactPage.structuredContent?.data);

      // Contacts, end to end: suggest one, meet the duplicate guard, fill blank contacts on reviewed transactions.
      const hetzner = await call(legacy, "books_add_contact", { name: "Hetzner", roles: ["vendor"] });
      const hetznerId = hetzner.structuredContent?.data?.id as string;
      check("contacts: added over MCP as a suggestion", hetzner.structuredContent?.ok === true && hetzner.structuredContent?.data?.review_status === "suggested", hetzner.structuredContent);
      const hetznerAgain = await call(legacy, "books_add_contact", { name: "Hetzner Inc.", roles: ["vendor"] });
      check(
        "contacts: a duplicate over MCP is ok:false duplicate, naming the contact to use",
        hetznerAgain.isError !== true && hetznerAgain.structuredContent?.status === 409 && hetznerAgain.structuredContent?.error?.reason === "duplicate" && hetznerAgain.structuredContent?.error?.existing?.id === hetznerId,
        hetznerAgain.structuredContent,
      );
      const blankRows = await call(legacy, "books_search_transactions", { contact: "none", status: "posted", limit: 2 });
      const targets = (blankRows.structuredContent?.data?.transactions ?? []) as { id: string; version: number; contact_id: string | null }[];
      check("contacts: reviewed transactions without a contact are listed", targets.length === 2 && targets.every((row) => row.contact_id === null), blankRows.structuredContent?.data);
      const assigned = await call(legacy, "books_assign_contact", { id: hetznerId, entries: targets.map((row) => ({ id: row.id, expected_version: row.version })) });
      check("contacts: assign over MCP fills both", assigned.structuredContent?.ok === true && assigned.structuredContent?.data?.entries?.length === 2, assigned.structuredContent);
      const assignedRow = await call(legacy, "books_get_transaction", { id: targets[0]?.id });
      check(
        "contacts: the reviewed transaction now names its contact and stays posted",
        assignedRow.structuredContent?.data?.contact_id === hetznerId && assignedRow.structuredContent?.data?.contact_name === "Hetzner" && assignedRow.structuredContent?.data?.status === "posted",
        assignedRow.structuredContent?.data,
      );
      const reassigned = await call(legacy, "books_assign_contact", { id: hetznerId, entries: [{ id: targets[0]?.id, expected_version: assignedRow.structuredContent?.data?.version }] });
      check("contacts: a set contact is never replaced over MCP", reassigned.structuredContent?.error?.reason === "contact_already_set", reassigned.structuredContent);
      const proposed = await call(legacy, "books_propose_rule", { name: "Hosting", conditions: { descriptor_key: { contains: "HOSTING" } }, actions: { account_id: account(6) } });
      check("write: a proposed rule links to the rules screen", proposed.structuredContent?.data?.review_url === "http://localhost/accounting?view=manage&section=rules", proposed.structuredContent);

      // ---- Agent tools: totals, sort, ranges, compact rows, report filters and top-N, ledger limit, contacts.
      const cashAccounts = new Set([account(1), account(3), account(9)]);
      const fullYear = await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", limit: 100 });
      const yearRows = (await call(legacy, "books_get_transaction", { id: fullYear.structuredContent?.data?.transactions?.[0]?.id })).structuredContent?.data;
      check("x1: full rows still read back whole", !!yearRows?.lines);
      // Totals from each row's own lines: one bank, card or cash line is money in or out; anything else adds to neither side.
      let expectIn = BigInt(0),
        expectOut = BigInt(0),
        expectOther = 0;
      for (const row of fullYear.structuredContent?.data?.transactions ?? []) {
        const detail = (await call(legacy, "books_get_transaction", { id: row.id })).structuredContent?.data;
        const cash = (detail?.lines ?? []).filter((l: Payload) => cashAccounts.has(l.account_id));
        if (cash.length !== 1) expectOther++;
        else if (BigInt(cash[0].amount_cents) > BigInt(0)) expectIn += BigInt(cash[0].amount_cents);
        else expectOut -= BigInt(cash[0].amount_cents);
      }
      const totals = fullYear.structuredContent?.data?.totals;
      check(
        "x1: totals add every match's bank line, money in and out apart",
        totals?.count === fullYear.structuredContent?.data?.total && totals?.in_cents === String(expectIn) && totals?.out_cents === String(expectOut) && totals?.net_cents === String(expectIn - expectOut) && totals?.without_bank_line === expectOther,
        { totals, expectIn: String(expectIn), expectOut: String(expectOut), expectOther },
      );
      const pageOfTwo = await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", limit: 2 });
      check("x1: totals are over every match, not the page", JSON.stringify(pageOfTwo.structuredContent?.data?.totals) === JSON.stringify(totals) && pageOfTwo.structuredContent?.data?.transactions?.length === 2);
      const compact = await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", view: "compact", limit: 100 });
      const compactRows = (compact.structuredContent?.data?.transactions ?? []) as Payload[];
      check(
        "x1: compact rows carry exactly the short fields",
        compactRows.length === totals?.count &&
          compactRows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(["amount_cents", "bank_account", "categories", "contact_name", "date", "description", "id", "reviewed", "status", "transfer"])),
        compactRows[0],
      );
      const perRow = JSON.stringify(compactRows).length / Math.max(compactRows.length, 1);
      check("x1: a compact row is small enough that 100 fit far under the cap", perRow < 300 && perRow * 100 < 30_000, perRow);
      const fullPerRow = JSON.stringify(fullYear.structuredContent?.data?.transactions).length / Math.max(compactRows.length, 1);
      check("x1: compact rows are well under half a full row", perRow * 2 < fullPerRow, { perRow, fullPerRow });
      const byAmount = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", sort: "amount_desc", view: "compact", limit: 100 })).structuredContent?.data?.transactions as Payload[];
      const sizes = byAmount.map((r) => (BigInt(r.amount_cents) < BigInt(0) ? -BigInt(r.amount_cents) : BigInt(r.amount_cents)));
      check("x1: sort=amount_desc is biggest first", sizes.every((s, i) => i === 0 || sizes[i - 1] >= s) && sizes.length > 2, sizes.map(String));
      const byDate = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", sort: "date_asc", view: "compact", limit: 100 })).structuredContent?.data?.transactions as Payload[];
      check("x1: sort=date_asc is oldest first", byDate.every((r, i) => i === 0 || byDate[i - 1].date <= r.date));
      const ranged = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", min_cents: "10000", max_cents: "50000", view: "compact", limit: 100 })).structuredContent?.data;
      check(
        "x1: min_cents and max_cents bound the size",
        ranged?.transactions?.length > 0 && ranged.transactions.every((r: Payload) => { const s = BigInt(String(r.amount_cents).replace("-", "")); return s >= BigInt(10000) && s <= BigInt(50000); }) && ranged.totals.count === ranged.transactions.length,
        ranged?.transactions?.map((r: Payload) => r.amount_cents),
      );
      const upsideDown = await call(legacy, "books_search_transactions", { min_cents: "500", max_cents: "100" });
      check("x1: min above max is ok:false 422", upsideDown.structuredContent?.status === 422 && upsideDown.structuredContent?.error?.reason === "invalid_range", upsideDown.structuredContent);
      const onlyTransfers = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", transfers: "only", view: "compact" })).structuredContent?.data;
      check("x1: transfers=only lists the card payment", onlyTransfers?.transactions?.length >= 1 && onlyTransfers.transactions.every((r: Payload) => r.transfer === true), onlyTransfers?.transactions);
      const noTransfers = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", transfers: "exclude", view: "compact", limit: 100 })).structuredContent?.data;
      check("x1: transfers=exclude leaves them out", noTransfers?.totals?.count === totals?.count - onlyTransfers?.totals?.count && noTransfers.transactions.every((r: Payload) => r.transfer === false));
      const manual = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", kind: "manual" })).structuredContent?.data;
      const refunds = (await call(legacy, "books_search_transactions", { from: "2026-01-01", to: "2026-12-31", kind: "refund" })).structuredContent?.data;
      check("x1: kind filters", manual?.totals?.count > 0 && refunds?.totals?.count === 0, { manual: manual?.totals, refunds: refunds?.totals });
      const badKind = await call(legacy, "books_search_transactions", { kind: "bogus" });
      check("x1: an unknown kind is 422", badKind.structuredContent?.status === 422);

      const plain = (await call(legacy, "books_get_report", { id: "profit-loss", from: "2026-01-01", to: "2026-12-31" })).structuredContent?.data;
      const softwareOnly = (await call(legacy, "books_get_report", { id: "profit-loss", from: "2026-01-01", to: "2026-12-31", category: account(6) })).structuredContent?.data;
      const softwareRows = (softwareOnly?.rows ?? []).filter((r: Payload) => r.kind === "account");
      check("x2: category narrows the report to that account", softwareRows.length === 1 && softwareRows[0].key === account(6) && softwareRows[0].values[0] === plain?.rows?.find((r: Payload) => r.key === account(6))?.values?.[0], softwareOnly?.rows);
      const incomeOnly = (await call(legacy, "books_get_report", { id: "profit-loss", from: "2026-01-01", to: "2026-12-31", account_types: "income" })).structuredContent?.data;
      check("x2: account_types narrows the report", (incomeOnly?.rows ?? []).filter((r: Payload) => r.kind === "account").every((r: Payload) => r.key === account(5)) && incomeOnly?.rows?.some((r: Payload) => r.key === account(5)), incomeOnly?.rows);
      const twoCats = await call(legacy, "books_get_report", { id: "profit-loss", from: "2026-01-01", to: "2026-12-31", category: `${account(6)},${account(7)}` });
      check("x2: category takes a comma-separated list", (twoCats.structuredContent?.data?.rows ?? []).filter((r: Payload) => r.kind === "account").length === 2, twoCats.structuredContent?.data?.rows);
      const noContact = (await call(legacy, "books_get_report", { id: "vendor-expenses", from: "2026-01-01", to: "2026-12-31", contact: "none" })).structuredContent?.data;
      check("x2: contact=none keeps only Unassigned", (noContact?.rows ?? []).filter((r: Payload) => r.kind === "account").every((r: Payload) => r.key === "unassigned"), noContact?.rows);
      const topOne = (await call(legacy, "books_get_report", { id: "profit-loss", from: "2026-01-01", to: "2026-12-31", top: 1 })).structuredContent?.data;
      const sections: Payload[][] = [];
      let open: Payload[] | null = null;
      for (const row of topOne?.rows ?? []) {
        if (row.kind === "account") (open ??= []).push(row);
        else if (row.kind === "subtotal" && open) {
          sections.push([...open, row]);
          open = null;
        }
      }
      check(
        "x2: top keeps that many per section, Other makes the rows add up to each subtotal",
        sections.length >= 2 &&
          sections.every((s) => {
            const rows = s.slice(0, -1);
            const sum = rows.reduce((n, r) => n + BigInt(r.values[0]), BigInt(0));
            return rows.filter((r) => !String(r.key).startsWith("other-")).length <= 1 && sum === BigInt(s[s.length - 1].values[0]);
          }) &&
          (topOne?.rows ?? []).some((r: Payload) => /^Other \(\d+ categor/.test(r.label)),
        topOne?.rows,
      );
      const vendorsTop = (await call(legacy, "books_get_report", { id: "vendor-expenses", from: "2026-01-01", to: "2026-12-31", top: 1 })).structuredContent?.data;
      const vendorRows = (vendorsTop?.rows ?? []).filter((r: Payload) => r.kind === "account");
      const vendorTotal = vendorsTop?.rows?.find((r: Payload) => r.kind === "total");
      check(
        "x2: vendor top rows plus Other sum to the total",
        vendorRows.reduce((n: bigint, r: Payload) => n + BigInt(r.values[0]), BigInt(0)) === BigInt(vendorTotal?.values?.[0] ?? "-1") && vendorRows.filter((r: Payload) => !String(r.key).startsWith("other-")).length <= 1,
        vendorsTop?.rows,
      );
      const sortedVendors = (await call(legacy, "books_get_report", { id: "vendor-expenses", from: "2026-01-01", to: "2026-12-31", top: 200 })).structuredContent?.data?.rows?.filter((r: Payload) => r.kind === "account") ?? [];
      check("x2: top sorts biggest first", sortedVendors.every((r: Payload, i: number) => i === 0 || BigInt(sortedVendors[i - 1].values[0]) >= BigInt(r.values[0])), sortedVendors);
      const topBalance = await call(legacy, "books_get_report", { id: "balance-sheet", top: 3 });
      check("x2: top on another report is ok:false 422", topBalance.structuredContent?.status === 422, topBalance.structuredContent);
      const badCategory = await call(legacy, "books_get_report", { id: "profit-loss", category: "not-an-id" });
      check("x2: a bad category id is 422", badCategory.structuredContent?.status === 422);

      const ledgerTool = MCP_TOOLS.find((t) => t.definition.name === "books_account_ledger");
      check("x3: the ledger tool defaults to 50 lines", (ledgerTool?.definition.inputSchema.properties as Payload)?.limit?.default === 50);
      const ledgerTwo = (await call(legacy, "books_account_ledger", { id: account(1), from: "2026-01-01", to: "2026-12-31", limit: 2 })).structuredContent?.data;
      check("x3: limit sets the page size", ledgerTwo?.lines?.length === 2 && ledgerTwo?.next_offset === 2 && ledgerTwo?.total > 2, ledgerTwo);
      const ledgerNext = (await call(legacy, "books_account_ledger", { id: account(1), from: "2026-01-01", to: "2026-12-31", limit: 2, offset: 2 })).structuredContent?.data;
      check("x3: the next page continues the running balance", ledgerNext?.lines?.[0]?.running_cents === String(BigInt(ledgerTwo?.lines?.[1]?.running_cents ?? "0") + BigInt(ledgerNext?.lines?.[0]?.amount_cents ?? "0")));

      const hetznerFull = (await call(legacy, "books_list_contacts", { q: "hetzner" })).structuredContent?.data?.contacts?.[0];
      const hetznerTx = (await call(legacy, "books_search_transactions", { contact: hetznerId, view: "compact", limit: 100 })).structuredContent?.data;
      const hetznerDates = (hetznerTx?.transactions ?? []).map((r: Payload) => r.date).sort();
      check(
        "x4: first and last seen, money in and out match the contact's transactions",
        hetznerFull?.first_date === hetznerDates[0] && hetznerFull?.last_date === hetznerDates[hetznerDates.length - 1] && hetznerFull?.in_cents === hetznerTx?.totals?.in_cents && hetznerFull?.out_cents === hetznerTx?.totals?.out_cents,
        { hetznerFull, totals: hetznerTx?.totals, hetznerDates },
      );
      const compactContacts = (await call(legacy, "books_list_contacts", { view: "compact" })).structuredContent?.data?.contacts as Payload[];
      check(
        "x4: compact contacts carry the short fields",
        compactContacts.length > 0 &&
          compactContacts.every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["first_date", "id", "in_cents", "last_date", "name", "out_cents", "review_status", "roles", "top_category", "transaction_count"])),
        compactContacts[0],
      );

      // ---- Reconciliation, attention and the missed-transaction write, on a card feed with a $9.71 gap.
      const cardGap = await seedCardGap(db);
      const recon = (await call(legacy, "books_reconciliation", {})).structuredContent?.data;
      const cardRow = recon?.accounts?.find((a: Payload) => a.account.id === account(3));
      check("t2: the card shows the gap, owed-positive", cardRow?.gap_cents === "-971" && cardRow?.bank_cents === "971" && cardRow?.book_cents === "0" && cardRow?.status === "gap", cardRow);
      check("t2: off since the first report that disagreed", Date.parse(cardRow?.off_since) === cardGap.offSince * 1000, cardRow?.off_since);
      check("t2: the feed is named and fresh", cardRow?.feed?.connection === "Synthetic Amex" && cardRow?.feed?.stale === false, cardRow?.feed);
      check("t2: unmapped money accounts are no_feed", recon?.accounts?.filter((a: Payload) => a.account.id !== account(3)).every((a: Payload) => a.status === "no_feed" && a.gap_cents === null));
      const oneAccount = (await call(narrow, "books_reconciliation", { account: account(3) })).structuredContent?.data;
      check("t2: account narrows it, and a read-only key may read it", oneAccount?.accounts?.length === 1 && oneAccount.accounts[0].gap_cents === "-971", oneAccount);
      const notMoney = await call(legacy, "books_reconciliation", { account: account(6) });
      check("t2: a category is 404", notMoney.structuredContent?.status === 404, notMoney.structuredContent);
      const attention = (await call(narrow, "books_attention", {})).structuredContent?.data;
      const gapItem = attention?.items?.find((i: Payload) => i.kind === "recon_gap");
      check("t3: a gap over a day is an alert, alert=true", attention?.alert === true && gapItem?.severity === "alert" && gapItem?.amount_cents === "-971", attention);
      check("t3: links are full URLs into the app", gapItem?.link === "http://localhost/accounting?view=accounts" && attention.items.every((i: Payload) => !i.link || i.link.startsWith("http://localhost/accounting")), attention.items);
      const attentionAgain = (await call(legacy, "books_attention", { include_info: "false" })).structuredContent?.data;
      check("t3: the same issue keeps its id; include_info=false is alerts only", attentionAgain?.items?.find((i: Payload) => i.kind === "recon_gap")?.id === gapItem?.id && attentionAgain.items.every((i: Payload) => i.severity === "alert"), attentionAgain);

      const missedArgs = { bank_account_id: account(3), entry_date: booksDay(-3), amount_cents: "-971", description: "OPENAI CHATGPT", account_id: account(6) };
      const tooMuch = await call(legacy, "books_add_missed_transaction", { ...missedArgs, amount_cents: "-1971" });
      check("missed: more than the gap is ok:false exceeds_gap with the closing amount", tooMuch.isError !== true && tooMuch.structuredContent?.status === 422 && tooMuch.structuredContent?.error?.reason === "exceeds_gap" && tooMuch.structuredContent?.error?.closes_with_cents === "-971", tooMuch.structuredContent);
      const wrongWay = await call(legacy, "books_add_missed_transaction", { ...missedArgs, amount_cents: "971" });
      check("missed: the wrong direction is ok:false wrong_direction", wrongWay.structuredContent?.error?.reason === "wrong_direction", wrongWay.structuredContent);
      const zero = await call(legacy, "books_add_missed_transaction", { ...missedArgs, amount_cents: "0" });
      check("missed: zero is 422", zero.structuredContent?.status === 422, zero.structuredContent);
      const narrowMissed = await call(narrow, "books_add_missed_transaction", missedArgs);
      check("missed: a read-only key cannot reach it", narrowMissed.structuredContent?.error?.reason === "unknown_tool");
      const missedTool = MCP_TOOLS.find((t) => t.definition.name === "books_add_missed_transaction");
      check("missed: annotated as an additive create with an idempotency key", missedTool?.definition.annotations.destructiveHint === false && missedTool?.definition.annotations.readOnlyHint === false && Object.hasOwn((missedTool?.definition.inputSchema.properties ?? {}) as object, "idempotency_key"));
      const addedMissed = await call(legacy, "books_add_missed_transaction", { ...missedArgs, contact_id: hetznerId, note: "Owner reported it" });
      check("missed: within the gap it is a draft with a review link", addedMissed.structuredContent?.ok === true && addedMissed.structuredContent?.data?.status === "draft" && String(addedMissed.structuredContent?.data?.review_url).includes(addedMissed.structuredContent?.data?.id), addedMissed.structuredContent);
      const missedRow = (await call(legacy, "books_get_transaction", { id: addedMissed.structuredContent?.data?.id })).structuredContent?.data;
      check("missed: the draft hits the card and the category", missedRow?.status === "draft" && missedRow?.bank_account?.id === account(3) && missedRow?.amount_cents === "-971" && missedRow?.categories?.[0]?.account_id === account(6) && missedRow?.contact_id === hetznerId, missedRow);
      // The missed draft gives Hetzner a category (its other entries are transit legs, which never count).
      const hetznerNow = (await call(legacy, "books_list_contacts", { q: "hetzner" })).structuredContent?.data?.contacts?.[0];
      if (hetznerNow?.top_category?.id) {
        const sameCategory = (await call(legacy, "books_list_contacts", { category: hetznerNow.top_category.id, view: "compact" })).structuredContent?.data?.contacts as Payload[];
        check("x4: category lists contacts by top category", sameCategory.some((c) => c.id === hetznerId) && sameCategory.every((c) => c.top_category === hetznerNow.top_category.name), sameCategory);
      } else check("x4: the assigned contact has a top category", false, hetznerNow);
      const closed = (await call(legacy, "books_reconciliation", { account: account(3) })).structuredContent?.data?.accounts?.[0];
      check("missed: the gap closes in the working books", closed?.gap_cents === "0" && closed?.status === "ok" && closed?.book_posted_cents === "0", closed);
      const noGapNow = await call(legacy, "books_add_missed_transaction", { ...missedArgs, amount_cents: "-100" });
      check("missed: with no gap it is ok:false no_gap (409)", noGapNow.structuredContent?.status === 409 && noGapNow.structuredContent?.error?.reason === "no_gap", noGapNow.structuredContent);
      const cashDraft = await call(legacy, "books_create_draft", { entry_date: booksDay(-3), memo: "Card line", lines: [{ account_id: account(6), amount_cents: "100" }, { account_id: account(3), amount_cents: "-100" }] });
      check("missed: books_create_draft still refuses a card line", cashDraft.structuredContent?.error?.reason === "bank_lines_not_allowed", cashDraft.structuredContent);
      const { databaseError } = await import("../src/lib/api/http");
      const dup = databaseError(`API_MISSED_DUPLICATE ${JSON.stringify({ candidate: { entry_id: "x", amount_cents: "-971" } })}`, "accounting.draft");
      check("missed: a likely duplicate is 409 possible_duplicate with the candidate", dup.status === 409 && dup.details.reason === "possible_duplicate" && (dup.details.candidate as Payload)?.entry_id === "x", dup.details);
      const afterGap = (await call(legacy, "books_attention", {})).structuredContent?.data;
      check("t3: with the gap closed alert is false", afterGap?.alert === false && !afterGap.items.some((i: Payload) => i.kind === "recon_gap"), afterGap);

      // ---- Slice 3: breakdown, recurring, and the support reports behind accounting.payroll.
      const byMonth = (await call(legacy, "books_breakdown", { from: "2026-01-01", to: "2026-03-31" })).structuredContent?.data;
      const summaryQ1 = (await call(legacy, "books_summary", { from: "2026-01-01", to: "2026-03-31" })).structuredContent?.data;
      check(
        "t1: month by month by default, the total equals books_summary",
        byMonth?.group_by === "month" && byMonth?.rows?.length === 3 && byMonth?.total?.expense_cents === summaryQ1?.expense_cents && byMonth?.total?.income_cents === summaryQ1?.income_cents,
        { total: byMonth?.total, summary: summaryQ1?.expense_cents },
      );
      check("t1: rows read in order", JSON.stringify(Object.keys(byMonth?.rows?.[0] ?? {})) === JSON.stringify(["key", "label", "income_cents", "expense_cents", "net_cents", "count"]), byMonth?.rows?.[0]);
      const balanceByContact = await call(legacy, "books_breakdown", { group_by: "contact", measure: "balance" });
      check("t1: a balance by contact is ok:false 422", balanceByContact.structuredContent?.status === 422 && balanceByContact.structuredContent?.error?.reason === "invalid_parameters", balanceByContact.structuredContent);
      const bothCompares = await call(legacy, "books_breakdown", { compare: "previous_year", compare_from: "2025-01-01", compare_to: "2025-02-01" });
      check("t1: compare with explicit dates too is 422", bothCompares.structuredContent?.status === 422, bothCompares.structuredContent);
      const recurringRead = (await call(narrow, "books_recurring", {})).structuredContent;
      check("t4: a read-only key reads recurring charges", recurringRead?.ok === true && Array.isArray(recurringRead?.data?.series) && recurringRead?.data?.limit === 50, recurringRead);
      const narrowSupport = await call(narrow, "books_get_support_report", { id: "payroll-register", year: 2026 });
      check("t5: a key without accounting.payroll does not get the tool", narrowSupport.structuredContent?.error?.reason === "unknown_tool", narrowSupport.structuredContent);
      {
        // Edit access on the same key: tools/list is worked out per request, so the
        // connected client sees the tool on its next list, with no new secret.
        const { editKeyAccess } = await import("../src/lib/api/key-access");
        const { getServiceClient } = await import("../src/lib/supabase/service");
        type Access = Parameters<typeof editKeyAccess>[1];
        const owner = { member: (await db.query<Access["member"]>("SELECT * FROM public.team_members WHERE role='owner'")).rows[0], permissions: ["*"] } as Access;
        const narrowKey = async () =>
          (await db.query<{ id: string; updated_at: string }>("SELECT id, updated_at::text updated_at FROM public.api_keys WHERE key_hash=$1", [fixture.hash(booksOnly)])).rows[0];
        const before = await narrowKey();
        const added = await editKeyAccess(getServiceClient(), owner, before.id, { scopes: ["accounting.read", "accounting.payroll"], expected_updated_at: before.updated_at });
        check("edit access: the owner adds accounting.payroll to the narrow key", added.status === 200, added.body);
        const listed = (await narrow.listTools()).tools.map((t) => t.name);
        check("edit access: the same connection lists the payroll tool on its next tools/list", listed.includes("books_get_support_report"));
        const reached = (await call(narrow, "books_get_support_report", { id: "payroll-register", year: 2026 })).structuredContent;
        check("edit access: and the next call is allowed", reached?.ok === true, reached);
        const after = await narrowKey();
        const removed = await editKeyAccess(getServiceClient(), owner, before.id, { scopes: ["accounting.read"], expected_updated_at: after.updated_at });
        const relisted = (await narrow.listTools()).tools.map((t) => t.name);
        check("edit access: removing it takes the tool away again", removed.status === 200 && !relisted.includes("books_get_support_report"), removed.body);
      }
      const register = (await call(legacy, "books_get_support_report", { id: "payroll-register", year: 2026 })).structuredContent;
      check("t5: a key with accounting.payroll reads the payroll register", register?.ok === true && register?.source === "books" && register?.data?.title === "Payroll register" && register?.data?.columns?.length === 6, register);
      const supportTool = MCP_TOOLS.find((t) => t.definition.name === "books_get_support_report");
      check("t5: the tool is read only and needs accounting.payroll", supportTool?.scope === "accounting.payroll" && supportTool?.definition.annotations.readOnlyHint === true);
      const yearAndRange = await call(legacy, "books_get_support_report", { id: "tax-workpapers", year: 2025, from: "2025-01-01" });
      check("t5: year with from is 422", yearAndRange.structuredContent?.status === 422, yearAndRange.structuredContent);
      const midYear = await call(legacy, "books_get_support_report", { id: "tax-workpapers", from: "2025-03-01", to: "2025-12-31" });
      check("t5: tax workpapers not from January 1 is 422 invalid_range", midYear.structuredContent?.status === 422 && midYear.structuredContent?.error?.reason === "invalid_range", midYear.structuredContent);
      const oldYear = await call(legacy, "books_get_support_report", { id: "contractor-worksheet", year: 2021 });
      check("t5: a year without a 1099 rule is 422", oldYear.structuredContent?.status === 422 && oldYear.structuredContent?.error?.reason === "invalid_range", oldYear.structuredContent);
      await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'accounting.payroll','deny') ON CONFLICT (member_id, permission_key) DO UPDATE SET effect='deny'", [agentId]);
      const withoutPayroll = (await legacy.listTools()).tools.map((t) => t.name);
      check("t5: a member without accounting.payroll loses the tool on the same key", !withoutPayroll.includes("books_get_support_report") && withoutPayroll.includes("books_breakdown"));
      await db.query("DELETE FROM public.team_member_permissions WHERE member_id=$1 AND permission_key='accounting.payroll'", [agentId]);

      const narrowWrite = await call(narrow, "books_create_draft", draftArgs);
      check("write: a read-only key cannot reach a write tool", narrowWrite.structuredContent?.error?.reason === "unknown_tool");

      // Size: reads over the cap are refused with a hint; writes never are.
      const op = API_OPERATIONS.find((o) => o.id === "books.transactions") as ApiOperation;
      const profile = { key_id: "", member_id: agentId, member_name: "Jeff", role: "agent", expires_at: null, scopes: ["accounting.read"] };
      const tiny = await runOperation(op, { from: "2026-01-01", to: "2026-12-31" }, { key: fullKey, profile, origin: "http://localhost" }, 200);
      const tinyPayload = tiny.structuredContent as Payload;
      check("size: a read over the cap is ok:false result_too_large", tiny.isError !== true && tinyPayload.error?.reason === "result_too_large" && !!tinyPayload.error?.hint, tinyPayload);

      // A key that stops working is an error the client sees at the door.
      await db.query("UPDATE public.team_members SET status='suspended' WHERE id=$1", [agentId]);
      const suspended = await post({ jsonrpc: "2.0", id: 9, method: "tools/list" }, legacyHeaders);
      check("door: a suspended member is 403", suspended.status === 403, suspended.status);
      await db.query("UPDATE public.team_members SET status='active' WHERE id=$1", [agentId]);
    } finally {
      await Promise.allSettled([legacy.close(), modern.close(), narrow.close()]);
    }

    // Keys made for an agent are capped at what the agent holds; the server
    // resolves that the way public.has_permission does.
    const { membersApiAccess } = await import("../src/lib/api/member-access");
    const { getServiceClient } = await import("../src/lib/supabase/service");
    const { API_SCOPE_KEYS } = await import("../src/lib/api/scopes");
    await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'accounting.draft','deny') ON CONFLICT (member_id, permission_key) DO UPDATE SET effect='deny'", [agentId]);
    const [agentAccess] = await membersApiAccess(getServiceClient(), [agentId]);
    await db.exec("SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [AGENT]);
    const truth: string[] = [];
    for (const scope of API_SCOPE_KEYS)
      if ((await db.query<{ ok: boolean }>("SELECT public.has_permission($1) ok", [scope])).rows[0].ok) truth.push(scope);
    const usesApi = (await db.query<{ ok: boolean }>("SELECT public.has_permission('api.use') ok")).rows[0].ok;
    await db.exec("RESET ROLE;");
    await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    check("key for: member scopes match has_permission, overrides included", JSON.stringify(agentAccess?.api_scopes) === JSON.stringify(truth) && !truth.includes("accounting.draft"), { server: agentAccess?.api_scopes, sql: truth });
    check("key for: 'Use the API' and sign-in resolved", agentAccess?.can_use_api === usesApi && usesApi && agentAccess?.has_sign_in === true);
    await db.query("DELETE FROM public.team_member_permissions WHERE member_id=$1 AND permission_key='accounting.draft'", [agentId]);

    // The request log says which door each call came through.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const log = await db.query<{ via: string; operation: string; status: number }>("SELECT via, operation, status FROM public.api_requests");
    check("log: MCP calls are logged via mcp", log.rows.some((r) => r.via === "mcp" && r.operation === "books.draft_create" && r.status === 200), log.rows.length);
    check("log: REST calls stay via rest", log.rows.some((r) => r.via === "rest" && r.operation === "books.summary"));
    check("log: tools/list itself is not an API request", !log.rows.some((r) => r.operation === null));
  } finally {
    await server.close();
    await db.close();
  }
  if (failures.length) {
    console.error(`MCP server: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`MCP server: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
