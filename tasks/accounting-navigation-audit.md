# Accounting navigation audit, 2026-09-11

## Fixed

- Shared accounting reads now cancel their subscriber without aborting the fetch. This prevents navigation from rejecting requests also observed by extensions, while still rejecting the cancelled subscriber with AbortError. Callers handle it using their effect's signal. The response is drained and discarded after cancellation; it cannot update the abandoned screen. Genuine network, HTTP and JSON failures still reach active readers.
- Removed the never-settling cancellation promise so cancelled read chains can finish cleanup. The register cache uses the same transport. Existing cache isolation, invalidation and stale-response protection remain intact.
- Cancelled balance refreshes no longer show a misleading refresh-failed toast. Cancelled overview reads cannot clear the next view's results.
- Evidence is keyed by transaction ID, preventing a previous transaction's loaded evidence or unsaved note from carrying into another transaction.
- Payroll detail opens a loading dialog immediately and displays request failures inside it. Reopening a run clears the previous detail while it reloads.
- Account ledger reads clear old errors and data when their query changes, allowing a successful retry to display again.
- Contractor refresh failures are caught and displayed instead of escaping an async click handler.
- Overview's review queue includes posted entries marked unreviewed. Entry pickers use the independent review state. Book-balance captions refer to posted transactions.

## Validation

- Accounting lint and TypeScript checks passed.
- Full ordinary accounting runner: 46/47 suites passed. The existing `verify-accounting-drop.ts` suite expects `_accounting_drop_legacy.sql`, which is absent from the active migrations. No migration was created, changed or executed to satisfy that historical test.
- Updated cancellation regression passed with a real local HTTP server: before-headers cancellation, streamed body reads, pre-cancelled reads, production cache loader, a simulated detached extension observer, no stale delivery, settled cleanup, and genuine HTTP/network/JSON failures.
- Bundled browser: Overview, Transactions, Accounts, Reports, Records, Settings, every Records/Settings subsection, and all six financial/detailed report entry points. No captured console warnings/errors or unhandled rejections in this demo navigation pass.
- Actual evidence and payroll components against synthetic delayed HTTP responses: 40 rapid mount/unmount cycles with zero captured unhandled errors. Successful loading and an intentional payroll-detail failure were checked. The failure appeared in its dialog; desktop (1920x1080) and mobile (390x844) screenshots were inspected.
- Temporary observer, test page, endpoint and separate demo server were removed after verification.

## Limits

Browser navigation used demo data; the focused component test used synthetic responses. Live accounting writes, uploads, bank sync, exports and authenticated production integration flows were not exercised. Cancellation allows an already-started GET to finish in the background, which avoids transport AbortErrors at the cost of completing that request. This audit does not establish that every possible accounting workflow is bug-free.
