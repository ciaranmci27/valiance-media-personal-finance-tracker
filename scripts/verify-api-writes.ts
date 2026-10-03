/**
 * Finance API writes (phase 2), in SQL: agents write to the books as drafts
 * only, through public.api_books_command, as the key's member. Covers each
 * allowed operation, idempotent replay, all-or-nothing bulk categorize,
 * rules that can never auto-post, create-only rules, contacts as suggestions
 * with duplicate guards and suggestion-only updates, assigning a blank
 * contact on drafts and reviewed entries (and nothing else), the audit trail
 * naming the agent and its key, and the after-command check that rolls back
 * anything that left draft even if a command were to slip through. Runs on
 * the pglite fixture with the live auth.uid() definition.
 */
import { createHash, randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureAccounts, fixtureOwner, fixtureAccountId as account } from "../src/lib/accounting/fixtures";

const AGENT = "10000000-0000-4000-8000-0000000000c1";
const MEMBER = "10000000-0000-4000-8000-0000000000c2";
const LIVE_AUTH_UID = `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $function$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $function$`;

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function main() {
  const db = await accountingTestDb();
  try {
    const superuser = async () => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    };
    const as = async (uid: string) => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [uid]);
    };
    /** One PostgREST request from the API server (service_role, no user). */
    const service = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      await superuser();
      await db.exec("BEGIN; SET LOCAL ROLE service_role;");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      try {
        const result = await db.query<T>(sql, params);
        await db.exec("COMMIT;");
        return { rows: result.rows, error: undefined as string | undefined };
      } catch (e) {
        await db.exec("ROLLBACK;");
        return { rows: [] as T[], error: (e as Error).message };
      }
    };
    const write = async (key: string, operation: string, idem: string, args: Record<string, unknown>) =>
      service<{ r: Record<string, unknown> }>("SELECT public.api_books_command($1,$2,$3,$4) r", [hash(key), operation, idem, JSON.stringify(args)]);
    const entry = async (id: string) => {
      await superuser();
      return (
        await db.query<{ status: string; version: number; memo: string; payee_id: string | null }>(
          "SELECT status, version, memo, payee_id FROM accounting.journal_entries WHERE id=$1",
          [id],
        )
      ).rows[0];
    };
    /** A bank draft as the feeds make them: the owner's, one bank line and one category line. */
    const ownerBankDraft = async (memo: string, bankCents: string, category: string, description?: string, date = "2026-03-05") => {
      await as(fixtureOwner);
      const r = (
        await db.query<{ r: Record<string, unknown> }>("SELECT accounting.operate($1) r", [
          JSON.stringify({
            key: randomUUID(),
            command: {
              type: "draft.save",
              id: randomUUID(),
              expected_version: 0,
              entry_date: date,
              memo,
              ...(description ? { source_description: description } : {}),
              lines: [
                { account_id: account(1), amount_cents: bankCents },
                { account_id: category, amount_cents: (-BigInt(bankCents)).toString() },
              ],
            },
          }),
        ])
      ).rows[0].r;
      return { id: r.id as string, version: r.version as number };
    };
    const kindOf = async (id: string) => {
      await superuser();
      return (await db.query<{ kind: string }>("SELECT kind FROM accounting.journal_entries WHERE id=$1", [id])).rows[0]?.kind;
    };
    const linesOf = async (id: string) => {
      await superuser();
      return (
        await db.query<{ account_id: string; amount_cents: string }>(
          "SELECT account_id, amount_cents::text FROM accounting.journal_lines WHERE entry_id=$1 ORDER BY sort_order",
          [id],
        )
      ).rows;
    };

    await superuser();
    await db.exec(LIVE_AUTH_UID);

    // Books as the books suites seed them, by the owner.
    await as(fixtureOwner);
    const owner = async (command: Record<string, unknown>) =>
      (await db.query<{ r: Record<string, unknown> }>("SELECT accounting.operate($1) r", [JSON.stringify({ key: randomUUID(), command })])).rows[0].r;
    for (const a of fixtureAccounts)
      await owner({
        type: "account.create",
        ...a,
        subtype: a.id === account(2) ? "transit" : a.id === account(8) ? "payroll_liability" : undefined,
        cash_kind: [account(1), account(9)].includes(a.id) ? "bank" : a.id === account(3) ? "card" : "none",
      });
    const posted = await owner({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-03-02",
      memo: "Owner posted",
      lines: [
        { account_id: account(1), amount_cents: "5000" },
        { account_id: account(5), amount_cents: "-5000" },
      ],
    });
    const postedEntry = await owner({ type: "entry.post", id: posted.id, expected_version: posted.version });

    // An agent with books read + drafts, and a plain member.
    await superuser();
    for (const id of [AGENT, MEMBER]) await db.query("INSERT INTO auth.users(id) VALUES($1)", [id]);
    await as(fixtureOwner);
    const agentId = (
      await db.query<{ id: string }>("INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Jeff','jeff@w.test','agent') RETURNING id", [AGENT])
    ).rows[0].id;
    const memberId = (
      await db.query<{ id: string }>("INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Mel','mel@w.test','member') RETURNING id", [MEMBER])
    ).rows[0].id;
    await superuser();
    const key = async (owner: string, scopes: string[]) => {
      const secret = `vmfin_${randomUUID().replaceAll("-", "")}`;
      const id = (
        await db.query<{ id: string }>(
          "INSERT INTO public.api_keys(name,key_prefix,key_hash,team_member_id,created_by,scopes) VALUES('k',$1,$2,$3,$3,$4) RETURNING id",
          [secret.slice(0, 14), hash(secret), owner, scopes],
        )
      ).rows[0].id;
      return { secret, id };
    };
    const drafter = await key(agentId, ["accounting.read", "accounting.draft"]);
    const readerOnly = await key(agentId, ["accounting.read"]);
    const memberKey = await key(memberId, ["accounting.draft"]);

    // Who may write.
    check("a read-only key cannot write", /API_SCOPE_MISSING/.test((await write(readerOnly.secret, "draft.create", randomUUID(), {})).error ?? ""));
    check("a member without the API cannot write", /API_MEMBER_NO_API/.test((await write(memberKey.secret, "draft.create", randomUUID(), {})).error ?? ""));
    for (const op of ["entry.post", "transaction.review", "rule.apply", "draft.discard", ""]) {
      check(`'${op}' is not an API operation`, /API_COMMAND_NOT_ALLOWED/.test((await write(drafter.secret, op, randomUUID(), {})).error ?? ""));
    }
    check(
      "an agent's own session cannot run books commands",
      await (async () => {
        await as(AGENT);
        try {
          await db.query("SELECT accounting.operate($1)", [
            JSON.stringify({ key: randomUUID(), command: { type: "draft.save", id: randomUUID(), expected_version: 0, entry_date: "2026-03-03", memo: "x", lines: [] } }),
          ]);
          return false;
        } catch (e) {
          return /ACCT_FORBIDDEN/.test((e as Error).message);
        }
      })(),
    );
    await as(AGENT);
    check(
      "nor call the API's write entry point",
      await db.query("SELECT public.api_books_command('x','draft.create',gen_random_uuid(),'{}')").then(() => false, (e: Error) => /permission denied/.test(e.message)),
    );

    // Draft create, with replay.
    const idem = randomUUID();
    const draftArgs = {
      entry_date: "2026-03-05",
      memo: "Figma subscription",
      // An accrual: an adjustment between non-cash accounts.
      lines: [
        { account_id: account(6), amount_cents: "1500" },
        { account_id: account(8), amount_cents: "-1500" },
      ],
      kind: "expense",
    };
    const created = await write(drafter.secret, "draft.create", idem, draftArgs);
    const draftId = created.rows[0]?.r.id as string;
    check("draft created", !created.error && !!draftId, created.error);
    check("it is a draft", (await entry(draftId))?.status === "draft");
    const replay = await write(drafter.secret, "draft.create", idem, draftArgs);
    check("a retry with the same key replays, no second draft", replay.rows[0]?.r.id === draftId);
    await superuser();
    check(
      "exactly one draft exists for it",
      (await db.query("SELECT 1 FROM accounting.journal_entries WHERE memo='Figma subscription'")).rows.length === 1,
    );
    const tampered = await write(drafter.secret, "draft.create", idem, { ...draftArgs, memo: "Changed" });
    check("the same key with a different request is refused", /ACCT_IDEMPOTENCY_CONFLICT/.test(tampered.error ?? ""), tampered.error);
    check(
      "kinds outside the draft list are refused",
      /API_INVALID_INPUT/.test((await write(drafter.secret, "draft.create", randomUUID(), { ...draftArgs, kind: "payroll" })).error ?? ""),
    );
    const sneakyOrigin = await write(drafter.secret, "draft.create", randomUUID(), { ...draftArgs, memo: "Origin try", origin: "simplefin", source_description: "FAKE BANK" });
    await superuser();
    const originRow = (
      await db.query<{ origin: string; source_description: string | null }>("SELECT origin, source_description FROM accounting.journal_entries WHERE id=$1", [
        sneakyOrigin.rows[0]?.r.id as string,
      ])
    ).rows[0];
    check("extra fields are never forwarded (origin stays manual)", originRow?.origin === "manual" && originRow?.source_description === null, originRow);

    // Audit names the agent and the key.
    await superuser();
    const audit = (
      await db.query<{ actor_kind: string; actor_user_id: string; api_key_id: string }>(
        "SELECT actor_kind, actor_user_id, api_key_id FROM accounting.audit_log WHERE table_name='journal_entries' AND row_id=$1",
        [draftId],
      )
    ).rows;
    check("audit: kind api", audit.length > 0 && audit.every((r) => r.actor_kind === "api"), audit);
    check("audit: the agent", audit.every((r) => r.actor_user_id === AGENT));
    check("audit: the key", audit.every((r) => r.api_key_id === drafter.id));
    const ownerAudit = (
      await db.query<{ actor_kind: string; api_key_id: string | null }>(
        "SELECT actor_kind, api_key_id FROM accounting.audit_log WHERE table_name='journal_entries' AND row_id=$1",
        [posted.id],
      )
    ).rows;
    check("audit: owner writes are unchanged", ownerAudit.every((r) => r.actor_kind === "owner" && r.api_key_id === null), ownerAudit);

    // Update, categorize, split.
    const v1 = (await entry(draftId)).version;
    const updated = await write(drafter.secret, "draft.update", randomUUID(), {
      ...draftArgs,
      id: draftId,
      expected_version: v1,
      memo: "Figma Professional",
    });
    check("draft updated", !updated.error && (await entry(draftId)).memo === "Figma Professional", updated.error);
    const stale = await write(drafter.secret, "draft.update", randomUUID(), { ...draftArgs, id: draftId, expected_version: v1 });
    check("a stale version is refused", /ACCT_STALE_VERSION/.test(stale.error ?? ""), stale.error);
    const onPosted = await write(drafter.secret, "draft.update", randomUUID(), { ...draftArgs, id: posted.id, expected_version: postedEntry.version ?? 2 });
    check("a posted entry cannot be replaced", /ACCT_POSTED_IMMUTABLE/.test(onPosted.error ?? ""), onPosted.error);
    // API drafts are adjustments only: no bank, card or cash lines.
    const bankLine = await write(drafter.secret, "draft.create", randomUUID(), {
      ...draftArgs,
      memo: "Bank line try",
      lines: [
        { account_id: account(6), amount_cents: "1500" },
        { account_id: account(1), amount_cents: "-1500" },
      ],
    });
    check("a draft with a bank line is refused", /API_DRAFTS_NO_CASH/.test(bankLine.error ?? ""), bankLine.error);
    const cardLine = await write(drafter.secret, "draft.create", randomUUID(), {
      ...draftArgs,
      memo: "Card line try",
      lines: [
        { account_id: account(6), amount_cents: "1500" },
        { account_id: account(3), amount_cents: "-1500" },
      ],
    });
    check("a draft with a card line is refused", /API_DRAFTS_NO_CASH/.test(cardLine.error ?? ""), cardLine.error);
    const bank = await ownerBankDraft("Figma subscription (bank)", "-1500", account(6));
    const bankId = bank.id;
    const rewriteBank = await write(drafter.secret, "draft.update", randomUUID(), { ...draftArgs, id: bankId, expected_version: bank.version });
    check("a bank draft cannot be rewritten, only categorized or split", /API_DRAFTS_NO_CASH/.test(rewriteBank.error ?? ""), rewriteBank.error);
    const v2 = (await entry(bankId)).version;
    const categorized = await write(drafter.secret, "categorize", randomUUID(), { id: bankId, expected_version: v2, account_id: account(7) });
    const afterCat = await linesOf(bankId);
    check(
      "categorize moves the category line, bank line kept",
      !categorized.error && afterCat.some((l) => l.account_id === account(7) && l.amount_cents === "1500") && afterCat.some((l) => l.account_id === account(1)),
      { error: categorized.error, afterCat },
    );
    check("still a draft after categorize", (await entry(bankId)).status === "draft");
    const postedCat = await write(drafter.secret, "categorize", randomUUID(), { id: posted.id, expected_version: 2, account_id: account(7) });
    check("a posted entry cannot be categorized", /ACCT_POSTED_IMMUTABLE|ACCT_STALE_VERSION/.test(postedCat.error ?? ""), postedCat.error);
    const v3 = (await entry(bankId)).version;
    const split = await write(drafter.secret, "split", randomUUID(), {
      id: bankId,
      expected_version: v3,
      splits: [
        { account_id: account(6), amount_cents: "1000" },
        { account_id: account(7), amount_cents: "500" },
      ],
    });
    const afterSplit = await linesOf(bankId);
    check("split across two categories", !split.error && afterSplit.length === 3, { error: split.error, afterSplit });
    check("categorize set the kind: an expense paid out is an expense", (await kindOf(bankId)) === "expense");

    // Money in: an expense category makes it a refund, and amount splits are positive cents.
    const deposit = await ownerBankDraft("Card refund (bank)", "2000", account(5));
    const refund = await write(drafter.secret, "categorize", randomUUID(), { id: deposit.id, expected_version: deposit.version, account_id: account(6) });
    check("categorize: an expense on money in is a refund", !refund.error && (await kindOf(deposit.id)) === "refund", { error: refund.error, kind: await kindOf(deposit.id) });
    const income = await ownerBankDraft("Client payment (bank)", "3000", account(6));
    const incomeCat = await write(drafter.secret, "categorize", randomUUID(), { id: income.id, expected_version: income.version, account_id: account(5) });
    check("categorize: income on money in is income", !incomeCat.error && (await kindOf(income.id)) === "income", incomeCat.error);
    const depositSplit = await write(drafter.secret, "split", randomUUID(), {
      id: income.id,
      expected_version: (await entry(income.id)).version,
      splits: [
        { account_id: account(5), amount_cents: "1800" },
        { account_id: account(6), amount_cents: "1200" },
      ],
    });
    const depositLines = await linesOf(income.id);
    check(
      "split: a deposit splits by positive amounts, stored with the books' sign",
      !depositSplit.error && depositLines.some((l) => l.account_id === account(5) && l.amount_cents === "-1800") && depositLines.some((l) => l.account_id === account(6) && l.amount_cents === "-1200"),
      { error: depositSplit.error, depositLines },
    );

    // Bulk categorize: all or nothing.
    const makeDraft = (memo: string) => ownerBankDraft(memo, "-1500", account(6));
    const a1 = await makeDraft("Bulk one");
    const a2 = await makeDraft("Bulk two");
    const bulkBad = await write(drafter.secret, "categorize.bulk", randomUUID(), {
      items: [
        { id: a1.id, expected_version: a1.version, account_id: account(7) },
        { id: a2.id, expected_version: a2.version + 5, account_id: account(7) },
      ],
    });
    const untouched = (await linesOf(a1.id)).some((l) => l.account_id === account(6));
    check("bulk: one stale item refuses the whole batch", !!bulkBad.error && untouched, { error: bulkBad.error, untouched });
    const bulkGood = await write(drafter.secret, "categorize.bulk", randomUUID(), {
      items: [
        { id: a1.id, expected_version: a1.version, account_id: account(7) },
        { id: a2.id, expected_version: a2.version, account_id: account(7) },
      ],
    });
    check(
      "bulk: both categorized together",
      !bulkGood.error && (bulkGood.rows[0]?.r.results as unknown[])?.length === 2 && (await linesOf(a2.id)).some((l) => l.account_id === account(7)),
      bulkGood.error,
    );

    // Rules never auto-post and are create-only.
    const ruleIdem = randomUUID();
    const rule = await write(drafter.secret, "rule.create", ruleIdem, {
      name: "Figma is software",
      priority: 50,
      enabled: true,
      auto_post: true,
      conditions: { descriptor_key: { contains: "FIGMA" } },
      actions: { account_id: account(6) },
    });
    await superuser();
    const ruleRow = (await db.query<{ auto_post: boolean; enabled: boolean }>("SELECT auto_post, enabled FROM accounting.rules WHERE name='Figma is software'")).rows[0];
    check(
      "rule created switched off and never auto-posting, whatever was sent",
      !rule.error && ruleRow?.auto_post === false && ruleRow?.enabled === false,
      { error: rule.error, ruleRow },
    );
    const ghostPayee = await write(drafter.secret, "rule.create", randomUUID(), {
      name: "Ghost payee",
      conditions: { descriptor_key: { contains: "GHOST" } },
      actions: { account_id: account(6), payee_id: randomUUID() },
    });
    check("a rule naming a payee that does not exist is refused", /API_INVALID_INPUT/.test(ghostPayee.error ?? ""), ghostPayee.error);
    const bankCategory = await write(drafter.secret, "rule.create", randomUUID(), {
      name: "Bank as category",
      conditions: { descriptor_key: { contains: "BANK" } },
      actions: { account_id: account(1) },
    });
    check("a rule categorizing into a bank account is refused", /API_INVALID_INPUT/.test(bankCategory.error ?? ""), bankCategory.error);
    const smuggled = await write(drafter.secret, "rule.create", randomUUID(), {
      name: "Smuggled",
      conditions: { descriptor_key: { contains: "SMUG" }, auto_post: true, extra: 1 },
      actions: { account_id: account(6), auto_post: true },
    });
    await superuser();
    const smuggledRow = (
      await db.query<{ conditions: Record<string, unknown>; actions: Record<string, unknown> }>("SELECT conditions, actions FROM accounting.rules WHERE name='Smuggled'")
    ).rows[0];
    check(
      "rule conditions and actions are rebuilt from allowed fields only",
      !smuggled.error && !("auto_post" in (smuggledRow?.conditions ?? {})) && !("extra" in (smuggledRow?.conditions ?? {})) && !("auto_post" in (smuggledRow?.actions ?? {})),
      { error: smuggled.error, smuggledRow },
    );
    const payee = await write(drafter.secret, "contact.create", randomUUID(), { name: "Figma", roles: ["vendor"], default_account_id: account(6) });
    check("contact created", !payee.error && !!payee.rows[0]?.r, payee.error);
    const bankDefault = await write(drafter.secret, "contact.create", randomUUID(), { name: "Bank default", roles: ["vendor"], default_account_id: account(1) });
    check("a contact defaulting to a bank account is refused", /API_INVALID_INPUT/.test(bankDefault.error ?? ""), bankDefault.error);
    check("'payee.create' is no longer an API operation", /API_COMMAND_NOT_ALLOWED/.test((await write(drafter.secret, "payee.create", randomUUID(), { name: "Old", kind: "vendor" })).error ?? ""));
    await superuser();
    const figma = (await db.query<{ id: string }>("SELECT id FROM accounting.parties WHERE name='Figma'")).rows[0].id;
    const kept = await write(drafter.secret, "draft.create", randomUUID(), { ...draftArgs, memo: "Keeps payee", kind: "expense", payee_id: figma });
    const keptId = kept.rows[0]?.r.id as string;
    const keptUpdate = await write(drafter.secret, "draft.update", randomUUID(), {
      id: keptId,
      expected_version: (await entry(keptId)).version,
      entry_date: draftArgs.entry_date,
      memo: "Keeps payee, renamed",
      lines: draftArgs.lines,
    });
    await superuser();
    const keptRow = (await db.query<{ kind: string; payee_id: string | null }>("SELECT kind, payee_id FROM accounting.journal_entries WHERE id=$1", [keptId])).rows[0];
    check("an update keeps the kind and payee it leaves out", !keptUpdate.error && keptRow?.kind === "expense" && keptRow?.payee_id === figma, { error: keptUpdate.error, keptRow });
    const lists = await service<{ p: { payees: unknown[] }; r: { rules: unknown[] } }>(
      "SELECT public.api_accounting($1,'payees','{}') p, public.api_accounting($1,'rules','{}') r",
      [hash(drafter.secret)],
    );
    check("payees and rules read back", lists.rows[0]?.p.payees.length === 1 && lists.rows[0]?.r.rules.length === 2, lists.error);

    // Contacts: suggestions from the API, the duplicate guards, suggestion-only updates.
    const refusal = (error: string | undefined) => {
      const json = /\b(?:API|ACCT)_[A-Z_]+ (\{[\s\S]*\})/.exec(error ?? "")?.[1];
      return json ? (JSON.parse(json) as Record<string, any>) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const party = async (id: string) => {
      await superuser();
      return (
        await db.query<{ name: string; roles: string[]; review_status: string; suggested_by: string | null; version: number; email: string | null; is_archived: boolean }>(
          "SELECT name, roles, review_status, suggested_by, version, email, is_archived FROM accounting.parties WHERE id=$1",
          [id],
        )
      ).rows[0];
    };
    const figmaRow = await party(figma);
    check("a contact from the API is a suggestion naming the agent", figmaRow?.review_status === "suggested" && figmaRow?.suggested_by === agentId, figmaRow);
    const github = await write(drafter.secret, "contact.create", randomUUID(), { name: "GitHub", roles: ["vendor"] });
    const githubId = github.rows[0]?.r.id as string;
    check("contact: GitHub added", !github.error && !!githubId, github.error);
    const githubInc = await write(drafter.secret, "contact.create", randomUUID(), { name: "Github, Inc.", roles: ["vendor"] });
    check(
      "contact: 'Github, Inc.' is the same contact as 'GitHub', refused with it",
      /API_CONTACT_DUPLICATE/.test(githubInc.error ?? "") && refusal(githubInc.error).existing?.id === githubId,
      githubInc.error,
    );
    const githubCaps = await write(drafter.secret, "contact.create", randomUUID(), { name: "GITHUB INC", roles: ["vendor"] });
    check("contact: 'GITHUB INC' is a duplicate too", /API_CONTACT_DUPLICATE/.test(githubCaps.error ?? ""), githubCaps.error);
    const figmaAgain = await write(drafter.secret, "contact.create", randomUUID(), { name: "figma", roles: ["client"] });
    check(
      "contact: an exact duplicate names the existing contact and its roles",
      /API_CONTACT_DUPLICATE/.test(figmaAgain.error ?? "") && refusal(figmaAgain.error).existing?.name === "Figma" && refusal(figmaAgain.error).existing?.roles?.[0] === "vendor",
      figmaAgain.error,
    );
    const google = await write(drafter.secret, "contact.create", randomUUID(), { name: "Google", roles: ["vendor"] });
    const googleId = google.rows[0]?.r.id as string;
    const workspaceArgs = { name: "Google Workspace", roles: ["vendor"], email: "billing@google.test" };
    const workspace = await write(drafter.secret, "contact.create", randomUUID(), workspaceArgs);
    check(
      "contact: 'Google Workspace' is a possible duplicate of 'Google'",
      /API_CONTACT_POSSIBLE_DUPLICATE/.test(workspace.error ?? "") &&
        (refusal(workspace.error).candidates as { id: string }[] | undefined)?.some((c) => c.id === googleId) === true,
      workspace.error,
    );
    const workspaceOk = await write(drafter.secret, "contact.create", randomUUID(), { ...workspaceArgs, not_duplicate_of: [googleId] });
    const workspaceId = workspaceOk.rows[0]?.r.id as string;
    check("contact: added once every candidate is named in not_duplicate_of", !workspaceOk.error && !!workspaceId, workspaceOk.error);
    const workspaceIdem = randomUUID();
    const zoom = await write(drafter.secret, "contact.create", workspaceIdem, { name: "Zoom", roles: ["vendor"] });
    const zoomReplay = await write(drafter.secret, "contact.create", workspaceIdem, { name: "Zoom", roles: ["vendor"] });
    check("contact: a retry with the same key replays instead of refusing a duplicate", !zoomReplay.error && zoomReplay.rows[0]?.r.id === zoom.rows[0]?.r.id, zoomReplay.error);
    for (const roles of [[], ["boss"]]) {
      const bad = await write(drafter.secret, "contact.create", randomUUID(), { name: `Roles ${roles.length}`, roles });
      check(`contact: roles ${JSON.stringify(roles)} are refused`, /ACCT_INVALID_ROLES/.test(bad.error ?? ""), bad.error);
    }
    const dupRoles = await write(drafter.secret, "contact.create", randomUUID(), { name: "Acme Studio", roles: ["vendor", "client", "vendor"] });
    check(
      "contact: roles are stored once each, in order",
      !dupRoles.error && JSON.stringify((await party(dupRoles.rows[0]?.r.id as string))?.roles) === JSON.stringify(["client", "vendor"]),
      dupRoles.error,
    );
    const wsBefore = await party(workspaceId);
    const wsUpdate = await write(drafter.secret, "contact.update", randomUUID(), {
      id: workspaceId,
      expected_version: wsBefore.version,
      roles: ["vendor", "financial"],
      phone: "555-0100",
    });
    const wsAfter = await party(workspaceId);
    check(
      "contact: a suggestion can be updated; fields left out stay",
      !wsUpdate.error && JSON.stringify(wsAfter?.roles) === JSON.stringify(["vendor", "financial"]) && wsAfter?.email === "billing@google.test" && wsAfter?.review_status === "suggested",
      { error: wsUpdate.error, wsAfter },
    );
    const renameDup = await write(drafter.secret, "contact.update", randomUUID(), { id: workspaceId, expected_version: wsAfter.version, name: "GitHub LLC" });
    check("contact: a rename onto another contact's name is refused", /API_CONTACT_DUPLICATE/.test(renameDup.error ?? ""), renameDup.error);
    const staleUpdate = await write(drafter.secret, "contact.update", randomUUID(), { id: workspaceId, expected_version: wsBefore.version, notes: "x" });
    check("contact: a stale update is refused", /ACCT_STALE_VERSION/.test(staleUpdate.error ?? ""), staleUpdate.error);
    const figmaVersion = (await party(figma)).version;
    await as(fixtureOwner);
    await owner({ type: "party.approve", id: randomUUID(), ids: [figma], expected_versions: { [figma]: figmaVersion } });
    check("contact: the owner approves a suggestion", (await party(figma))?.review_status === "confirmed");
    const onConfirmed = await write(drafter.secret, "contact.update", randomUUID(), { id: figma, expected_version: (await party(figma)).version, notes: "Agent note" });
    check("contact: a confirmed contact cannot be changed by the API", /API_CONTACT_CONFIRMED/.test(onConfirmed.error ?? ""), onConfirmed.error);

    // Assigning a contact: a blank contact becomes set, drafts and posted alike, and nothing else changes.
    const postedBank = async (memo: string, cents: string, date = "2026-03-06", description?: string) => {
      const d = await ownerBankDraft(memo, cents, account(6), description, date);
      await as(fixtureOwner);
      const p = await owner({ type: "entry.post", id: d.id, expected_version: d.version });
      return { id: d.id, version: p.version as number };
    };
    const snapshot = async (id: string) => {
      await superuser();
      const e = (await db.query("SELECT entry_date, memo, kind, status, reason, register_id, transfer_group_id, review_pending, descriptor_key, posted_at FROM accounting.journal_entries WHERE id=$1", [id])).rows[0];
      return JSON.stringify({ e, lines: await linesOf(id) });
    };
    const reviewed = await postedBank("GitHub Team plan", "-400");
    const before = await snapshot(reviewed.id);
    const assigned = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: githubId, entries: [{ id: reviewed.id, expected_version: reviewed.version }] });
    const afterAssign = await entry(reviewed.id);
    check(
      "assign: a reviewed transaction gets its blank contact",
      !assigned.error && afterAssign?.payee_id === githubId && afterAssign?.status === "posted" && (assigned.rows[0]?.r.entries as { id: string }[])?.[0]?.id === reviewed.id,
      { error: assigned.error, afterAssign },
    );
    check("assign: lines, amounts, dates and status are untouched", (await snapshot(reviewed.id)) === before);
    const again = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: googleId, entries: [{ id: reviewed.id, expected_version: afterAssign.version }] });
    check(
      "assign: an entry that already has a contact is refused, naming it",
      /API_CONTACT_ALREADY_SET/.test(again.error ?? "") && refusal(again.error).entry_id === reviewed.id && refusal(again.error).contact?.name === "GitHub",
      again.error,
    );
    const draftBlank = await ownerBankDraft("GitHub Copilot", "-1000", account(6));
    const staleBlank = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: githubId, entries: [{ id: draftBlank.id, expected_version: draftBlank.version + 3 }] });
    check("assign: a stale version is refused", /ACCT_STALE_VERSION/.test(staleBlank.error ?? ""), staleBlank.error);
    const freshPosted = await postedBank("GitHub Actions", "-200");
    const mixed = await write(drafter.secret, "contact.assign", randomUUID(), {
      contact_id: githubId,
      entries: [
        { id: freshPosted.id, expected_version: freshPosted.version },
        { id: draftBlank.id, expected_version: draftBlank.version + 3 },
      ],
    });
    check("assign: all or nothing, one stale entry keeps the others blank", !!mixed.error && (await entry(freshPosted.id))?.payee_id === null, mixed.error);
    await as(fixtureOwner);
    const transfer = await owner({ type: "transfer.create", id: randomUUID(), amount_cents: "700", from_account_id: account(1), to_account_id: account(9), outgoing_date: "2026-03-07", incoming_date: "2026-03-07", memo: "Move to savings" });
    const transferEntry = await entry(transfer.outgoing_entry_id as string);
    const onTransfer = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: githubId, entries: [{ id: transfer.outgoing_entry_id, expected_version: transferEntry.version }] });
    check("assign: a transfer between own accounts is refused", /API_CONTACT_TRANSFER/.test(onTransfer.error ?? "") && refusal(onTransfer.error).entry_id === transfer.outgoing_entry_id, onTransfer.error);
    const closed = await postedBank("Old GitHub invoice", "-300", "2025-11-10");
    await as(fixtureOwner);
    await owner({ type: "period.lock", id: randomUUID(), month: "2025-11-01" });
    const onClosed = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: githubId, entries: [{ id: closed.id, expected_version: closed.version }] });
    check("assign: a transaction in a locked month is refused", /ACCT_PERIOD_LOCKED|ACCT_LATER_PERIOD_LOCKED/.test(onClosed.error ?? "") && (await entry(closed.id))?.payee_id === null, onClosed.error);
    const archivedContact = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: randomUUID(), entries: [{ id: freshPosted.id, expected_version: freshPosted.version }] });
    check("assign: a contact that does not exist is refused", /API_INVALID_INPUT/.test(archivedContact.error ?? ""), archivedContact.error);
    const draftOk = await write(drafter.secret, "contact.assign", randomUUID(), {
      contact_id: githubId,
      entries: [
        { id: freshPosted.id, expected_version: freshPosted.version },
        { id: draftBlank.id, expected_version: draftBlank.version },
      ],
    });
    check(
      "assign: drafts and posted entries together",
      !draftOk.error && (await entry(freshPosted.id))?.payee_id === githubId && (await entry(draftBlank.id))?.payee_id === githubId && (await entry(draftBlank.id))?.status === "draft",
      draftOk.error,
    );

    // Remember: bank descriptions become key aliases, never taking another contact's.
    const ghFeedA = await ownerBankDraft("GitHub", "-900", account(6), "GITHUB.COM SUBSCRIPTION");
    const ghFeedB = await ownerBankDraft("GitHub", "-950", account(6), "GITHUB.COM SUBSCRIPTION");
    const zoomFeed = await ownerBankDraft("Zoom", "-1500", account(6), "ZOOM.US VIDEO");
    await superuser();
    const zoomKey = (await db.query<{ k: string }>("SELECT descriptor_key k FROM accounting.journal_entries WHERE id=$1", [zoomFeed.id])).rows[0].k;
    const ghKey = (await db.query<{ k: string }>("SELECT descriptor_key k FROM accounting.journal_entries WHERE id=$1", [ghFeedA.id])).rows[0].k;
    await as(fixtureOwner);
    await owner({ type: "alias.save", id: randomUUID(), expected_version: 0, party_id: figma, match_kind: "key", pattern: zoomKey, enabled: true });
    const remembered = await write(drafter.secret, "contact.assign", randomUUID(), {
      contact_id: githubId,
      remember: true,
      entries: [
        { id: ghFeedA.id, expected_version: ghFeedA.version },
        { id: ghFeedB.id, expected_version: ghFeedB.version },
        { id: zoomFeed.id, expected_version: zoomFeed.version },
      ],
    });
    await superuser();
    const aliases = (await db.query<{ party_id: string; pattern: string }>("SELECT party_id, pattern FROM accounting.payee_aliases ORDER BY pattern")).rows;
    const r = remembered.rows[0]?.r as { remembered?: string[]; not_remembered?: { descriptor_key: string; contact: { id: string } }[] } | undefined;
    check(
      "remember: the GitHub description becomes a key alias for GitHub",
      !remembered.error && aliases.some((a) => a.pattern === ghKey && a.party_id === githubId) && JSON.stringify(r?.remembered) === JSON.stringify([ghKey]),
      { error: remembered.error, aliases, r },
    );
    check(
      "remember: a description another contact owns is skipped and reported",
      aliases.filter((a) => a.pattern === zoomKey).length === 1 && aliases.find((a) => a.pattern === zoomKey)?.party_id === figma && r?.not_remembered?.[0]?.contact.id === figma,
      { aliases, r },
    );

    // The after-command check holds for assign: anything beyond the blank contact rolls back.
    await superuser();
    await db.exec(`CREATE FUNCTION public.test_sneak_assign() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.payee_id IS NULL AND NEW.payee_id IS NOT NULL AND OLD.status = 'posted' THEN NEW.memo := NEW.memo || ' (changed)'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER zz_test_sneak_assign BEFORE UPDATE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION public.test_sneak_assign();`);
    const sneakTarget = await postedBank("Sneaky memo", "-250");
    const sneakAssign = await write(drafter.secret, "contact.assign", randomUUID(), { contact_id: githubId, entries: [{ id: sneakTarget.id, expected_version: sneakTarget.version }] });
    check(
      "after-command check: an assign that changed more than the contact is rolled back",
      /API_DRAFTS_ONLY/.test(sneakAssign.error ?? "") && (await entry(sneakTarget.id))?.payee_id === null,
      sneakAssign.error,
    );
    await db.exec("DROP TRIGGER zz_test_sneak_assign ON accounting.journal_entries; DROP FUNCTION public.test_sneak_assign();");

    // Idempotency claims carry a token: only their holder finishes or releases them.
    const claimKey = randomUUID();
    const claim = async () =>
      (await service<{ r: { state: string; token?: string } }>("SELECT public.api_idempotency_claim($1,$2,'h') r", [hash(drafter.secret), claimKey])).rows[0]?.r;
    const first = await claim();
    const second = await claim();
    check("idempotency: first claim is new with a token", first?.state === "new" && !!first.token, first);
    check("idempotency: a concurrent retry is busy", second?.state === "busy", second);
    await service("SELECT public.api_idempotency_release($1,$2,$3)", [hash(drafter.secret), claimKey, randomUUID()]);
    check("idempotency: a wrong token cannot release the claim", (await claim())?.state === "busy");
    await service("SELECT public.api_idempotency_finish($1,$2,$3,200,$4)", [hash(drafter.secret), claimKey, first?.token, JSON.stringify({ ok: true })]);
    const replayed = await claim();
    check("idempotency: the holder finishes it and retries replay", replayed?.state === "replay" && (replayed as { response?: { ok?: boolean } }).response?.ok === true, replayed);

    // The after-command check, independent of the allowlist: a stand-in for
    // a command that slipped through and posted (or touched another table)
    // must roll the whole command back.
    await superuser();
    await db.exec(`CREATE FUNCTION public.test_sneak() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.memo = 'Sneak post' THEN
          INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after)
          VALUES(NULL,'api',current_setting('accounting.operation_id')::uuid,'journal_entries',NEW.id,'entry.post','{"status":"draft"}','{"status":"posted"}');
        ELSIF NEW.memo = 'Sneak table' THEN
          INSERT INTO accounting.audit_log(actor_user_id,actor_kind,operation_id,table_name,row_id,action,before,after)
          VALUES(NULL,'api',current_setting('accounting.operation_id')::uuid,'bank_matches',gen_random_uuid(),'bank.match',NULL,'{}');
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_sneak AFTER INSERT ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION public.test_sneak();`);
    for (const memo of ["Sneak post", "Sneak table"]) {
      const sneak = await write(drafter.secret, "draft.create", randomUUID(), { ...draftArgs, memo });
      await superuser();
      const left = (await db.query("SELECT 1 FROM accounting.journal_entries WHERE memo=$1", [memo])).rows.length;
      check(`after-command check: '${memo}' is refused and rolled back`, /API_DRAFTS_ONLY/.test(sneak.error ?? "") && left === 0, { error: sneak.error, left });
    }
    await db.exec("DROP TRIGGER test_sneak ON accounting.journal_entries; DROP FUNCTION public.test_sneak();");

    // Nothing the agent did reached the official numbers: it posted nothing,
    // and on a reviewed entry it only ever filled a blank contact.
    await superuser();
    const agentPosted = (
      await db.query(
        "SELECT 1 FROM accounting.audit_log l WHERE l.actor_kind='api' AND l.table_name='journal_entries' AND coalesce(l.after->>'status','draft')<>coalesce(l.before->>'status','draft')",
      )
    ).rows.length;
    check("the agent changed no entry's status", agentPosted === 0, agentPosted);
    const agentOnPosted = (
      await db.query(
        "SELECT 1 FROM accounting.audit_log l WHERE l.actor_kind='api' AND l.table_name='journal_entries' AND l.before->>'status'='posted' AND NOT (l.before->>'payee_id' IS NULL AND l.after->>'payee_id' IS NOT NULL AND (l.after-ARRAY['payee_id','version','updated_at'])=(l.before-ARRAY['payee_id','version','updated_at']))",
      )
    ).rows.length;
    check("on reviewed entries the agent only filled blank contacts", agentOnPosted === 0, agentOnPosted);
    check("the owner's posted entry is untouched", (await entry(posted.id as string)).status === "posted");
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`API writes: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`API writes: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
