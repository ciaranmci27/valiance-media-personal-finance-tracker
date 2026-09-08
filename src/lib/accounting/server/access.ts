import "server-only";
import { createClient } from "@/lib/supabase/server";
import { ACCOUNTING_ENABLED } from "@/lib/env";
import { isDemoMode } from "@/lib/demo";
import { localAccountingTestClient } from "./local-test-client";

export async function accountingClient() {
  if (!ACCOUNTING_ENABLED)
    throw new Error("Accounting writes are unavailable.");
  const testClient = localAccountingTestClient();
  if (testClient) return testClient;
  if (isDemoMode()) throw new Error("Accounting writes are unavailable.");
  const client = await createClient();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser();
  if (authError || !user) throw new Error("Sign in to access accounting.");
  const accounting = client.schema("accounting");
  const { error } = await accounting.rpc("context", {
    view: "session",
    params: {},
  });
  if (error)
    throw new Error("Accounting is not configured for this signed-in owner.");
  return accounting;
}

export function accountingError(message: string): string {
  const known: Record<string, string> = {
    ACCT_IMPORT_COMPARISON_SCOPE:
      "Choose two files from the same source, scope and import type, with dates covered by both files.",
    ACCT_IMPORT_COMPARISON_STAGING:
      "Finish staging both files before comparing them. Posting is not required.",
    ACCT_TAX_MAPPING:
      "Choose a tax concept and deductible percentage appropriate for this income or expense account.",
    ACCT_PAYROLL_EVIDENCE:
      "Attach the verified Patriot register and confirm that its amounts and mappings agree.",
    ACCT_CATEGORY_REQUIRED:
      "Choose a category for every amount before marking the transaction reviewed.",
    ACCT_FEED_MAPPING:
      "Discover the current accounts, review ownership, and map each company account before enabling its feed.",
    ACCT_FEED_BUSY:
      "A bank sync is running. Wait for it to finish before changing its mapping.",
    ACCT_DUPLICATE_CONTROL:
      "Each month and account can appear only once in the source controls.",
    ACCT_LATER_PERIOD_LOCKED:
      "Reopen the affected month and its later closes before changing this financial history.",
    ACCT_IMPORT_INCOMPLETE:
      "Resolve all source groups before completing this batch.",
    ACCT_IMPORT_FINAL:
      "This batch or source group is already final. Refresh to see its recorded result.",
    ACCT_IMPORT_EXCEPTION:
      "This source requires a correction or period review before it can be applied.",
    ACCT_BANK_ACCOUNT_REQUIRED:
      "Choose an active bank or card account in the account settings.",
    ACCT_TRANSFER_ALREADY_LINKED:
      "A selected entry already belongs to a transfer group.",
    ACCT_TRANSFER_REVERSE_TOGETHER:
      "Reverse both legs together from Manage > Transfers to preserve the transfer history.",
    ACCT_ACCOUNT_KIND:
      "Bank and cash accounts must be assets. Credit cards must be liabilities.",
    ACCT_ACCOUNT_IN_USE:
      "An account with transactions cannot change its financial type or system purpose.",
    ACCT_CHART_EXISTS:
      "Accounts already exist. Map your history to the current chart instead of seeding another chart.",
    ACCT_DOCUMENT_UNAVAILABLE:
      "Upload the evidence file before linking or completing it.",
    ACCT_NOT_FOUND: "This record is unavailable. Refresh the books.",
    ACCT_POSTED_REQUIRED: "Choose a posted entry for this match.",
    ACCT_UNBALANCED:
      "Debits and credits must balance, with at least two lines, before posting.",
    ACCT_STALE_REVISION:
      "The books changed after this review. Refresh the report before continuing.",
    ACCT_STALE_VERSION:
      "This record changed. Refresh and review the latest version before saving.",
    ACCT_PERIOD_LOCKED:
      "This date belongs to a locked period. Choose an open correction date.",
    ACCT_IMMUTABLE:
      "Posted or discarded entries cannot be edited. Use a reversal to correct a posting.",
    ACCT_ALREADY_REVERSED: "This entry already has a reversal.",
    ACCT_IDEMPOTENCY_CONFLICT:
      "This request changed after submission. Review it and try again.",
    ACCT_ACCOUNT_ARCHIVED: "An account on this entry is archived.",
    ACCT_RULE_INELIGIBLE:
      "One of the selected drafts no longer qualifies. Refresh the preview and review its exception.",
    ACCT_BANK_SOURCE_CHANGED:
      "The draft's bank date or amount differs from its imported source. Restore the source movement before posting or resolve the source conflict explicitly.",
    ACCT_REASON_REQUIRED: "Provide a reason for this change.",
    ACCT_FORBIDDEN: "Accounting is restricted to its configured owner.",
  };
  for (const [code, text] of Object.entries(known))
    if (message.includes(code)) return text;
  return "The operation could not be completed. Refresh the books and check the entry before retrying.";
}
