import { z } from "zod";
import { dateSchema } from "./contracts";
import { readCents } from "./money";
const base = {
  id: z.uuid(),
  expected_revision: z.string().regex(/^\d{1,19}$/),
};
const terms = {
  from_account_id: z.uuid(),
  to_account_id: z.uuid(),
  amount_cents: z.string().refine((v) => {
    try {
      return readCents(v) > BigInt(0);
    } catch {
      return false;
    }
  }, "Enter a positive amount."),
  memo: z.string().trim().min(1).max(1000),
};
export const transferCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      ...terms,
      type: z.literal("transfer.create"),
      outgoing_date: dateSchema,
      incoming_date: dateSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      ...terms,
      type: z.literal("transfer.link"),
      outgoing_entry_id: z.uuid(),
      incoming_entry_id: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("transfer.reverse"),
      outgoing_date: dateSchema,
      incoming_date: dateSchema,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export interface TransferGroup {
  id: string;
  version: number;
  status: "posted" | "corrected";
  outgoing_entry_id: string;
  incoming_entry_id: string;
  outgoing_date: string;
  incoming_date: string;
  amount_cents: string;
  memo: string;
  from_name: string;
  to_name: string;
  in_transit: boolean;
}
export interface TransfersView {
  revision: string;
  total: number;
  groups: TransferGroup[];
}
