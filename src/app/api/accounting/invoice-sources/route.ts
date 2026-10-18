import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";
import {
  invoiceSourceConfiguration,
  encryptSourceKey,
  decryptSourceKey,
  invoiceServer,
} from "@/lib/accounting/server/invoice-source-service";
import { secureSourceTransport } from "@/lib/accounting/server/invoice-transport";
import { InvoiceSourceError, sourceBaseUrl } from "@invoices/contract.ts";
import { runInvoiceSources } from "@invoices/sync.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const uuid = z.guid();
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save"),
      key: uuid,
      source: z
        .object({
          id: uuid,
          expected_version: z.number().int().min(0),
          name: z.string().trim().min(1).max(120).optional(),
          base_url: z.string().max(500).optional(),
          api_key: z.string().trim().min(8).max(4000).optional(),
          // Partial: a line type the source never sends (often sales tax) may stay unmapped.
          account_map: z
            .partialRecord(
              z.enum(["hourly", "fixed", "recurring", "reimbursement", "tax"]),
              uuid,
            )
            .optional(),
          party_map: z.record(z.string().min(1).max(200), uuid).optional(),
          auto_link: z.boolean().optional(),
          status: z.enum(["active", "paused", "disconnected"]).optional(),
        })
        .strict(),
    })
    .strict(),
  // Sync now pulls and pushes one source; push only tells the sources about links the owner just made or ended.
  z.object({ action: z.literal("sync"), id: uuid }).strict(),
  z.object({ action: z.literal("push"), id: uuid.optional() }).strict(),
]);

const run = (options: { only?: string; pushOnly?: boolean }) =>
  runInvoiceSources({
    rpc: invoiceServer,
    decrypt: decryptSourceKey,
    transport: secureSourceTransport,
    source: "next",
    budgetSeconds: 90,
    force: true,
    ...options,
  });

export async function GET() {
  try {
    await accountingClient();
    return NextResponse.json(invoiceSourceConfiguration(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req))
    return NextResponse.json(
      { error: "Invalid request origin." },
      { status: 403 },
    );
  let client;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          await boundedBytes(req, 40000),
        ),
      ),
    );
  } catch {
    return NextResponse.json(
      { error: "Choose a valid invoice source operation." },
      { status: 400 },
    );
  }
  try {
    if (body.action === "save") {
      const { api_key, base_url, ...rest } = body.source;
      // The key is encrypted here and never stored or returned in the clear.
      const sealed = api_key ? encryptSourceKey(api_key) : null;
      if (base_url !== undefined) sourceBaseUrl(base_url);
      const saved = await client.rpc("operate", {
        command: {
          key: body.key,
          command: {
            type: "invoice_source.save",
            ...rest,
            ...(base_url !== undefined ? { base_url } : {}),
            ...(sealed
              ? {
                  api_key_encrypted: sealed.ciphertext,
                  key_version: sealed.version,
                }
              : {}),
          },
        },
      });
      if (saved.error)
        return NextResponse.json(
          { error: accountingError(saved.error.message) },
          { status: 409 },
        );
      // A first pull right away, so the owner sees the source's invoices; a failure here is shown on the source, not as a failed save.
      const sync =
        (body.source.status ?? "active") === "active"
          ? await run({ only: body.source.id }).catch(() => null)
          : null;
      return NextResponse.json(
        { saved: saved.data, sync },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!invoiceSourceConfiguration().ready)
      throw new InvoiceSourceError(
        "not_configured",
        "Invoice sources are not configured on this server.",
      );
    const result =
      body.action === "sync"
        ? await run({ only: body.id })
        : await run({ only: body.id, pushOnly: true });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof InvoiceSourceError
        ? error.message
        : "The invoice source request did not complete.";
    return NextResponse.json(
      { error: message },
      {
        status:
          error instanceof InvoiceSourceError && error.code === "invalid_url"
            ? 400
            : 503,
      },
    );
  }
}
