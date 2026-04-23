# Admin - Lessons Learned

## Migration file scoping

**Rule:** One migration file per feature, not one per table.

Admin's convention (as of `20260319_create_tax_estimates.sql`) is one file per feature even when the feature adds multiple tables. Follow it.

**Why this matters:** Grouping by table produces brittle ordering (`_01_`, `_02_`, etc. suffixes), fragments a reviewable unit of work, and obscures the fact that the tables deploy together as one logical change. One feature = one migration.

**Do not:** invent sub-file naming schemes like `<date>_payroll_01_configs.sql` + `<date>_payroll_02_employees.sql`.

**Do:** write `<date>_create_<feature>.sql` with all tables, triggers, RLS, and seed data inline, ordered by dependency.
