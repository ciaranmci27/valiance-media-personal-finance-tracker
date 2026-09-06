import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";
import {
  feedConfiguration,
  requireLiveFeed,
  encryptFeed,
  decryptFeed,
  feedServer,
} from "@/lib/accounting/server/feed-service";
import {
  claimSimpleFin,
  setupClaimUrl,
  SimpleFinError,
} from "@/lib/accounting/server/simplefin-transport";
import { syncSimpleFin } from "@/lib/accounting/server/simplefin-sync";
import { feedCommandSchema, type FeedData } from "@/lib/accounting/feeds";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("connect"),
      key: z.uuid(),
      command: feedCommandSchema.options[0],
      token: z.string().min(16).max(12000),
    })
    .strict(),
  z.object({ action: z.enum(["sync", "discover"]), id: z.uuid() }).strict(),
]);
export async function GET() {
  try {
    await accountingClient();
    return NextResponse.json(feedConfiguration(), {
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
  let body;
  try {
    body = requestSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          await boundedBytes(req, 20000),
        ),
      ),
    );
  } catch {
    return NextResponse.json(
      {
        error: "Choose a valid connection operation and complete setup token.",
      },
      { status: 400 },
    );
  }
  try {
    requireLiveFeed();
    if (body.action === "connect") {
      setupClaimUrl(body.token);
      const saved = await client.rpc("acct_operate", {
        p_key: body.key,
        p_command: body.command,
      });
      if (saved.error)
        return NextResponse.json(
          { error: accountingError(saved.error.message) },
          { status: 409 },
        );
      // This durable transition can succeed once. An uncertain HTTP response must
      // never cause the one-time provider claim to be sent again.
      await feedServer({ type: "claim.send", id: body.command.claim_id });
      try {
        const access = await claimSimpleFin(body.token),
          ciphertext = encryptFeed(access);
        await feedServer({
          type: "claim.complete",
          id: body.command.claim_id,
          ciphertext,
        });
      } catch (error) {
        const message =
          error instanceof SimpleFinError
            ? error.message
            : "The setup attempt stopped before completion. Disable the token in SimpleFIN and reconnect with a new token.";
        try {
          await feedServer({
            type: "claim.fail",
            id: body.command.claim_id,
            error: message,
          });
        } catch {
          /* A completed or replaced claim must retain its result. */
        }
        throw new SimpleFinError("claim_failed", message);
      }
      return NextResponse.json(
        {
          id: body.command.id,
          message:
            "Connected. Discover accounts to review their ownership and mapping.",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const context = await client.rpc("acct_feed_view");
    if (context.error)
      throw new SimpleFinError(
        "context_failed",
        "Refresh the connection before syncing.",
      );
    const result = await syncSimpleFin({
      connectionId: body.id,
      actorId: (context.data as FeedData).owner_id,
      discover: body.action === "discover",
      rpc: feedServer,
      decrypt: decryptFeed,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof SimpleFinError
            ? error.message
            : "The connection operation could not finish. Saved progress is retained.",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
}
