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
  const { data: allowed, error } = await client.rpc("acct_is_owner");
  if (error || allowed !== true)
    throw new Error("Accounting is not configured for this signed-in owner.");
  return client;
}

export function accountingError(message: string): string {
  const known: Record<string, string> = {
    ACCT_FEED_MAPPING_IMMUTABLE:
      "This bank identity already has reviewed history settings. Reuse those settings when reconnecting; correct existing financial data through a reviewed correction.",
    ACCT_FEED_MAPPING_DUPLICATE:
      "This book account already has an active bank identity. Disconnect the prior connection before mapping its replacement.",
    ACCT_FEED_MAPPING:
      "Discover the current accounts, review ownership, and map each company account before enabling its feed.",
    ACCT_FEED_WINDOW:
      "Choose a valid history range. A skipped range stays visible as a coverage gap.",
    ACCT_FEED_BUSY:
      "A bank sync is running. Wait for it to finish before changing its mapping.",
    ACCT_HISTORY_YEAR_RANGE:
      "Compare one calendar-year scope at a time. Partial-year coverage is shown separately.",
    ACCT_HISTORY_DIFFERENCE:
      "Resolve the source-report differences, incomplete imports, drafts and unclassified amounts before accepting this history.",
    ACCT_HISTORY_INVALIDATED:
      "A later posting changed this verified scope. Compare it with the source reports again before locking.",
    ACCT_DUPLICATE_CONTROL:
      "Each month and account can appear only once in the source controls.",
    ACCT_CLOSING_NORMALIZATION:
      "This group does not exactly offset the year's nominal balances. Retain it as an unresolved exception or correct the supported transformation.",
    ACCT_HISTORY_BASIS:
      "Confirm that these source reports use the supported cash basis.",
    ACCT_ACCOUNT_LIFECYCLE:
      "The account dates must include every posted transaction and must not leave future drafts after closure.",
    ACCT_ACCOUNT_CLOSE_PROOF:
      "Close an account only after its book balance is zero and its final zero-balance statement is completed.",
    ACCT_YEAR_CLOSE_REQUIRED:
      "Close every required month before recording the filing or completing this restatement.",
    ACCT_YEAR_CLASSIFICATION_REQUIRED:
      "Confirm the entity classification for this year before closing.",
    ACCT_RESTATEMENT_REQUIRED:
      "This change affects a filed year. Open a documented restatement case first.",
    ACCT_RESTATEMENT_OPEN:
      "Complete the open restatement case before starting another.",
    ACCT_FILED_YEAR_REQUIRED:
      "Use ordinary reopen when no affected year has been filed.",
    ACCT_FILED_YEAR:
      "This filing or classification cannot change in its current state. Review the year history.",
    ACCT_LATER_PERIOD_LOCKED:
      "Reopen the affected month and its later closes before changing this financial history.",
    ACCT_CLOSE_INCOMPLETE:
      "Resolve the remaining close checks before locking this month.",
    ACCT_PERIOD_ALREADY_CLOSED:
      "This month is already closed. Refresh to view its snapshot.",
    ACCT_RECONCILIATION_INCOMPLETE:
      "The statement items, opening balance, and books must all agree before completion.",
    ACCT_STATEMENT_OVERLAP:
      "This account already has an active statement in that date range.",
    ACCT_STATEMENT_PREDECESSOR:
      "Continue from the previous completed statement, with matching dates and opening balance.",
    ACCT_RECONCILIATION_FINAL:
      "This statement is final. Reopen it or start a replacement to change its matches.",
    ACCT_ALLOCATION_EXCEEDED:
      "This match exceeds the remaining amount on an item or transaction.",
    ACCT_OPENING_DIFFERENCE:
      "The reviewed cleared opening does not equal the statement opening. Check the outstanding items.",
    ACCT_OPENING_SCOPE:
      "Opening exceptions must be prior transactions on this account. Review and confirm the opening first.",
    ACCT_STATEMENT_SCOPE:
      "Statement items must fit its declared dates and item count.",
    ACCT_STATEMENT_SOURCE_FILE:
      "Use the original CSV that produced this preview. Its uploaded file hash must agree.",
    ACCT_STATEMENT_SOURCE_CHANGED:
      "A source identity has changed since its earlier import. Review the original item before changing this statement.",
    ACCT_STATEMENT_ITEM_REMOVED:
      "A previously imported item was removed. Select explicit restoration to add it back, or revise this file's scope.",
    ACCT_UNMATCH_FIRST: "Remove this item's matches before deleting it.",
    ACCT_CLEARING_LINES:
      "Choose opposite sides of the same clearing account from posted transactions.",
    ACCT_IMPORT_CHECKPOINT:
      "This batch progressed in another request. Refresh and resume from the saved checkpoint.",
    ACCT_IMPORT_INCOMPLETE:
      "Resolve all source groups before completing this batch.",
    ACCT_IMPORT_FINAL:
      "This batch or source group is already final. Refresh to see its recorded result.",
    ACCT_IMPORT_EXCEPTION:
      "This source requires a correction or period review before it can be applied.",
    ACCT_IMPORT_NOT_READY:
      "Only reviewed new groups with a confirmed accounting basis can be applied.",
    ACCT_MATCH_ALREADY_USED:
      "This bank line is already matched to another movement from this source.",
    ACCT_BANK_SOURCE_CONFLICT:
      "This source identity has conflicting financial fields. Review the changed provider record before matching it.",
    ACCT_BANK_PARTIAL_REVIEW:
      "This movement is already partly matched. Finish or release its bank matches before posting or excluding its draft.",
    ACCT_REDUNDANT_DRAFT_APPROVAL:
      "Review and approve discarding the redundant imported drafts when completing this match.",
    ACCT_REDUNDANT_DRAFT_CHANGED:
      "A draft has changed or includes other bank movements. Review its latest details before resolving it.",
    ACCT_MATCH_AMOUNT:
      "The proposed match does not agree with the recorded account, date, or amount.",
    ACCT_BANK_ACCOUNT_REQUIRED:
      "Choose an active bank or card account in the account settings.",
    ACCT_TRANSFER_INVALID:
      "Choose matching bank or card movements. Separate dates need equal, opposite lines through Transfers in Transit.",
    ACCT_TRANSFER_ALREADY_LINKED:
      "A selected entry already belongs to a transfer group.",
    ACCT_TRANSIT_ACCOUNT_REQUIRED:
      "Assign the Transfers in Transit system account before recording two posting dates.",
    ACCT_TRANSFER_CLEARING_REQUIRED:
      "The transit amounts must match completely before linking this transfer.",
    ACCT_TRANSFER_REVERSE_TOGETHER:
      "Reverse both legs together from Manage > Transfers to preserve the transfer history.",
    ACCT_UNCATEGORIZED_ACCOUNT_REQUIRED:
      "Assign Uncategorized Income and Uncategorized Expense system accounts before importing bank drafts.",
    ACCT_ACCOUNT_KIND:
      "Bank and cash accounts must be assets. Credit cards must be liabilities.",
    ACCT_ACCOUNT_IN_USE:
      "An account with transactions cannot change its financial type or system purpose.",
    ACCT_ACCOUNT_PARENT_DEPTH: "Use one parent level in the chart of accounts.",
    ACCT_ACCOUNT_PARENT:
      "Parent and child accounts must have the same financial type.",
    ACCT_ACCOUNT_CYCLE: "An account cannot be its own ancestor.",
    ACCT_CHART_EXISTS:
      "Accounts already exist. Map your history to the current chart instead of seeding another chart.",
    ACCT_DOCUMENT_UNAVAILABLE:
      "Upload the evidence file before linking or completing it.",
    ACCT_DOCUMENT_LINKED:
      "Linked evidence is retained with the books and cannot be archived from this action.",
    ACCT_DOCUMENT_STATE:
      "This document changed. Refresh and review its upload status.",
    ACCT_INVALID_DOCUMENT: "Use a supported evidence file up to 20 MB.",
    ACCT_INVALID_DIMENSION:
      "Choose an active project or business line of the correct type.",
    ACCT_NOT_FOUND: "This record is unavailable. Refresh the books.",
    ACCT_POSTED_REQUIRED: "Choose a posted entry for this match.",
    ACCT_UNBALANCED:
      "Debits and credits must balance, with at least two lines, before posting.",
    ACCT_STALE_VERSION:
      "This record changed. Refresh and review the latest version before saving.",
    ACCT_PERIOD_LOCKED:
      "This date belongs to a locked period. Choose an open correction date.",
    ACCT_IMMUTABLE:
      "Posted or discarded entries cannot be edited. Use a reversal to correct a posting.",
    ACCT_ALREADY_REVERSED: "This entry already has a reversal.",
    ACCT_RETAINED_REVIEW_REQUIRED:
      "Opening Retained Earnings requires supporting evidence and a review of each source balance before posting.",
    ACCT_RETAINED_CONTROL_DIFFERENCE:
      "The source controls do not agree with the journal's account balances. Review each amount before posting.",
    ACCT_NOMINAL_CLOSING_FORBIDDEN:
      "Opening balances cannot close income or expense accounts into retained earnings. Review historical closing normalization instead.",
    ACCT_INVALID_CONTROL:
      "Provide one exact source balance for every account in this entry.",
    ACCT_RETAINED_CORRECTION:
      "Retained-earnings corrections must be linked to the original posted entry and its reversal.",
    ACCT_RETAINED_NOT_USED:
      "This entry does not use Opening Retained Earnings. Use ordinary posting.",
    ACCT_OPENING_HISTORY_EXISTS:
      "An opening balance must precede the existing posted history. Use a reviewed correction for changes to established books.",
    ACCT_IDEMPOTENCY_CONFLICT:
      "This request changed after submission. Review it and try again.",
    ACCT_ACCOUNT_ARCHIVED: "An account on this entry is archived.",
    ACCT_RULE_CATEGORY:
      "Choose an active income or expense category other than Uncategorized.",
    ACCT_RULE_INELIGIBLE:
      "One of the selected drafts no longer qualifies. Refresh the preview and review its exception.",
    ACCT_INVALID_PAYEE: "Choose an active payee.",
    ACCT_BANK_SOURCE_CHANGED:
      "The draft's bank date or amount differs from its imported source. Restore the source movement before posting or resolve the source conflict explicitly.",
    ACCT_REASON_REQUIRED: "Provide a reason for this change.",
    ACCT_FORBIDDEN: "Accounting is restricted to its configured owner.",
    ACCT_INVALID_RANGE: "Choose a valid report date range.",
  };
  for (const [code, text] of Object.entries(known))
    if (message.includes(code)) return text;
  return "The operation could not be completed. Refresh the books and check the entry before retrying.";
}
