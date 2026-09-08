# Finance app moved to its own Supabase project (2026-09-07)

The admin (finance) app shared one Supabase project with the CRM app and the marketing website. It now has its own project. This note records what moved, how it was verified, and what is still to do. No data on the old project was changed or deleted.

## Projects

- Old, shared: project ref `zjwgovvgdbamgtjustuz`. Still holds the CRM, the website, and the admin tables until the owner signs off on removal.
- New, finance only: project ref `kedxsjrbnrffrzdoyveh`, region `aws-0-us-west-2`, Postgres 17.6.

## What was copied

Read-only from the old project over its REST API with the service key (GET requests only), inserted into the new project over a Postgres connection with each table's triggers disabled so history rows arrived verbatim.

| Table | Rows |
|---|---|
| income_sources | 7 |
| income_entries | 52 |
| income_amounts | 335 |
| income_line_items | 210 |
| expenses | 24 |
| expense_history | 48 |
| net_worth | 51 |
| tax_estimates | 6 |
| organization_config | 1 |
| federal_tax_configs | 1 |
| state_tax_configs | 1 |
| config_change_history | 4 |
| email_accounts | 1 |
| webhook_receipts | 7 |
| payroll_employees, payroll_runs, payroll_run_history, payroll_tax_deposits, payroll_deposit_history, payroll_forms, payroll_audit_events | 1, 1, 2, 4, 8, 3, 0 |

Verification compared, for every table, the row count, the sum of every numeric column and the latest value of every timestamp column between the two projects. All 21 tables match.

`public.business_profile` could not be read from the old project: its grants exclude the service role by design. The new project carries the schema's seeded default row; the owner re-enters the business details in Business settings.

## Schema on the new project

`admin/supabase/schema/schema.sql` applied as one script, giving 22 admin tables in `public`, the `accounting` schema with 27 tables and 56 functions, 17 seeded chart accounts, and the private `accounting-private` storage bucket. Two adjustments were needed at apply time, neither changed the repository:

- The regenerated snapshot names every not-null constraint (`CONSTRAINT "x_not_null" NOT NULL col`), which is Postgres 18 syntax. Supabase runs 17.6. The 263 lines are redundant with the inline `NOT NULL` on the same columns and were dropped in memory. Astra's regenerator should emit the inline form.
- Supabase's direct connection host is IPv6 only; the Session pooler host was used instead.

## Backups on the owner's machine

Both under `admin/.local/migration/` (gitignored):

- `backup-2026-09-08T03-06-34-789Z/`: every public table of the old project, CRM included, 81 tables and 40,105 rows, as JSON with a manifest.
- `dump-2026-09-08T03-07-07-733Z/`: the 21 admin tables with checksums; this is what the new project was loaded from.

Storage objects were not part of this. The accounting bucket was empty; CRM files stay on the old project.

## Follow-up the same evening

- The books showed "not configured" until the owner added `accounting` to the exposed API schemas in the dashboard; that setting is not part of any SQL file. The owner row was then inserted directly: `accounting.settings` with the new project's user id. The old setup card named `public.acct_settings`; fixed in `9d1741e`.
- Four admin tables live in a second schema file, `supabase/schema/automations.sql`, and were missed by the first pass: `automations`, `automation_actions`, `automation_runs`, `notifications` (the bell in the sidebar returned 404). The file was applied and the rows copied, 1, 2, 2 and 2, with `user_id` rewritten from the old project's user to the new owner because auth users are per project. Checksums match.
- The abandoned manual payroll module's eleven tables were dropped from the new project at the owner's request to keep the database lean: the seven `payroll_*` tables plus `organization_config`, `federal_tax_configs`, `state_tax_configs` and `config_change_history`, all read only by the payroll module and hidden behind `NEXT_PUBLIC_PAYROLL_ENABLED`. Their rows remain on the old project and in the disk backups. The automation form only queries payroll tables when that flag is on.
- Final shape of the new project: 15 tables in `public` (income, expenses, net worth, tax estimates, email accounts, webhook receipts, business profile, automations and notifications) and 27 in `accounting`.
- Defect found and repaired the same evening: the copy stringified JSON values before binding them, and the driver serialized them again, so every `jsonb` column arrived as a JSON string holding JSON (the tax estimator crashed on `income_sources.map`). The five affected columns (`tax_estimates.income_sources`, `capital_gains`, `payments`, `automations.trigger_config`, `automation_actions.action_config`) were un-nested in place, `updated_at` values bumped by that update were restored from the dump with triggers off, and the verifier now hashes every JSON column, which it had not done before. No array-typed columns exist on the admin tables, so nothing else was affected.
- Open in the repository: `supabase/schema/schema.sql` still defines the eleven payroll tables, and the payroll module code (`src/lib/payroll`, `src/components/features/payroll`, `src/app/(dashboard)/payroll`, `src/types/payroll.ts`) still exists behind the flag. Removing both keeps the snapshot honest; not done yet.

## Still to do

1. Owner: in the new project's dashboard add `accounting` to the exposed API schemas, create the login user under Authentication, and set `ADMIN_ALLOWED_EMAILS` on the deployed admin environment.
2. Owner: review income, expenses, net worth, tax estimates and email settings on the new project.
3. Owner: remove `NEW_DATABASE_URL` from `admin/.env` and delete `admin/.local/migration/env` once the move is signed off; both hold the database password.
4. After sign-off: a separate, dry-run-first script to drop the admin tables from the old project. Nothing is removed before then.
