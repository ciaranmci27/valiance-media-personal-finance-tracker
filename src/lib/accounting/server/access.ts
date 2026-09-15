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
    throw new Error("The books are not set up for this account.");
  return accounting;
}

export function accountingError(message: string): string {
  const known: Record<string, string> = {
    ACCT_CORRECTION_LINKED:
      "Use this transaction's payroll, transfer, register or reconciliation workflow to change it. No changes were saved.",
    ACCT_PATRIOT_CHANGED:
      "The books changed since the preview. Refresh the preview before importing. No payrolls from this request were saved.",
    ACCT_IMPORT_COMPARISON_SCOPE:
      "Choose two files from the same source, scope and import type, with dates covered by both files.",
    ACCT_IMPORT_COMPARISON_STAGING:
      "Finish staging both files before comparing them. Posting is not required.",
    ACCT_TAX_RANGE:
      "Choose a cutoff inside the tax year that is not in the future.",
    ACCT_TAX_CONCEPT: "Choose a treatment that fits this account type.",
    ACCT_ACCOUNT_NOT_FOUND: "That account no longer exists.",
    ACCT_TAX_MAPPING:
      "Choose a tax concept and deductible percentage appropriate for this income or expense account.",
    ACCT_PAYROLL_EVIDENCE:
      "Attach the verified Patriot register and confirm that its amounts and mappings agree.",
    ACCT_CATEGORY_REQUIRED:
      "Choose a category for every amount before marking the transaction reviewed.",
    ACCT_RESTORE_UNAVAILABLE:
      "This transaction is not available to restore. It may already have been restored or edited. Refresh the list.",
    ACCT_RESTORE_DATE: "Choose a restore date on or after the deletion date.",
    ACCT_RESTORE_WORKFLOW:
      "Restore this through its linked payroll, transfer, or asset/loan workflow. For an undone payroll import, upload the report again.",
    ACCT_IMPORT_UNDO_UNAVAILABLE:
      "Only an active payroll import can be undone. Refresh to see its current status.",
    ACCT_IMPORT_UNDO_LINKED:
      "Resolve the linked bank payments or reconciliation before undoing this import.",
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
      "This source requires an edit or period review before it can be applied.",
    ACCT_BANK_ACCOUNT_REQUIRED:
      "Choose an active bank or card account in the account settings.",
    ACCT_TRANSFER_ALREADY_LINKED:
      "A selected entry already belongs to a transfer group.",
    ACCT_TRANSFER_REVERSE_TOGETHER:
      "Delete the transfer from either leg in Transactions. Both legs are deleted together.",
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
      "This date belongs to a locked month. Choose a date in an open month.",
    ACCT_IMMUTABLE:
      "Reviewed or deleted transactions cannot be changed in place. Edit one to save a new version.",
    ACCT_ALREADY_REVERSED: "This transaction was already deleted.",
    ACCT_IDEMPOTENCY_CONFLICT:
      "This request changed after submission. Review it and try again.",
    ACCT_ACCOUNT_ARCHIVED: "An account on this entry is archived.",
    ACCT_RULE_INELIGIBLE:
      "One of the selected drafts no longer qualifies. Refresh the preview and review its exception.",
    ACCT_BANK_SOURCE_CHANGED:
      "The bank side of this transaction (date, account and amount) comes from the bank and cannot change. Edit the category, description or payee instead.",
    ACCT_REASON_REQUIRED: "Provide a reason for this change.",
    ACCT_FORBIDDEN: "Your account does not have access to the books.",
  };
  for (const [code, text] of Object.entries(known))
    if (message.includes(code)) return text;
  return "The operation could not be completed. Refresh the books and check the entry before retrying.";
}
