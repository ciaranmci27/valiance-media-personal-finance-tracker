# Admin - Lessons Learned

## Migration file scoping

**Rule:** One migration file per feature, not one per table.

Admin's convention (as of `20260319_create_tax_estimates.sql`) is one file per feature even when the feature adds multiple tables. Follow it.

**Why this matters:** Grouping by table produces brittle ordering (`_01_`, `_02_`, etc. suffixes), fragments a reviewable unit of work, and obscures the fact that the tables deploy together as one logical change. One feature = one migration.

**Do not:** invent sub-file naming schemes like `<date>_payroll_01_configs.sql` + `<date>_payroll_02_employees.sql`.

**Do:** write `<date>_create_<feature>.sql` with all tables, triggers, RLS, and seed data inline, ordered by dependency.

## Dialogs carry one decision, not a briefing

**Rule:** An accounting dialog gets a 2 to 4 word title, no subtitle unless one sentence changes what the owner will do (otherwise the description is sr-only), only the fields the command needs, and everything else under an Advanced disclosure that still submits its default. One primary verb button plus a ghost Cancel.

**Why this matters:** On 2026-09-11 the owner said every modal "has just way too much information and even asks some things that are just not even needed", and that this makes the software feel more complicated than it is. Explaining the ledger inside a form is a tell of auditor-spec UI, not a help to a competent owner.

**Do not:** put policy paragraphs, "what happens next" notes, count boxes, or confirm-me checkboxes inside a dialog; pass `description` to a TextInput inside a narrow grid cell (it renders beside the label and wraps it).

**Do:** move a needed fact into the field helper text; default a hidden field sensibly; make the title the question ("Lock September 2026", "Map SaaS (4273)").
