# Accounting redesign plan (navigation, layout, overview)

Date: 2026-09-10. Status: phase A built (navigation, Overview, logos, dialogs); phases B to D open.

## Why

The accounting module works (Wave history imported, reports match) but its surface was built for an auditor: 84 reachable screens and dialogs, 13 "More" sections, 14 reports, ledger vocabulary, hairlined tables, no charts, no big numbers. The owner's daily job is "categorize the new bank drafts", and twice a year "pull P&L and Balance Sheet". The target is a Robinhood-simple, Wave-clean surface that matches the admin dashboard's design language (StatCard tiles, Recharts, glass cards, DM Sans numbers) and uses bank logos wherever an account appears.

## Navigation (built 2026-09-10, revised: sidebar accordion instead of tabs)

The sidebar "Accounting" item expands into a rail of sub-links, like the Agent group in the project management app: Overview, Transactions, Accounts, Reports, Records, Settings, Export books. There is no in-page tab bar and no gear. The screens themselves:

| Tab | Holds | Today's equivalent |
|---|---|---|
| Overview (default) | cash + income + expenses + profit tiles, cash flow chart, needs-review queue, account cards with logos, recent activity, month status | none (new) |
| Transactions | the register, Needs review default when drafts exist | Transactions |
| Accounts | bank and card cards with logos, chart of accounts below | Accounts |
| Reports | Statements (P&L, Balance sheet) first; Records group (Payroll, Assets, Loans, Contractors, Tax workpapers, Year-end package); "More reports" for trial balance, general ledger, owner activity, cash movements | Reports + the Records half of More |

Setup screens live under the Settings sub-link: Bank feeds, Rules and aliases, Payees, Imports, Wave migration, Book settings. Records holds Transfers, Receipts, Payroll, Assets, Loans, Contractors and Tax. Same components, grouped rail, reached as `?view=settings` and `?view=records`.

Month end stops being a tab. It becomes a card on Overview ("September: nothing to review, balances match") with a Lock action; the existing close screen stays reachable from that card as `?view=close`.

URL scheme stays `?view=...`. `overview` is the default; `manage` links redirect to `settings`; every existing deep link keeps working.

## Overview page (new `accounting-overview.tsx`)

1. Four StatCards, the same component and scale as the dashboard: Cash in bank, Income (this month, with YTD subtitle), Expenses, Net profit (with margin). Source: the workspace totals already loaded by `page.tsx`, plus the P&L `monthly` series from the `report` read for month deltas.
2. Cash flow chart: Recharts area or bar per month for the last 12 months (income, expenses, net), styled like `income-trend-chart.tsx`. Replaces the hand-drawn SVG in Reports.
3. Needs review card: count badge, the first five drafts with logo, description, amount and a category picker; "Review all" goes to Transactions. Empty state reads "All caught up" with the last sync time.
4. Accounts strip: one card per bank or card account with institution logo, name, last four, book balance, bank balance and last-synced time; a final "Connect a bank" card starts the SimpleFIN flow. Phone treatment: horizontal snap carousel (per the 2026-09-03 lesson).
5. Recent activity: the last eight posted transactions with logo and category; "See all" goes to Transactions.
6. Sync line under the header: "Synced 12 minutes ago", or the blocking reason with a "Review accounts" button when mappings are unreviewed.

## Bank logos

New `InstitutionLogo` component in `src/components/ui/institution-logo.tsx`. Input is the institution string already stored on `accounting.bank_accounts.institution` and on feed discovery rows. It resolves to a local SVG in `public/logos/banks/` (American Express, Chase, Bank of America, Wells Fargo, Capital One, Mercury, Relay, Brex, Stripe, PayPal, Novo, Bluevine as the starter set) and falls back to a rounded monogram tile with the account's colour. Used on Overview, Accounts, the Transactions account column and picker, Bank feeds, and the entry detail. Local assets first; a domain-based image service can be added later if the set proves too small.

## Design system conformance (done once, at the token level)

- Numbers in DM Sans per `globals.css`; remove the 49 `font-mono` money renders.
- Dark theme: give cards a visible edge (shadow or 1px hairline at 8 to 10 percent), raise table header and hover tints from 2 to 3 percent up to 5 to 6 percent, use the stronger teal for links and active states.
- Replace stacked hairline rows with whitespace and one card per group.
- Replace every literal "Loading..." with `ui/skeleton.tsx` rows shaped like the content.
- Vocabulary pass on labels that reach the user: no journal, posting, register, workpapers, evidence, revision, coverage, parity, book mode.

## Phases

- A. Navigation and Overview: shell tabs, Overview page, Settings regroup, Records under Reports, logos, token fixes. Files: `accounting-shell.tsx`, new `accounting-overview.tsx`, new `institution-logo.tsx` and assets, `accounting-more.tsx` (split), `accounting-reports.tsx` (Records group), `accounting-bank-panel.tsx`, `accounting-transactions.tsx` (picker logos), `globals.css`.
- B. Transactions: Needs review default, three columns, search plus chips instead of the eight-field drawer, row click opens detail with inline category (the "Correct transaction" form moves behind an Edit action).
- C. Accounts and Reports polish, Month end card.
- D. Daily pull: one-click ownership review for discovered accounts, and a scheduler for the feed worker (Vercel cron with a GET handler if admin is deployed there, or a VPS cron calling the worker with its secret). Sync on open already runs the due connections since 2026-09-10.

## Decisions needed from the owner

1. Where does admin run in production (Vercel, the VPS, or only this PC)? This decides the scheduler in phase D. Until then, opening the books is what pulls new transactions.
2. Logos: local SVG set (proposed) or an external logo service?
3. OK to move Payroll, Assets, Loans, Contractors and Tax under Reports as Records, and the setup screens behind a gear?
4. Month end as an Overview card with a Lock action (proposed) or keep it as a tab?
