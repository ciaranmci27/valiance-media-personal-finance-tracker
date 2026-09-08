import type { AccountingWorkspace } from "../contracts";
import "server-only";
import { accountingClient } from "./access";
import { readAccounting } from "./read";
export async function loadAccountingWorkspace(params: {
  from: string;
  to: string;
  entry_id?: string | null;
}) {
  const result = await readAccounting(await accountingClient(), "workspace", {
    p_from: params.from,
    p_to: params.to,
    p_entry_id: params.entry_id,
  });
  return result as {
    data: AccountingWorkspace | null;
    error: { message: string } | null;
  };
}
