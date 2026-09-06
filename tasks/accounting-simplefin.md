# SimpleFIN adapter and operations

Status: implemented for synthetic acceptance. A live connection and original bank/card statements remain required to validate institution support, ownership, signs, dates, and available history. No live token has been claimed during this build.

## Provider contract

The adapter requests version 2 and pins the `2.0.0-draft-2026-03-19` shape. Version 2 identifies an account by provider connection ID plus account ID and supplies scoped `errlist` errors. Amounts remain decimal strings until exact conversion to cents. Request starts are inclusive; ends are exclusive Unix timestamps. Missing transactions are distinct from an empty list. Pending observations, including posted timestamp zero, cannot create drafts. Unknown or malformed error scopes fail conservatively. See the [SimpleFIN protocol](https://www.simplefin.org/protocol.html) and [version 2 announcement](https://github.com/simplefin/simplefin.github.com/discussions/33).

The Bridge guidance describes a 24-request daily limit, windows up to 90 days, and overlapping syncs. This adapter conservatively budgets 24 requests across an entire stored connection, even where the provider offers separate account quotas. Each run requests at most four accounts, uses a five-day overlap, and schedules the next daily run with a random offset. Institution history availability is separate from transport success. See the [Bridge developer guide](https://beta-bridge.simplefin.org/info/developers).

## Owner workflow

1. Configure the server and create a Bridge setup token. Connect from Accounting > Manage > Bank feeds. Claim attempts are durable before the one-time external request; an uncertain claim is never automatically replayed.
2. Discover balances and account metadata. Discovery does not retain personal transaction lists, even if a provider sends them unexpectedly.
3. Review each account's ownership. Company accounts require an existing USD bank/card book account, a history start, a posting timezone, and independently checked transaction and balance signs. Personal and ignored accounts do not enter the company sync plan.
4. Sync to retain original transaction observations and balance timestamps. The server worker cannot create or post journals. Prepare a review batch, resolve existing-entry matches or exceptions in Imports, then create and categorize bank drafts.
5. Reconnect to the same book accounts. Canonical identities and checkpoints survive credential changes. A new provider identity needs explicit review. No opening balance is created. Settings can be corrected before the first transaction window; used financial conventions require reviewed corrections rather than silent reinterpretation.

Identical repeated observations inherit the existing source-group review link. Changed financial fields retain the earlier evidence and enter exception review. A previously posted source movement becoming pending or nonfinancial is flagged without reversing the books automatically. Different providers can support the same existing economic posting through the normal bank match workflow.

## Server configuration

Provide these only in the admin server environment:

- `NEXT_PUBLIC_ACCOUNTING_ENABLED=true`, with accounting migrations and owner provisioning already complete.
- Existing Supabase URL and `SUPABASE_SERVICE_ROLE_KEY`.
- `SIMPLEFIN_ENCRYPTION_KEY`: a separate, randomly generated secret of at least 32 characters. Do not reuse payroll, SSN, or SMTP encryption keys.
- Optional `SIMPLEFIN_KEY_VERSION`, default `1`. Version 2 uses `SIMPLEFIN_ENCRYPTION_KEY_V2`, and so on. Keep older keys until their stored credentials have been replaced or migrated.
- For scheduled operation only, `ACCOUNTING_FEED_WORKER_ENABLED=true` and a separate random `ACCOUNTING_WORKER_SECRET` of at least 32 characters.

Connectors and jobs remain disabled in demo mode and in the marked local test database environment. The browser receives configuration readiness, never the keys, setup token, or access URL. Encryption uses the existing versioned AES-256-GCM helper with its own key namespace.

An external scheduler can POST to `/api/accounting/jobs/feeds` with `Authorization: Bearer <ACCOUNTING_WORKER_SECRET>`, for example hourly. Each invocation handles at most one due connection, with a 240-second handler budget. The owner must also enable each connection's daily schedule. No schedule is activated by a migration or deployment. Repeated invocations are serialized by a persisted two-minute renewable lease, with generation fencing and a durable request budget before network access. Expired runs preserve prior observations; an old worker cannot commit after disconnect/reconnect or lease replacement.

Only exact Bridge HTTPS hosts are allowed. DNS answers must be public and are pinned for the TLS request. Redirects are refused. Requests and responses have time/size limits; error messages redact URLs and authentication strings. Service-role table writes and broad accounting commands remain revoked. The worker has one restricted facade for feed records.

## Coverage and recovery

A checkpoint means an accepted response was processed, not that the bank supplied a complete accounting history. Body-level errors or missing mapped accounts do not advance the affected checkpoint. Other successfully received accounts keep their progress. Old empty ranges and explicitly skipped unavailable ranges remain recorded gaps. Current statement reconciliation or verified historical controls can demonstrate coverage of a retained gap.

Close checks include unprepared posted feed movements. Ordinary bank batches require their movements to be posted or matched and supported by statement reconciliation. Annual historical-report verification remains required for journal-history imports; it is not repeated for every daily bank observation batch.

Disconnect stops scheduling, fences active workers, removes the encrypted access credential, and retains accounting/source evidence. Revoke the token in Bridge as well. A revoked provider token or missing decryption key requires recovery or reconnect, not an invented zero balance.

Backup v9 includes feed mappings, observations, requests, runs, claims, review links, and gaps. It deliberately excludes the credential table. Keep encryption recovery material separately. Restored environments must keep workers off until owner sign-in, source evidence, and credential recovery/reconnection have been checked.

## Validation

`npm run test:accounting:feeds -w admin` tests protocol/security parsing, leases, failure boundaries, exact repeated observations, changed source identities, reconnect continuity, request limits, pending exclusion, owner/worker isolation, encryption, and close coverage. The marked local fixture includes synthetic checking, card, and personal identities. Browser acceptance uses the Codex browser, without Playwright or any live banking request.
