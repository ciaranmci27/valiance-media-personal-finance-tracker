import { z } from "zod";
import { readCents } from "./money";
export const retainedReviewSchema = z
  .object({
    document_id: z.uuid(),
    controls: z
      .array(
        z
          .object({
            account_id: z.uuid(),
            amount_cents: z.string().refine((s) => {
              try {
                readCents(s);
                return true;
              } catch {
                return false;
              }
            }, "Use exact integer cents."),
          })
          .strict(),
      )
      .min(2)
      .max(100),
  })
  .strict();
export const retainedCommandSchema = z
  .object({
    type: z.literal("retained.post"),
    id: z.uuid(),
    expected_version: z.number().int().positive(),
    document_id: z.uuid(),
    controls: retainedReviewSchema.shape.controls,
    reason: z.string().trim().min(1).max(3000),
  })
  .strict();
