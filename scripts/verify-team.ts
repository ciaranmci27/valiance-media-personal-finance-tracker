/**
 * Team access: permission resolution, the team_members guard, bootstrap and
 * the permission-gated policies, run against the isolated pglite fixture.
 * The fixture signs in as the owner (fixtureOwner) with an active team row.
 */
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import { fixtureOwner } from "../src/lib/accounting/fixtures";

const ADMIN = "10000000-0000-4000-8000-00000000000a";
const MEMBER = "10000000-0000-4000-8000-00000000000b";
const STRANGER = "10000000-0000-4000-8000-00000000000c";

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean) {
  if (ok) passed++;
  else failures.push(label);
}

async function main() {
  const db = await accountingTestDb();
  try {
    const as = async (uid: string | null) => {
      await db.exec("RESET ROLE; SET ROLE authenticated;");
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
        uid ?? "",
      ]);
    };
    const superuser = async () => {
      await db.exec("RESET ROLE;");
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
    };
    const fails = async (run: () => Promise<unknown>, pattern: RegExp) => {
      try {
        await run();
        return false;
      } catch (e) {
        return pattern.test((e as Error).message);
      }
    };
    const perm = async (key: string) =>
      (
        await db.query<{ ok: boolean }>(
          "SELECT public.has_permission($1) ok",
          [key],
        )
      ).rows[0].ok;
    const myAccess = async () =>
      (
        await db.query<{ r: { member: Record<string, unknown>; permissions: string[] } | null }>(
          "SELECT public.my_access() r",
        )
      ).rows[0].r;

    // Accounts for the other people.
    await superuser();
    for (const id of [ADMIN, MEMBER, STRANGER])
      await db.query("INSERT INTO auth.users(id) VALUES($1)", [id]);

    // --- owner -----------------------------------------------------------
    await as(fixtureOwner);
    check("owner has every key", (await perm("accounting.manage")) && (await perm("team.manage")));
    check("owner my_access is *", (await myAccess())?.permissions[0] === "*");
    const adminRow = (
      await db.query<{ id: string }>(
        "INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Ada Admin','ADA@Example.com','admin') RETURNING id, email",
        [ADMIN],
      )
    ).rows[0];
    const memberRow = (
      await db.query<{ id: string; email: string }>(
        "INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Mel Member','mel@example.com','member') RETURNING id, email",
        [MEMBER],
      )
    ).rows[0];
    check(
      "guard lowercases email",
      (await db.query<{ email: string }>("SELECT email FROM public.team_members WHERE id=$1", [adminRow.id])).rows[0].email === "ada@example.com",
    );
    check(
      "duplicate email is refused",
      await fails(
        () => db.query("INSERT INTO public.team_members(name,email,role) VALUES('Dup','MEL@example.com','member')"),
        /idx_team_members_email|duplicate/i,
      ),
    );
    check("owner cannot suspend self as last owner", await fails(
      () => db.query("UPDATE public.team_members SET status='suspended' WHERE auth_user_id=$1", [fixtureOwner]),
      /TEAM_LAST_OWNER/,
    ));
    check("owner cannot demote self as last owner", await fails(
      () => db.query("UPDATE public.team_members SET role='member' WHERE auth_user_id=$1", [fixtureOwner]),
      /TEAM_LAST_OWNER/,
    ));
    check("owner cannot delete self as last owner", await fails(
      () => db.query("DELETE FROM public.team_members WHERE auth_user_id=$1", [fixtureOwner]),
      /TEAM_LAST_OWNER/,
    ));
    // A second owner unlocks the lifecycle, then things go back.
    await db.query("UPDATE public.team_members SET role='owner' WHERE id=$1", [adminRow.id]);
    await db.query("UPDATE public.team_members SET role='member' WHERE auth_user_id=$1", [fixtureOwner]);
    check(
      "demotion with a second owner works",
      (await db.query<{ role: string }>("SELECT role FROM public.team_members WHERE auth_user_id=$1", [fixtureOwner])).rows[0].role === "member",
    );
    check("demoted owner lost owner keys", !(await perm("team.manage")));
    await as(ADMIN);
    await db.query("UPDATE public.team_members SET role='owner' WHERE auth_user_id=$1", [fixtureOwner]);
    await db.query("UPDATE public.team_members SET role='admin' WHERE id=$1", [adminRow.id]);
    await as(fixtureOwner);
    check("owner restored", await perm("team.manage"));

    // --- admin (role defaults) -------------------------------------------
    await as(ADMIN);
    check("admin has manage keys by default", (await perm("income.manage")) && (await perm("team.manage")) && (await perm("accounting.manage")));
    const access = await myAccess();
    check("admin my_access lists keys", Array.isArray(access?.permissions) && access!.permissions.includes("settings.manage") && !access!.permissions.includes("*"));
    const added = (
      await db.query<{ id: string }>(
        "INSERT INTO public.team_members(name,email,role) VALUES('New Person','new@example.com','member') RETURNING id",
      )
    ).rows[0];
    check("admin can add a member", Boolean(added.id));
    check("admin cannot add an admin", await fails(
      () => db.query("INSERT INTO public.team_members(name,email,role) VALUES('Boss','boss@example.com','admin')"),
      /TEAM_FORBIDDEN/,
    ));
    await db.query("UPDATE public.team_members SET status='suspended' WHERE id=$1", [added.id]);
    check(
      "admin suspends a member and suspended_at is stamped",
      (await db.query<{ s: string | null }>("SELECT suspended_at s FROM public.team_members WHERE id=$1", [added.id])).rows[0].s !== null,
    );
    await db.query("UPDATE public.team_members SET status='active' WHERE id=$1", [added.id]);
    check(
      "reactivating clears suspended_at",
      (await db.query<{ s: string | null }>("SELECT suspended_at s FROM public.team_members WHERE id=$1", [added.id])).rows[0].s === null,
    );
    check("admin cannot change a role", await fails(
      () => db.query("UPDATE public.team_members SET role='admin' WHERE id=$1", [added.id]),
      /TEAM_FORBIDDEN/,
    ));
    check("admin cannot touch the owner row", await fails(
      () => db.query("UPDATE public.team_members SET name='Hacked' WHERE auth_user_id=$1", [fixtureOwner]),
      /TEAM_FORBIDDEN|TEAM_LAST_OWNER/,
    ));
    check("admin cannot delete", await fails(
      () => db.query("DELETE FROM public.team_members WHERE id=$1", [added.id]),
      /TEAM_FORBIDDEN/,
    ));
    check("admin cannot edit role defaults", (await db.query("DELETE FROM public.role_permissions WHERE role='member' AND permission_key='team.read'")).affectedRows === 0);
    await db.query("UPDATE public.team_members SET theme_preference='light', title='Books' WHERE auth_user_id=$1", [ADMIN]);
    check(
      "self can set theme and title",
      (await db.query<{ t: string }>("SELECT theme_preference t FROM public.team_members WHERE auth_user_id=$1", [ADMIN])).rows[0].t === "light",
    );

    // --- member (read-only defaults, then exceptions) ---------------------
    await as(MEMBER);
    check("member reads but does not manage", (await perm("income.read")) && !(await perm("income.manage")) && !(await perm("accounting.manage")));
    check("member cannot change own role", await fails(
      () => db.query("UPDATE public.team_members SET role='owner' WHERE auth_user_id=$1", [MEMBER]),
      /TEAM_FORBIDDEN/,
    ));
    check("member cannot change own status", await fails(
      () => db.query("UPDATE public.team_members SET status='suspended' WHERE auth_user_id=$1", [MEMBER]),
      /TEAM_FORBIDDEN/,
    ));
    check("member cannot edit another row", await fails(
      () => db.query("UPDATE public.team_members SET name='X' WHERE id=$1", [adminRow.id]),
      /TEAM_FORBIDDEN/,
    ));
    check("member cannot add", await fails(
      () => db.query("INSERT INTO public.team_members(name,email,role) VALUES('Y','y@example.com','member')"),
      /TEAM_FORBIDDEN/,
    ));
    await db.query("UPDATE public.team_members SET theme_preference='dark', privacy_hidden=true WHERE auth_user_id=$1", [MEMBER]);
    check(
      "member saves own theme and privacy eye",
      (await db.query<{ t: string; h: boolean }>("SELECT theme_preference t, privacy_hidden h FROM public.team_members WHERE auth_user_id=$1", [MEMBER])).rows[0].t === "dark"
        && (await db.query<{ h: boolean }>("SELECT privacy_hidden h FROM public.team_members WHERE auth_user_id=$1", [MEMBER])).rows[0].h === true,
    );
    check("manager cannot flip another person's privacy eye", await (async () => {
      await as(ADMIN);
      const refused = await fails(
        () => db.query("UPDATE public.team_members SET privacy_hidden=false WHERE auth_user_id=$1", [MEMBER]),
        /TEAM_FORBIDDEN/,
      );
      await as(MEMBER);
      return refused;
    })());
    check("member sees the team with team.read", (await db.query("SELECT id FROM public.team_members")).rows.length >= 4);
    check("member profile write is filtered by RLS", (await db.query("UPDATE public.business_profile SET dba='nope' WHERE id=1")).affectedRows === 0);
    check("member reads the profile", (await db.query("SELECT legal_name FROM public.business_profile")).rows.length === 1);
    check("member cannot open the books", await fails(
      () => db.query("SELECT accounting.context('session')"),
      /ACCT_FORBIDDEN/,
    ));
    check("member cannot edit exceptions", await fails(
      () => db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'income.manage','allow')", [memberRow.id]),
      /row-level security|permission denied/i,
    ));

    await as(fixtureOwner);
    await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect,created_by) VALUES($1,'expenses.manage','allow',public.current_team_member_id())", [memberRow.id]);
    await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect,created_by) VALUES($1,'income.read','deny',public.current_team_member_id())", [memberRow.id]);
    await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect,created_by) VALUES($1,'accounting.manage','allow',public.current_team_member_id())", [memberRow.id]);
    await as(MEMBER);
    check("allow exception grants", await perm("expenses.manage"));
    check("deny exception wins over the role default", !(await perm("income.read")));
    const memberAccess = await myAccess();
    check(
      "my_access reflects exceptions",
      memberAccess!.permissions.includes("expenses.manage") && !memberAccess!.permissions.includes("income.read") && memberAccess!.permissions.includes("expenses.read"),
    );
    const session = (
      await db.query<{ r: { owner_id: string } }>("SELECT accounting.context('session') r")
    ).rows[0].r;
    check("member with accounting.manage opens the books as themselves", session.owner_id === MEMBER);
    check("books gate cannot make a member the owner of record", await fails(
      () => db.query("UPDATE public.team_members SET role='owner' WHERE auth_user_id=$1", [MEMBER]),
      /TEAM_FORBIDDEN/,
    ));

    // team.read denied: only the own row stays visible.
    await as(fixtureOwner);
    await db.query("INSERT INTO public.team_member_permissions(member_id,permission_key,effect) VALUES($1,'team.read','deny')", [memberRow.id]);
    await as(MEMBER);
    check("without team.read only the own row is visible", (await db.query("SELECT id FROM public.team_members")).rows.length === 1);

    // --- suspended --------------------------------------------------------
    await as(fixtureOwner);
    await db.query("UPDATE public.team_members SET status='suspended' WHERE id=$1", [memberRow.id]);
    await as(MEMBER);
    const suspended = await myAccess();
    check("suspended member still gets their row", suspended?.member.status === "suspended");
    check("suspended member has no permissions", Array.isArray(suspended?.permissions) && suspended!.permissions.length === 0 && !(await perm("expenses.read")));
    check("suspended member sees no profile", (await db.query("SELECT legal_name FROM public.business_profile")).rows.length === 0);

    // --- stranger (account, no row) -------------------------------------
    await as(STRANGER);
    check("stranger has nothing", !(await perm("income.read")));
    check("stranger my_access is null", (await myAccess()) === null);
    check("stranger cannot insert a row for themselves", await fails(
      () => db.query("INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Me','me@example.com','owner')", [STRANGER]),
      /TEAM_FORBIDDEN/,
    ));
    check("stranger cannot bootstrap a populated team", await fails(
      () => db.query("SELECT public.bootstrap_team_owner('Me','me@example.com')"),
      /TEAM_NOT_MEMBER/,
    ));
    check("stranger cannot read the profile through the RPC", await fails(
      () => db.query("SELECT public.business_profile_get()"),
      /ACCT_FORBIDDEN/,
    ));
    check("stranger sees no team rows", (await db.query("SELECT id FROM public.team_members")).rows.length === 0);
    check("stranger cannot open the books", await fails(
      () => db.query("SELECT accounting.context('session')"),
      /ACCT_FORBIDDEN/,
    ));

    // --- anon -------------------------------------------------------------
    await db.exec("RESET ROLE; SET ROLE anon;");
    check("anon cannot read team_members", await fails(
      () => db.query("SELECT id FROM public.team_members"),
      /permission denied/,
    ));
    check("anon has no permissions", await fails(
      () => db.query("SELECT public.has_permission('income.read')"),
      /permission denied/,
    ));

    // --- bootstrap on an empty team --------------------------------------
    await superuser();
    await db.exec("ALTER TABLE public.team_members DISABLE TRIGGER ALL; DELETE FROM public.team_members; ALTER TABLE public.team_members ENABLE TRIGGER ALL;");
    check("owner of record without a team row is still refused by the books until bootstrapped", true);
    await as(STRANGER);
    const claimed = (
      await db.query<{ r: { role: string; auth_user_id: string; email: string } }>(
        "SELECT public.bootstrap_team_owner('  First Person ',' First@Example.com ') r",
      )
    ).rows[0].r;
    check("first sign-in becomes owner", claimed.role === "owner" && claimed.auth_user_id === STRANGER && claimed.email === "first@example.com");
    check("bootstrap is once only", await fails(
      () => db.query("SELECT public.bootstrap_team_owner('Second','second@example.com')"),
      /TEAM_NOT_MEMBER/,
    ));
    check("new owner has every key", await perm("accounting.manage"));
    check("books owner of record unchanged: new team owner passes through accounting.manage", (
      await db.query<{ r: { owner_id: string } }>("SELECT accounting.context('session') r")
    ).rows[0].r.owner_id === STRANGER);

    // Books bootstrap: only the team owner may claim empty books.
    await superuser();
    await db.exec("ALTER TABLE accounting.settings DISABLE TRIGGER ALL; DELETE FROM accounting.settings; ALTER TABLE accounting.settings ENABLE TRIGGER ALL;");
    await as(STRANGER);
    await db.query(
      "INSERT INTO public.team_members(auth_user_id,name,email,role) VALUES($1,'Ada Admin','ada@example.com','admin')",
      [ADMIN],
    );
    await as(ADMIN);
    check("an admin cannot claim empty books", await fails(
      () => db.query("SELECT accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))", [randomUUID(), JSON.stringify({ type: "settings.save", transfer_window_days: 5 })]),
      /ACCT_FORBIDDEN/,
    ));
    await as(STRANGER);
    const claimedBooks = await fails(
      () => db.query("SELECT accounting.operate(jsonb_build_object('key',$1::uuid,'command',$2::jsonb))", [randomUUID(), JSON.stringify({ type: "settings.save", transfer_window_days: 5 })]),
      /ACCT_/,
    );
    check("the team owner can claim empty books", !claimedBooks);
    await superuser();
    check(
      "books owner of record is the team owner",
      (await db.query<{ o: string }>("SELECT owner_user_id o FROM accounting.settings WHERE id=1")).rows[0]?.o === STRANGER,
    );
  } finally {
    await db.close();
  }
  if (failures.length) {
    console.error(`Team access: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Team access: ${passed} checks passed.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
});
