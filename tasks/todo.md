# Transaction search (2026-09-15)

Owner: the ledger search only matched memo and the raw bank descriptor with one
contiguous ILIKE. Card numbers, amounts, contacts, categories and dates were not
searchable. Make it robust without over-building: no new extensions, no
ranking, no saved searches.

## Plan
- [x] SQL: `accounting.search_terms(text)` tokenizer (quoted phrases, whitespace
      words, amount / whole-dollar / compare terms, LIKE escaping, 12-term cap)
- [x] SQL: `accounting.transactions` builds one lowercased document per entry
      (memo, descriptor, kind, dates in four spellings, contact name, line
      account code + name + memo + formatted amounts, bank institution + mask,
      matched bank descriptions) and requires every term to match (AND);
      amounts match any line or the entry magnitude; `>`/`<` compare magnitude
- [x] Migration `20260915135116_accounting_search.sql` + grants; canonical
      `schema.sql` edited in place (function body byte-identical)
- [x] TS mirror `src/lib/accounting/search.ts` for demo mode and tests
- [x] Ledger UI: demo filter uses the mirror; search-specific empty state;
      placeholder names what is searchable
- [x] `scripts/verify-accounting-search.ts`: SQL and TS parity over a seeded
      ledger (phrase, AND, amount, dollars, card mask, contact, category,
      date, compare, wildcard safety)
- [x] Run: search, transactions, schema, preload suites; lint; tsc

## Review
(filled in when done)

Done 2026-09-15. Suites: search (154), transactions (27), schema parity (16),
preload, lint, prettier, tsc all green. Left out on purpose: pg_trgm or a
search index (the ledger is small and the document is built per row at query
time), relevance ranking, match highlighting, saved searches, and a change to
the bank-review search, which still matches memo only.

Gotcha met on the way: the canonical schema.sql is hand-mirrored, and a JS
String.replace with a string replacement expands "$'" inside SQL regexes and
corrupted the file once; splice with a function replacer. Every accounting
function must be SECURITY DEFINER with search_path '' (verify-accounting-schema
enforces it), including pure helpers.

Full runner: 51/53. The two that fail, verify-accounting-db.ts and
verify-accounting-drop.ts, fail identically with the search migration removed,
so they predate this work and are not touched here.

# Team access and account theme (2026-09-15)

Owner: add a Team page with team_members and team_member_permissions like the
app workspace, and make the Appearance theme save to the account. Decisions:
books open to members with accounting.manage; permissions enforced in RLS;
owner sets the initial password when adding a member.

## Plan
- [x] Migration `20260915145008_team_access.sql`: team_members, role_permissions,
      team_member_permissions, helpers (current_team_member_id, role,
      has_permission, my_access, bootstrap_team_owner), guard trigger, seeds,
      RLS rewrite on live public tables, require_owner / document_access /
      operate bootstrap, business_profile_get membership check
- [x] Snapshot: `-- ACCOUNTING TEAM` region in schema.sql, policy blocks edited
      in place, catalog functions mirrored byte for byte, automations.sql policies
- [x] Harness: accounting-schema.ts filename regex, verify-accounting-schema.ts
      parity filters, fixture owner team row, `scripts/verify-team.ts`
- [x] Server: resolveAccess (demo, dev bypass, allow-list, bootstrap),
      requireAuth carries member + permissions, invite and email routes
- [x] Client: access context, dashboard layout gate, sidebar filter + footer,
      /team page with add, edit and permissions dialogs, page access cards,
      settings index Team card, accounting page copy
- [x] Theme: theme_preference on team_members, inline first-paint script,
      provider re-apply, appearance selector saves to the account
- [x] Types, .env.example, run schema parity, verify-team, tsc, lint, browser

## Review
Done 2026-09-15. Migration 20260915145008_team_access.sql is a fresh file; the
staged 20260915135116_accounting_search.sql belongs to the search feature and
was left alone so the two commits stay separate. Suites: verify-team (58),
schema parity (16, team objects now diffed), setup (62). tsc clean; eslint on
the changed files shows only three pre-existing dashboard warnings. Browser:
demo server on 3003 (another session, same tree) rendered /team, Add member,
Roles and permissions; screenshots under .playwright/.

Left for the owner: apply the migration to the finance project, sign in once
(the first sign-in claims the owner row), then add people under Team. The
theme selector saves to team_members.theme_preference; the dashboard layout
seeds the first paint from it, so a new device follows the account.

Gotchas met: a SECURITY DEFINER function still sees current_setting("role") as
authenticated, so the guard bypass is a transaction flag set by the bootstrap
RPC plus a no-session direct-database check; RLS WITH CHECK violations raise
rather than filter, so the test wraps them; the pglite harness only applies
migrations matching its filename regex and only loads the ACCOUNTING regions
of schema.sql, so the team objects live in an ACCOUNTING TEAM region that
loads before the catalog.

Follow-up 2026-09-15: read-only members no longer see write controls inside
pages their read key opens. Income list/detail/sources, expenses list/detail,
net worth list/detail and the tax estimator each take canManage =
hasPermission("<module>.manage") and render-gate every add, edit, delete,
toggle and inline field (TaxInputsCard, TaxHero, TaxBooksCallout and
QuarterTile gained readOnly / optional handler props; the setup wizard shows
an empty state instead). Owner view verified on the demo server; the
read-only branch is covered by tsc and code review until a real member exists.

Follow-up 2026-09-15: the privacy eye moved from browser data to the account.
team_members.privacy_hidden (in the same migration) is the source of truth;
PrivacyProvider takes the account value and a persist callback, the dashboard
layout seeds data-hidden before paint, cookie and localStorage stay as the
mirror for the root blocking script. Managers cannot flip another person's eye
(guard). Team suite 59 checks, parity 16.
