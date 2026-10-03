/**
 * Contacts with roles, as the owner runs them: party.save takes roles (each
 * stored once, at least one), the name key makes "GitHub" and "Github, Inc."
 * one contact, the owner's save confirms an agent's suggestion, party.approve
 * confirms by id, and party.merge moves transactions, aliases, document links
 * and rule references into the kept contact, unions roles and archives the
 * other, refusing a locked month. The 1099 worksheet follows the contractor
 * role. The migration's backfill turns kind and the contractor flag into
 * roles and stops on a name key clash.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { accountingTestDb } from "./accounting-test-db";
import {
  accountingMigrations,
  accountingTaxDependencySql,
} from "./accounting-schema";
import { fixtureOwner } from "../src/lib/accounting/fixtures";
import { extendedRequestSchema } from "../src/lib/accounting/workflows";

let checks = 0;
const check = (actual: unknown, expected: unknown, label?: string) => {
  assert.deepEqual(actual, expected, label);
  checks++;
};
const refuses = async (work: Promise<unknown>, error: RegExp) => {
  await assert.rejects(work, error);
  checks++;
};

async function ownerCommands() {
  const db = await accountingTestDb();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- command results are checked field by field
  const cmd = async (command: object): Promise<any> =>
    (
      await db.query<{ r: unknown }>("SELECT accounting.operate($1) r", [
        JSON.stringify({ key: randomUUID(), command }),
      ])
    ).rows[0].r;
  const asOwner = async () => {
    await db.exec("RESET ROLE; SET ROLE authenticated;");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      fixtureOwner,
    ]);
  };
  const row = async (id: string) => {
    await db.exec("RESET ROLE");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- read back field by field
    const r = (await db.query<any>("SELECT * FROM accounting.parties WHERE id=$1", [id])).rows[0];
    await asOwner();
    return r;
  };
  const save = (id: string, version: number, name: string, roles: unknown, extra: object = {}) =>
    cmd({ type: "party.save", id, expected_version: version, name, roles, ...extra });
  try {
    const bank = randomUUID(),
      expense = randomUUID();
    await cmd({ type: "account.create", id: bank, name: "Contacts bank", account_type: "asset", subtype: "bank" });
    await cmd({ type: "account.create", id: expense, name: "Contacts software", account_type: "expense", subtype: "operating_expense" });

    // Roles: required, known, stored once each in the list's order.
    const github = randomUUID();
    await refuses(save(github, 0, "GitHub", []), /ACCT_INVALID_ROLES/);
    await refuses(save(github, 0, "GitHub", ["vendor", "boss"]), /ACCT_INVALID_ROLES/);
    await refuses(save(github, 0, "GitHub", "vendor"), /ACCT_INVALID_ROLES/);
    await refuses(cmd({ type: "party.save", id: github, expected_version: 0, name: "GitHub", kind: "vendor" }), /ACCT_INVALID_ROLES/);
    await save(github, 0, "GitHub", ["contractor", "vendor", "contractor"], { email: " billing@github.test ", website: "" });
    const g = await row(github);
    check(g.roles, ["vendor", "contractor"], "roles are deduplicated and ordered");
    check([g.email, g.website, g.review_status], ["billing@github.test", null, "confirmed"], "details trimmed; the owner's contact is confirmed");
    check(g.name_key, "github");
    await refuses(save(randomUUID(), 0, "Github, Inc.", ["vendor"]), /parties_name_key_unique/);
    await refuses(save(randomUUID(), 0, "GITHUB INC", ["vendor"]), /parties_name_key_unique/);
    await refuses(save(randomUUID(), 0, "Bad email", ["vendor"], { email: "not-an-email" }), /parties_email_check/);
    // The key function is private to the books, so it is read here as the database owner.
    const keyOf = async (name: string) => {
      await db.exec("RESET ROLE");
      const k = (await db.query<{ k: string }>("SELECT accounting.contact_name_key($1) k", [name])).rows[0].k;
      await asOwner();
      return k;
    };
    check(
      [await keyOf("Acme & Co., LLC"), await keyOf("  The   Company "), await keyOf("Co"), await keyOf("Costco")],
      ["acme and", "the", "co", "costco"],
      "name keys: & reads as and, trailing suffixes go, a lone suffix stays",
    );

    // The owner's save confirms an agent's suggestion; approve confirms by id.
    const google = randomUUID(),
      gcloud = randomUUID();
    await save(google, 0, "Google", ["vendor"]);
    await save(gcloud, 0, "Google Cloud", ["vendor"]);
    await db.exec("RESET ROLE");
    await db.query("UPDATE accounting.parties SET review_status='suggested' WHERE id IN ($1,$2)", [google, gcloud]);
    await asOwner();
    let gl = await row(google);
    await save(google, gl.version, "Google", ["vendor", "financial"]);
    check((await row(google)).review_status, "confirmed", "an owner save confirms a suggestion");
    const gc = await row(gcloud);
    await refuses(
      cmd({ type: "party.approve", ids: [gcloud], expected_versions: { [gcloud]: gc.version + 1 } }),
      /ACCT_STALE_VERSION/,
    );
    const approved = await cmd({ type: "party.approve", ids: [gcloud, google], expected_versions: { [gcloud]: gc.version } });
    check(approved.count, 1, "approve confirms only what was still a suggestion");
    check((await row(gcloud)).review_status, "confirmed");
    await refuses(cmd({ type: "party.approve", ids: [randomUUID()] }), /ACCT_NOT_FOUND/);

    // Merge: transactions, aliases, document links and rule references move; roles union; the other is archived.
    const entry = async (payee: string, date = "2026-06-10", post = true) => {
      const e = await cmd({
        type: "draft.save",
        id: randomUUID(),
        expected_version: 0,
        entry_date: date,
        memo: "Cloud bill",
        payee_id: payee,
        lines: [
          { account_id: expense, amount_cents: "1200" },
          { account_id: bank, amount_cents: "-1200" },
        ],
      });
      return post ? cmd({ type: "entry.post", id: e.id, expected_version: e.version }) : e;
    };
    const postedEntry = await entry(gcloud);
    const draftEntry = await entry(gcloud, "2026-06-11", false);
    const discarded = await entry(gcloud, "2026-06-12", false);
    await cmd({ type: "draft.discard", id: discarded.id, expected_version: discarded.version, reason: "Duplicate import" });
    await cmd({ type: "alias.save", id: randomUUID(), expected_version: 0, party_id: gcloud, match_kind: "key", pattern: "GOOGLE CLOUD", enabled: true });
    const rule = randomUUID();
    await cmd({
      type: "rule.save",
      id: rule,
      expected_version: 0,
      name: "Google Cloud is software",
      conditions: { descriptor_key: { contains: "GOOGLE CLOUD" }, payee_id: gcloud },
      actions: { account_id: expense, payee_id: gcloud },
    });
    await db.exec(
      "RESET ROLE;INSERT INTO storage.buckets(id,name,public) VALUES('accounting-private','accounting-private',false) ON CONFLICT DO NOTHING;",
    );
    await asOwner();
    const document = randomUUID();
    const prepared = await cmd({ type: "document.prepare", id: document, original_name: "w9.pdf", content_hash: "b".repeat(64), mime_type: "application/pdf", size_bytes: "10" });
    await db.exec("RESET ROLE");
    await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)", [prepared.storage_path]);
    await asOwner();
    await cmd({ type: "document.link", document_id: document, party_id: gcloud });
    gl = await row(google);
    let from = await row(gcloud);
    await refuses(
      cmd({ type: "party.merge", from_id: gcloud, into_id: gcloud, from_version: from.version, into_version: from.version }),
      /ACCT_INVALID_MERGE/,
    );
    await refuses(
      cmd({ type: "party.merge", from_id: gcloud, into_id: google, from_version: from.version - 1, into_version: gl.version }),
      /ACCT_STALE_VERSION/,
    );
    const merged = await cmd({ type: "party.merge", from_id: gcloud, into_id: google, from_version: from.version, into_version: gl.version, reason: "Same company" });
    check(merged.moved, { entries: 2, aliases: 1, documents: 1, rules: 1 }, "merge reports what moved");
    await db.exec("RESET ROLE");
    const payeeOf = async (id: string) =>
      (await db.query<{ p: string }>("SELECT payee_id p FROM accounting.journal_entries WHERE id=$1", [id])).rows[0].p;
    check([await payeeOf(postedEntry.id), await payeeOf(draftEntry.id), await payeeOf(discarded.id)], [google, google, gcloud], "live entries move, a discarded one keeps its contact");
    check((await db.query("SELECT party_id FROM accounting.payee_aliases WHERE pattern='GOOGLE CLOUD'")).rows, [{ party_id: google }]);
    check((await db.query("SELECT party_id FROM accounting.document_links WHERE document_id=$1", [document])).rows, [{ party_id: google }]);
    const ruleRow = (await db.query<{ c: string; a: string }>("SELECT conditions->>'payee_id' c, actions->>'payee_id' a FROM accounting.rules WHERE id=$1", [rule])).rows[0];
    check([ruleRow.c, ruleRow.a], [google, google], "rule conditions and actions name the kept contact");
    await asOwner();
    gl = await row(google);
    from = await row(gcloud);
    check([gl.roles, gl.review_status, from.is_archived, from.review_status], [["vendor", "financial"], "confirmed", true, "confirmed"]);

    // A merge that would change a locked month waits until it reopens.
    const old = randomUUID();
    await save(old, 0, "Old Cloud", ["vendor", "contractor"], { contractor_classification: "individual", documentation_status: "received" });
    await entry(old, "2026-02-10");
    await cmd({ type: "period.lock", month: "2026-02-01" });
    const oldRow = await row(old);
    gl = await row(google);
    await refuses(
      cmd({ type: "party.merge", from_id: old, into_id: google, from_version: oldRow.version, into_version: gl.version }),
      /ACCT_PERIOD_LOCKED/,
    );
    await cmd({ type: "period.reopen", month: "2026-02-01", reason: "Merge contacts" });
    const mergedOld = await cmd({ type: "party.merge", from_id: old, into_id: google, from_version: oldRow.version, into_version: gl.version });
    check(mergedOld.moved.entries, 1);
    gl = await row(google);
    check([gl.roles, gl.contractor_classification, gl.documentation_status], [["vendor", "contractor", "financial"], "individual", "received"], "the kept contact gains roles and contractor details it lacked");

    // The 1099 worksheet follows the contractor role.
    const contractors = async () =>
      (await db.query<{ r: { rows: { name: string; paid_cents: string }[] } }>("SELECT accounting.contractor_report(2026) r")).rows[0].r.rows;
    check((await contractors()).map((r) => r.name), ["GitHub", "Google", "Old Cloud"]);
    gl = await row(google);
    await save(google, gl.version, "Google", ["vendor", "financial"]);
    check((await contractors()).map((r) => r.name), ["GitHub", "Old Cloud"], "removing the role takes a contact off the worksheet");
    const manage = (await db.query<{ r: { parties: { id: string; suggested_by_name: string | null; roles: string[] }[] } }>("SELECT accounting.context('manage') r")).rows[0].r;
    check(manage.parties.find((p) => p.id === github)?.roles, ["vendor", "contractor"], "context('manage') carries roles");
  } finally {
    await db.close();
  }
}

/** The migration's backfill, on a database that has the old columns. */
async function backfill(rows: [string, string, boolean][]) {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text,metadata jsonb DEFAULT '{}');`);
    await db.exec(await accountingTaxDependencySql());
    const migrations = await accountingMigrations();
    const mine = migrations.findIndex((m) => m.name.endsWith("_accounting_contact_roles.sql"));
    assert.ok(mine > 0, "the contact roles migration is in the sequence");
    for (const migration of migrations.slice(0, mine)) await db.exec(migration.sql);
    await db.query("INSERT INTO accounting.settings(owner_user_id) VALUES(NULL)").catch(() => undefined);
    for (const [name, kind, contractor] of rows)
      await db.query("INSERT INTO accounting.parties(name,kind,is_contractor) VALUES($1,$2,$3)", [name, kind, contractor]);
    await db.exec(migrations[mine].sql);
    return (await db.query<{ name: string; roles: string[] }>("SELECT name, roles FROM accounting.parties ORDER BY name")).rows;
  } finally {
    await db.close();
  }
}

// Contacts an agent adds get ids hashed from the request key
// (md5('contact:' || key)::uuid), which carry no RFC version bits. The owner's
// commands must accept them like any database id, or Approve, Edit and Merge
// fail in the browser with "Invalid UUID" before reaching the books.
function agentIdsParse() {
  const hashed = (seed: string) =>
    createHash("md5").update(seed).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const contact = hashed(`contact:${randomUUID()}`);
  const other = hashed(`contact:${randomUUID()}`);
  const commands = [
    { type: "party.approve", id: randomUUID(), ids: [contact], expected_versions: { [contact]: 1 } },
    { type: "party.merge", id: randomUUID(), from_id: contact, into_id: other, from_version: 1, into_version: 1 },
  ];
  for (const command of commands) {
    const parsed = extendedRequestSchema.safeParse({ key: randomUUID(), command });
    check(parsed.success, true, `${command.type} accepts an agent contact id: ${parsed.success ? "" : parsed.error.message}`);
  }
}

async function main() {
  agentIdsParse();
  await ownerCommands();
  check(
    await backfill([
      ["Wilderness Athlete", "customer", false],
      ["Brennan Davidson LLC", "vendor", true],
      ["Both ways", "both", false],
      ["Cloudflare", "vendor", false],
    ]),
    [
      { name: "Both ways", roles: ["client", "vendor"] },
      { name: "Brennan Davidson LLC", roles: ["vendor", "contractor"] },
      { name: "Cloudflare", roles: ["vendor"] },
      { name: "Wilderness Athlete", roles: ["client"] },
    ],
    "backfill: customer is client, both is client and vendor, the flag adds contractor",
  );
  await refuses(
    backfill([
      ["GitHub", "vendor", false],
      ["Github, Inc.", "vendor", false],
    ]),
    /share a name key.*GitHub, Github, Inc\./,
  );
  console.log(`Contacts with roles: ${checks} assertions passed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
