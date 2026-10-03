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
import { AGENT, seedApiFixture } from "./api-test-fixture";
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
