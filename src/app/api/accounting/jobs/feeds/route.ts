import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  feedConfiguration,
  feedServer,
  decryptFeed,
} from "@/lib/accounting/server/feed-service";
import { secureProviderTransport } from "@/lib/accounting/server/simplefin-transport";
import { runDueFeeds } from "@feeds/sync.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
/**
 * One worker tick: every due connection in turn, inside the route's time
 * budget. Production runs the same logic from the sync-feeds edge function on
 * Supabase cron; this route stays for a host that can call it directly.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ACCOUNTING_WORKER_SECRET,
    received = req.headers.get("authorization") ?? "";
  const expected = secret ? `Bearer ${secret}` : "";
  if (
    !expected ||
    Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  )
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!feedConfiguration().workerEnabled)
    return NextResponse.json(
      { error: "The accounting feed worker is disabled." },
      { status: 503 },
    );
  try {
    const result = await runDueFeeds({
      rpc: feedServer,
      decrypt: decryptFeed,
      transport: secureProviderTransport,
      source: "next",
      budgetSeconds: 150,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "The feed run failed. Review the retained connection diagnostics.",
      },
      { status: 503 },
    );
  }
}
