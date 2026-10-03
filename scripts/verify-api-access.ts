/**
 * Finance API access (phase 1a): agents, accounting.read, API keys and the
 * key-checked entry points, run against the pglite fixture with the migration
 * applied. auth.uid() is replaced by the live project's definition (read from
 * the finance project on 2026-10-02) so the identity switch is tested against
 * the real thing: api_act sets request.jwt.claim.sub for one transaction and
 * every books check then sees the key's member.
 */
import { createHash, randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureOwner } from "../src/lib/accounting/fixtures";

const ADMIN = "10000000-0000-4000-8000-0000000000a1";
const MEMBER = "10000000-0000-4000-8000-0000000000a2";
const AGENT = "10000000-0000-4000-8000-0000000000a3";
const SLEEPER = "10000000-0000-4000-8000-0000000000a4";

const LIVE_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$`;

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean) {
  if (ok) passed++;
  else failures.push(label);
}

async function main() {
  const db = await accountingTestDb();
  try {
    const superuser = async () => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    };
    /** A browser session for this auth user. */
    const as = async (uid: string) => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
    };
    /**
     * One PostgREST request from the API server: its own transaction, the
     * service_role database role and service_role claims with no user.
     */
    const service = async <T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
      then?: string,
    ): Promise<{ rows: T[]; after?: unknown; error?: string }> => {
      await superuser();
      await db.exec("BEGIN; SET LOCAL ROLE service_role;");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      try {
        const result = await db.query<T>(sql, params);
        const after = then ? (await db.query<{ v: unknown }>(then)).rows[0]?.v : undefined;
        await db.exec("COMMIT;");
        return { rows: result.rows, after };
      } catch (e) {
        await db.exec("ROLLBACK;");
        return { rows: [], error: (e as Error).message };
      }
    };
    const fails = async (run: () => Promise<unknown>, pattern: RegExp) => {
      try {
        await run();
        return false;
      } catch (e) {
        return pattern.test((e as Error).message);
      }
    };
    const authorize = (key: string, permission = "accounting.read") =>
      service<{ r: Record<string, unknown> }>("SELECT public.api_authorize($1,$2) r", [hash(key), permission]);
    const books = (key: string, name: string, args: Record<string, unknown> = {}) =>
      service<{ r: Record<string, unknown> }>("SELECT public.api_accounting($1,$2,$3) r", [hash(key), name, JSON.stringify(args)]);

    await superuser();
    await db.exec(LIVE_AUTH_UID);
    check("live auth.uid() is installed", (await db.query<{ u: string | null }>("SELECT auth.uid() u")).rows[0].u === null);

    // People: an admin, a member, an agent and a suspended agent.
    for (const id of [ADMIN, MEMBER, AGENT, SLEEPER]) await db.query("INSERT INTO auth.users(id) VALUES($1)", [id]);
    await as(fixtureOwner);
    const ids: Record<string, string> = {};
    for (const [uid, name, role] of [
      [ADMIN, "Ada Admin", "admin"],
      [MEMBER, "Mel Member", "member"],
      [AGENT, "Jeff Agent", "agent"],
      [SLEEPER, "Sid Sleeper", "agent"],
    ]) {
      ids[uid] = (
        await db.query<{ id: string }>(
          "INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,$2,$3,$4) RETURNING id",
          [uid, name, `${role}-${uid.slice(-2)}@example.com`, role],
        )
      ).rows[0].id;
    }
    check("the owner adds an agent", !!ids[AGENT]);
    await db.query("UPDATE public.team_members SET status='suspended' WHERE id=$1", [ids[SLEEPER]]);
    await as(ADMIN);
    check(
      "an admin cannot add an agent",
      await fails(() => db.query("INSERT INTO public.team_members(name,email,role) VALUES('X','x@example.com','agent')"), /TEAM_FORBIDDEN/),
    );
    const perm = async (uid: string, key: string) => {
      await as(uid);
      return (await db.query<{ ok: boolean }>("SELECT public.has_permission($1) ok", [key])).rows[0].ok;
    };
    check("agent defaults: accounting.read and api.use", (await perm(AGENT, "accounting.read")) && (await perm(AGENT, "api.use")));
    check("agent defaults: no accounting.manage", !(await perm(AGENT, "accounting.manage")));
    check("admin default: accounting.read, no api.use", (await perm(ADMIN, "accounting.read")) && !(await perm(ADMIN, "api.use")));
    check("member default: neither", !(await perm(MEMBER, "accounting.read")) && !(await perm(MEMBER, "api.use")));

    // accounting.read counts only inside an API call: a reader's own browser
    // session (an agent can sign in) gets nothing, so every books read by a
    // reader passes the key's scope, expiry, revoke, rate limit and log.
    await as(AGENT);
    check(
      "a reader's browser session cannot read the books",
      await fails(() => db.query("SELECT accounting.report('summary','{}'::jsonb) r"), /ACCT_FORBIDDEN/),
    );
    check(
      "nor by setting the API's markers itself",
      await fails(
        () => db.query("SELECT set_config('accounting.actor_kind','api',false), set_config('api.key_id',gen_random_uuid()::text,false), accounting.report('summary','{}'::jsonb)"),
        /ACCT_FORBIDDEN|permission denied/,
      ),
    );
    check(
      "a reader cannot run a command",
      await fails(
        () => db.query("SELECT accounting.operate($1::jsonb)", [JSON.stringify({ key: randomUUID(), command: { type: "settings.save", transfer_window_days: 5 } })]),
        /ACCT_FORBIDDEN/,
      ),
    );
    check("a reader cannot open evidence views", await fails(() => db.query("SELECT accounting.context('manage','{}'::jsonb)"), /ACCT_FORBIDDEN/));
    check("a reader cannot open bank review (raw provider payloads)", await fails(() => db.query("SELECT accounting.bank_review('{}'::jsonb)"), /ACCT_FORBIDDEN/));
    await as(MEMBER);
    check("a member without the books is refused", await fails(() => db.query("SELECT accounting.report('summary','{}'::jsonb)"), /ACCT_FORBIDDEN/));

    // Keys, inserted the way the server route does (service role).
    await superuser();
    const key = async (name: string, uid: string, scopes: string[], extra = "") => {
      const secret = `vm_live_${name}_${randomUUID()}`;
      await db.query(
        `INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,created_by,scopes${extra ? "," + extra.split("=")[0] : ""})
         VALUES($1,$2,$3,$4,$4,$5${extra ? "," + extra.split("=")[1] : ""})`,
        [name, secret.slice(0, 16), hash(secret), ids[uid], scopes],
      );
      return secret;
    };
    const agentKey = await key("agent", AGENT, ["accounting.read"]);
    const rateKey = await key("rate", AGENT, ["accounting.read"]);
    const unscoped = await key("unscoped", AGENT, []);
    const overreach = await key("overreach", AGENT, ["accounting.manage"]);
    const memberKey = await key("member", MEMBER, ["accounting.read"]);
    const adminKey = await key("admin", ADMIN, ["accounting.read"]);
    const sleeperKey = await key("sleeper", SLEEPER, ["accounting.read"]);
    const revoked = await key("revoked", AGENT, ["accounting.read"], "revoked_at=now()");
    const disabled = await key("disabled", AGENT, ["accounting.read"], "disabled_at=now()");
    const expired = await key("expired", AGENT, ["accounting.read"], "expires_at=now() - interval '1 minute'");

    // Refusals, each with its own code.
    const code = async (k: string, permission?: string) => (await authorize(k, permission)).error ?? "ok";
    check("unknown key", /API_KEY_INVALID/.test(await code("vm_live_nope")));
    check("revoked key", /API_KEY_INVALID/.test(await code(revoked)));
    check("disabled key", /API_KEY_DISABLED/.test(await code(disabled)));
    check("expired key", /API_KEY_EXPIRED/.test(await code(expired)));
    check("suspended member", /API_MEMBER_INACTIVE/.test(await code(sleeperKey)));
    check("member without api.use", /API_MEMBER_NO_API/.test(await code(memberKey)));
    check("admin without api.use", /API_MEMBER_NO_API/.test(await code(adminKey)));
    check("scope missing on the key", /API_SCOPE_MISSING/.test(await code(unscoped)));
    check("permission missing on the member", /API_MEMBER_PERMISSION_MISSING/.test(await code(overreach, "accounting.manage")));

    // A personal grant of api.use lets the admin in: both locks, nothing else.
    await as(fixtureOwner);
    await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'api.use','allow')", [ids[ADMIN]]);
    check("admin with api.use is let in", (await code(adminKey)) === "ok");

    // Success: identity for this transaction only, last use, rate headers.
    const ok = await service<{ r: Record<string, unknown> }>(
      "SELECT public.api_authorize($1,'accounting.read') r",
      [hash(agentKey)],
      "SELECT jsonb_build_object('uid',auth.uid(),'kind',current_setting('accounting.actor_kind',true),'key',current_setting('api.key_id',true)) v",
    );
    const inside = ok.after as Record<string, string>;
    check("authorize answers with the limit", ok.rows[0]?.r.limit === 120 && ok.rows[0]?.r.remaining === 119);
    check("inside the request auth.uid() is the agent", inside?.uid === AGENT);
    check("inside the request the actor kind is api", inside?.kind === "api");
    check("inside the request the key id is set", inside?.key === ok.rows[0]?.r.key_id);
    await superuser();
    check("after the request auth.uid() is empty again", (await db.query<{ u: string | null }>("SELECT auth.uid() u")).rows[0].u === null);
    check(
      "last use is recorded",
      (await db.query<{ t: string | null }>("SELECT last_used_at t FROM public.api_keys WHERE key_hash=$1", [hash(agentKey)])).rows[0].t !== null,
    );
    const rollback = await service("SELECT public.api_authorize($1,'accounting.read'), 1/0", [hash(agentKey)]);
    await superuser();
    check("a failed request leaves no identity behind", !!rollback.error && (await db.query<{ u: string | null }>("SELECT auth.uid() u")).rows[0].u === null);

    // Rate limit: 120 a minute per key; a refused call does not count.
    let refusedAt = 0;
    for (let i = 1; i <= 122; i++) {
      const result = await authorize(rateKey);
      if (result.error) {
        refusedAt = i;
        check("the refusal is API_RATE_LIMITED", /API_RATE_LIMITED/.test(result.error));
        break;
      }
    }
    check("the 121st call in a minute is refused", refusedAt === 121);
    check("other keys are not limited by it", (await code(agentKey)) === "ok");

    // The books entry point: the allowlist, and real reads as the agent.
    const summary = await books(agentKey, "report", { kind: "summary", params: {} });
    check("report summary through the API", !summary.error && !!summary.rows[0]?.r);
    const revision = await books(agentKey, "revision", {});
    check("revision through the API", !revision.error && typeof revision.rows[0]?.r.revision === "string");
    const workspace = await books(agentKey, "workspace", { from_date: "2026-01-01", to_date: "2026-12-31", mode: "working" });
    check("workspace through the API", !workspace.error && !!workspace.rows[0]?.r);
    const register = await books(agentKey, "transactions", { filter: {}, page: {} });
    check("transactions through the API", !register.error && !!register.rows[0]?.r);
    for (const name of ["bank_review", "operate", "context", "sync_server", "documents", "payroll", "tax_source", "", "workspace; drop"]) {
      check(`'${name}' is not callable`, /API_OPERATION_NOT_ALLOWED/.test((await books(agentKey, name)).error ?? ""));
    }
    check("the books entry point checks the key too", /API_SCOPE_MISSING/.test((await books(unscoped, "report", { kind: "summary" })).error ?? ""));
    check("and the member", /API_MEMBER_NO_API/.test((await books(memberKey, "report", { kind: "summary" })).error ?? ""));

    // Only the server may call the entry points.
    for (const role of ["authenticated", "anon"]) {
      await db.exec(`RESET ROLE; SET ROLE ${role};`);
      check(`${role} cannot call api_authorize`, await fails(() => db.query("SELECT public.api_authorize($1,'accounting.read')", [hash(agentKey)]), /permission denied/));
      check(`${role} cannot call api_accounting`, await fails(() => db.query("SELECT public.api_accounting($1,'report','{}')", [hash(agentKey)]), /permission denied/));
      check(`${role} cannot call api_act`, await fails(() => db.query("SELECT public.api_act($1,'accounting.read')", [hash(agentKey)]), /permission denied/));
    }

    // Who sees which keys, and nobody but the server writes them.
    const visible = async (uid: string) => {
      await as(uid);
      return (await db.query("SELECT id FROM public.api_keys")).rows.length;
    };
    check("the agent sees its own 7 keys", (await visible(AGENT)) === 7);
    check("the owner sees all 10", (await visible(fixtureOwner)) === 10);
    check("the member sees their 1", (await visible(MEMBER)) === 1);
    await as(fixtureOwner);
    check("nobody signed in can read key hashes, not even the owner", await fails(() => db.query("SELECT key_hash FROM public.api_keys"), /permission denied/));
    await as(AGENT);
    check(
      "a member cannot change a key",
      await fails(() => db.query("UPDATE public.api_keys SET revoked_at=NULL WHERE key_hash=$1", [hash(revoked)]), /permission denied/),
    );
    check(
      "a member cannot add a key",
      await fails(
        () => db.query("INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,scopes) VALUES('x','x','x',$1,'{accounting.read}')", [ids[AGENT]]),
        /permission denied/,
      ),
    );
    const unrevoke = await service("UPDATE public.api_keys SET revoked_at=NULL WHERE key_hash=$1", [hash(revoked)]);
    check("even the server cannot un-revoke", /revoke cannot be changed/.test(unrevoke.error ?? ""));
    const repoint = await service("UPDATE public.api_keys SET team_member_id=(SELECT id FROM public.team_members WHERE role='owner') WHERE key_hash=$1", [hash(agentKey)]);
    check("even the server cannot move a key to the owner", /another member/.test(repoint.error ?? ""));
    const log = await service("INSERT INTO public.api_requests(api_key_id,team_member_id,method,path,status) SELECT id,team_member_id,'GET','/api/v1/reports/summary',200 FROM public.api_keys WHERE key_hash=$1", [hash(agentKey)]);
    check("the server logs a request", !log.error);
    await as(fixtureOwner);
    check("the owner reads the request log", (await db.query("SELECT 1 FROM public.api_requests")).rows.length === 1);
    await as(MEMBER);
    check("a member does not read another person's requests", (await db.query("SELECT 1 FROM public.api_requests")).rows.length === 0);
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`API access: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`API access: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
