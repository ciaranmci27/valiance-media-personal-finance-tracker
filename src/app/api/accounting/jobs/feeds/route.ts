import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  feedConfiguration,
  feedServer,
  decryptFeed,
} from "@/lib/accounting/server/feed-service";
import { syncSimpleFin } from "@/lib/accounting/server/simplefin-sync";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
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
    const due = (await feedServer({ type: "due" })) as string[];
    if (!due.length)
      return NextResponse.json(
        { processed: 0 },
        { headers: { "Cache-Control": "no-store" } },
      );
    const result = await syncSimpleFin({
      connectionId: due[0],
      actorId: null,
      rpc: feedServer,
      decrypt: decryptFeed,
    });
    return NextResponse.json(
      { processed: 1, ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
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
