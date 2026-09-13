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

## A read-first dashboard is not a data-entry surface

**Rule:** When a screen is where the owner types the numbers in, the fields or a guided path to them must be visible on the resting page. Rows that open a sheet, ghost "Add" buttons under uppercase labels, and a settings gear are fine for editing data that already exists; they hide the way in for data that does not.

**Why this matters:** The 2026-09-11 Tax Estimator rebuild moved every input into a sheet to get a Robinhood-simple read. The owner's first reaction on a thin year was that the UI is "a bit confusing in terms of filling in your information": the page led with a computed answer and nothing said where to start.

**Do not:** ship a hero number above an empty or half-empty form; rely on "Select a row to edit" as the only hint; put the profile fields that drive the math behind an icon.

**Do:** show a guided setup with plain-language steps while the year is thin, describe each section in the owner's words ("Tax your employer already took out"), offer template chips that add a pre-typed row, and keep amounts editable in place with the sheet for the rest.

## A source belongs where the owner adds data, not in a mapping layer elsewhere

**Rule:** When another module can supply a number to an input screen, expose it as an entry in that screen's own "Add" menu, next to the manual and imported options, and store the figure on the row (actual so far plus the owner's rest of year). Do not build a separate screen that maps existing rows as "targets", snapshots them and overlays the numbers back.

**Why this matters:** The accounting tax link (2026-09) did exactly that: rows had to be created by hand in the estimator, then linked from Accounting, then overlaid and locked, with a worker, staleness rules and a review pill. The owner's verdict on 2026-09-12 was that "the logic doesn't make sense" and that the books should sit in the Add menu like tracked income. The overlay design also produced the bug where a failed link read zeroed a row, because the shown value and the stored value were different things.

**Do not:** invert the direction of data (build here, link there); lock rows the owner cannot see the source of; keep a computed value only in an overlay.

**Do:** "Add → From your books" with a checklist of figures and the reasons any are held back; store actual plus rest of year on the row; refresh on load and on demand with a cents-exact diff; keep the last values when a refresh fails.

## No AI integrations in the admin; rules, then a manual-review flag

**Rule:** When something looks automatable, write deterministic rules (macros) from the data the books already carry: system purpose, report group, prior year, account name. Whatever a rule cannot place is flagged for the owner to pick. Do not propose or wire an LLM call, an SDK, or an API key.

**Why this matters:** On 2026-09-12 I planned a Claude classifier for the accounts a rule could not map. The owner stopped it: "I do not want any AI integrations. If it can be solved with macros, then signal that it needs a manual review." The books are financial records; a deterministic rule can be read, tested and explained, and a "needs your pick" flag is the honest answer for the rest.

**Do not:** treat an earlier mention of "AI" in a question as a request for it; add `@anthropic-ai/sdk` or any provider key to the admin.

**Do:** rules with named reasons ("Account purpose is Meals"), a test table per rule, and an explicit review group for the leftovers.

## A data gate must surface as a next step where the owner is

**Rule:** When a feature holds something back because the books are incomplete (accounts without a tax treatment, an unverified payroll register, an unmapped bank feed), the missing piece is a setup step. It belongs in the one prioritized guide every screen shows, with the fix one click away, not only in the disabled row of the feature it gates.

**Why this matters:** On 2026-09-12 the owner learned that 18 accounts had no tax treatment only by opening "From your books" on the Tax Estimator. The notice system existed but knew only bank-feed states, stacked everything it had, and never rendered outside Accounting. The owner's verdict: "our UX is bad", and "we shouldn't spam a ton of banners but rather go in proper UX order based on priority".

**Do not:** add another banner per feature; stack every notice at once; explain a gate only in the place it blocks; make the owner open a picker to discover what the books still need.

**Do:** one ordered step list (bank access, mapping, sync, imports, classification, treatments, evidence, payroll, primary system), the first open step shown everywhere with its action, the rest behind "N more after this", steps that clear from data, and only informational steps that can be put off.

## A guide step must be clearable and say what to do

**Rule:** Before a condition becomes a setup step, prove two things: the owner can make it go away by doing what the step says, and the step's own words say what that is. A control the books maintain for auditors (import parity, history checks) is not a step unless the owner has a real path to satisfy it. Every non-critical step gets a "Later".

**Why this matters:** The first live banner (2026-09-12) led with "Finish checking 1 import against the source". The owner: "what does this even mean? There's no way for me to acknowledge it and it doesn't tell me what I need to do? It's just permanently stuck here?" It was: the Wave import spans four years, the parity check only clears batches inside one calendar year, and every posted entry inside the window re-flags it. The same condition also gated business profit in the books picker.

**Do not:** lift a gate from a report or a workpaper into the guide without checking how it clears; show a warning with no way to put it off; write a title that names the system's concept ("parity", "source") instead of the owner's action.

**Do:** trace each step's clearing path in SQL first; write the detail as "do X on screen Y, then Z happens"; make audit-style controls notes, not gates; test that the guide never carries an unclearable key.

## Every callout closes its own loop

**Rule:** A step in a guide or a banner ships only when it is provable or acknowledgeable, and preferably both: the data clears it, or the owner can say "done" and that answer is saved with the books and reversible. The step's own words say what to do and on which screen. Before adding one, trace its clearing path in SQL and click the screen it points at.

**Why this matters:** On 2026-09-12 the owner reviewed their payroll, found it correct, and still faced "Verify 2026 payroll against the provider" with no way to say so. The flag behind it could never be set by anything in the app. The owner's words: "there's literally no way for me to dismiss the payroll callout or acknowledge that the work has been done properly... there can't be any UX gaps." Two other steps pointed at screens that could not do what the step asked.

**Do not:** detect "done" through an internal control the owner has no path to (parity flags, verified registers); offer a dismissal only on the top item; store an acknowledgement in the browser; write a title in the system's vocabulary.

**Do:** one acknowledgement model for the whole guide, saved server-side per step and year; an answer button and an action button on every row; a done list with Reopen; detection that matches what the owner can actually do (a register attached, a purpose assigned, a treatment mapped).

## One fact, one rule, every year

**Rule:** When a single setting is copied into per-period rows, the copy must be a function of the setting for every period, including the periods before a boundary. A sync that writes "from the start year on" and leaves the rest alone has silently declared the earlier periods undefined, and an optional start year turns "undefined" into "overwritten".

**Why this matters:** On 2026-09-12 the business profile's S-Corp election, saved with "In effect since: Not recorded", stamped the 2022 estimate as an S-Corp although the LLC filed as an LLC that year. The Tax years page then locked the field, so the owner could neither see why nor fix it, and the 2022 estimate lost its self-employment tax. The books had the same hole, surfaced as a "review your classification" gate pointing at a screen with no such control.

**Do not:** make a boundary field optional when the value differs from the default; sync only one side of the boundary; describe features that do not exist ("Earlier years keep their own settings").

**Do:** a pure `forYear(setting, year)` rule shared by every reader and writer; require the boundary whenever it matters; derive the display from the rule instead of storing an editable copy.

## A scripted click is not a click

**Rule:** Verify anything interactive with a real pointer click on the visible control, then read focus, scroll offsets and state. A `.click()` from script skips focus, label activation and scroll-into-view, which is exactly where layout bugs live.

**Why this matters:** On 2026-09-12 the owner reported the treatments dialog going blank when ticking "I reviewed". My scripted `input.click()` toggled the box without focusing it, so the dialog behaved and I blamed a stale tab. The owner reloaded and restarted and it still broke. A real click focused the screen-reader-only input, which was absolutely positioned against the dialog frame 2,116px down, and the browser scrolled the overflow-hidden frame to reveal it.

**Do not:** conclude "cannot reproduce" from a synthetic click; blame caches or stale tabs before reproducing the owner's exact gesture; treat console errors from an earlier build as the current cause.

**Do:** click the element the owner clicks, then inspect `document.activeElement`, every ancestor's `scrollTop` and the element's computed position; when a fix lands, repeat the same real click.
