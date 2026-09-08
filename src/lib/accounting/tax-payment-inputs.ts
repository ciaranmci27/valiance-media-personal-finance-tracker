import {z} from "zod";
import {dateSchema} from "./contracts";
const cents = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);
const filing = z.enum(["single", "mfj", "mfs", "hoh"]);
export const paymentReviewSchema = z
  .object({
    payment_id: z.string().min(1).max(160),
    amount_cents: cents,
    jurisdiction: z.enum(["federal", "state"]),
    kind: z.enum(["estimated", "withholding_actual", "withholding_forecast"]),
    date: dateSchema,
    document_id: z.uuid(),
  })
  .strict();
export const taxPaymentPlanBodySchema = z
  .object({
    federal: z
      .object({
        prior_tax_cents: cents,
        prior_agi_cents: signed,
        filing_status: filing,
        document_id: z.uuid(),
        standard_rules_confirmed: z.literal(true),
      })
      .strict()
      .nullable(),
    state_code: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    manual: z
      .array(
        z
          .object({
            jurisdiction: z.enum(["federal", "state"]),
            date: dateSchema,
            amount_cents: cents,
            document_id: z.uuid(),
            reason: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(24),
    reviews: z.array(paymentReviewSchema).max(1000),
    taxpayer_confirmed: z.literal(true),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      new Set(body.reviews.map((r) => r.payment_id)).size !==
      body.reviews.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Review each payment only once.",
      });
    if (body.federal && body.manual.some((r) => r.jurisdiction === "federal"))
      ctx.addIssue({
        code: "custom",
        message:
          "Choose either a prior-year federal target or manual federal installments.",
      });
    if (body.manual.some((r) => r.jurisdiction === "state") && !body.state_code)
      ctx.addIssue({
        code: "custom",
        message: "Choose the state for manual targets.",
      });
  });
export type PaymentReview = z.infer<typeof paymentReviewSchema>;
export type TaxPaymentPlanBody = z.infer<typeof taxPaymentPlanBodySchema>;
