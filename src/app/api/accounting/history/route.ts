import { readAccounting } from "@/lib/accounting/server/read";
import { NextRequest, NextResponse } from "next/server";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";
import { historyCompareSchema } from "@/lib/accounting/history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only comparison; accepting a verification uses the standard command boundary. */
export async function POST(req: NextRequest) {
  if (
    !sameOrigin(req) ||
    !req.headers.get("content-type")?.includes("application/json")
  )
    return NextResponse.json(
      { error: "Invalid request origin or content type." },
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
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBytes(req, 1000000),
      ),
    );
  } catch {
    return NextResponse.json(
      { error: "Use a valid comparison request up to 1 MB." },
      { status: 400 },
    );
  }
  // Either the manual monthly and account controls, or a source report's totals.
  const parsed = historyCompareSchema.safeParse(value);
  if (!parsed.success)
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Check the source controls.",
      },
      { status: 400 },
    );
  const { data, error } = await readAccounting(
    client,
    "history-preview",
    parsed.data,
  );
  if (error)
    return NextResponse.json(
      { error: accountingError(error.message) },
      { status: 400 },
    );
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
