import type { AccountingWorkspace } from "../contracts";
import "server-only";
import { DEFAULT_BOOK_MODE } from "../reports";
import { accountingReader, isAccountingForbidden } from "./access";
import { readAccounting } from "./read";

/**
 * The books page's first read. The workspace RPC runs the owner check itself,
 * so a session without the books throws here exactly as the separate session
 * probe used to, and the page shows its setup message.
 */
export async function loadAccountingWorkspace(params: {
  from: string;
  to: string;
  entry_id?: string | null;
}) {
  const result = await readAccounting(await accountingReader(), "workspace", {
    p_from: params.from,
    p_to: params.to,
    p_mode: DEFAULT_BOOK_MODE,
    p_entry_id: params.entry_id,
  });
  if (result.error && isAccountingForbidden(result.error))
    throw new Error("The books are not set up for this account.");
  return result as {
    data: AccountingWorkspace | null;
    error: { message: string } | null;
  };
}
