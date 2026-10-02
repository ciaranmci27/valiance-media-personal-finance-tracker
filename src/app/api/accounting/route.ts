import { readAccounting } from "@/lib/accounting/server/read";
import { answerAccountingRead } from "@/lib/accounting/server/http-read";
import { NextRequest, NextResponse } from "next/server";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { extendedRequestSchema } from "@/lib/accounting/workflows";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reads of the books; the answers live in `answerAccountingRead`. */
export async function GET(req: NextRequest) {
  return answerAccountingRead(req.nextUrl.searchParams);
}

export async function POST(req: NextRequest) {
  // Browser-only command boundary; integration credentials are intentionally absent.
  if (
    !sameOrigin(req) ||
    !req.headers.get("content-type")?.includes("application/json")
  ) {
    return NextResponse.json(
      { error: "Invalid request origin or content type." },
      { status: 403 },
    );
  }
  let client;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      await boundedBytes(req, 1000000),
    );
  } catch {
    return NextResponse.json(
      { error: "Entry exceeds the supported size or has invalid encoding." },
      { status: 413 },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = extendedRequestSchema.safeParse(value);
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid entry." },
      { status: 400 },
    );
  const { data, error } = await readAccounting(client, "operate", {
    p_key: parsed.data.key,
    p_command: parsed.data.command,
  });
  if (error)
    return NextResponse.json(
      { error: accountingError(error.message) },
      { status: 409 },
    );
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
