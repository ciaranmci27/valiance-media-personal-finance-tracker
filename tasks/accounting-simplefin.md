# SimpleFIN adapter and operations

Status: the Phase 1 schema and adapter are tested with synthetic fixtures. The server route port is step 6, and automatic draft creation in those routes is Phase 2. No live token was claimed and no real transactions were imported.

## Provider contract

The transport defaults to version 1. The parser accepts the v1.0.7 `errors`/`accounts` envelope and the v2 draft `errlist`/`connections` envelope. A v1 institution identity is derived deterministically from its organization metadata; account IDs are scoped to that institution. Malformed mixed envelopes fail conservatively. Amounts remain decimal strings until exact conversion to integer cents.

Both specifications define `posted` as Unix seconds representing an instant. Convert that instant once through `public.business_profile.books_timezone`. A timestamp near UTC midnight can legitimately have the previous local calendar date; retaining its UTC date would change its meaning. Tests cover midday, midnight, DST and invalid IANA zones. Pending timestamp zero never creates a financial date or journal entry. Source references: [v1 protocol](https://www.simplefin.org/protocol-v1.html), [v2 draft protocol](https://www.simplefin.org/protocol.html).

## Target database behavior

- `bank_connections` stores encrypted credentials and a fenced five-minute lease. `sync_server` is service-role-only and never impersonates the owner. Browser reads exclude the ciphertext and private checkpoint details.
- Discovery retains account metadata, not personal transaction lists. Only explicitly mapped company USD accounts retain observations. Ledger account and movement sign freeze once observations exist. The legacy balance sign is stored in the private checkpoint and freezes at the same boundary.
- Immutable posted observations carry original payload, source ID, description, hash and date. A changed existing provider record is retained as a conflict without overwriting evidence or advancing that account checkpoint. Missing/incomplete mapped accounts cannot mark a run wholly successful.
- Pending and zero-valued nonfinancial movements create no journal. Counts remain in the run audit. A previously posted record becoming pending/nonfinancial is a conflict, not an automatic reversal.
- Matching runs before draft creation. One unambiguous existing financial line is reused. Independent sources can corroborate an already fully allocated line with a zero allocation; the financial amount is never allocated twice. Ambiguous matches stay for review.
- The worker supports creating a draft from a posted observation, preserving the source description. Enabled rules and remembered treatment can fill its category, payee and memo. Tied rules, alias conflicts and previously categorized drafts are not silently changed. Auto-post requires an explicit rule setting and admin as the primary books system.
- `feed.prepare` remains a compatibility no-op. The HTTP worker enables the draft path in Phase 2. Closed-period observations remain unmatched on their actual date rather than being shifted.
- `feed.skip` requires a reason and records the checkpoint change in audit. It does not manufacture reconciliation or historical coverage. Disconnect stops scheduling and fences workers while retaining the encrypted credential and evidence; revoke a token separately in Bridge when appropriate.

## Security and deployment

Transport retains HTTPS host allowlisting, public-address DNS checks, pinned addresses, no redirects, time/size limits and redacted errors. AES-GCM uses the existing versioned encryption helper with `SIMPLEFIN_ENCRYPTION_KEY`, independently from other app secrets. Worker bearer authentication remains on the existing route. Full environment and scheduler instructions will be finalized in Phase 2 after the route port; no scheduler is deployed during this build.

## Validation

`verify-accounting-simplefin.ts` exercises parsing, exact amounts, v1/v2 identity, timestamps, transport and encryption. `verify-accounting-banking.ts` exercises synthetic leases, repeat/conflicting observations, draft review, matching, transfer reversal and permissions against PGlite. The old feed database suite still requires its step 6 server-contract port; it is not evidence for the new schema until ported.
