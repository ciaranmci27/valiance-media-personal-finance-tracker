import { readAccounting } from "@/lib/accounting/server/read";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";
import {
  taxServer,
  taxWorkerEnabled,
} from "@/lib/accounting/server/tax-service";
import { refreshTaxLink } from "@/lib/accounting/tax-refresh";
import type { TaxLinkView } from "@/lib/accounting/tax-links";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(req: NextRequest) {
  let client;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  const year = z.coerce
    .number()
    .int()
    .min(1900)
    .max(2100)
    .safeParse(req.nextUrl.searchParams.get("year"));
  const snapshot = req.nextUrl.searchParams.get("snapshot"),
    history = req.nextUrl.searchParams.get("history");
  let result;
  if (snapshot) {
    if (!z.uuid().safeParse(snapshot).success)
      return NextResponse.json(
        { error: "Choose a valid snapshot." },
        { status: 400 },
      );
    result = await readAccounting(client, "tax-snapshot", { p_id: snapshot });
  } else if (history) {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(10000000)
      .safeParse(req.nextUrl.searchParams.get("offset") ?? 0);
    if (!z.uuid().safeParse(history).success || !offset.success)
      return NextResponse.json(
        { error: "Choose a valid history." },
        { status: 400 },
      );
    result = await readAccounting(client, "tax-history", {
      p_id: history,
      p_offset: offset.data,
    });
  } else {
    if (!year.success)
      return NextResponse.json(
        { error: "Choose a tax year." },
        { status: 400 },
      );
    result = await readAccounting(client, "tax", { p_year: year.data });
  }
  if (result.error)
    return NextResponse.json(
      { error: accountingError(result.error.message) },
      { status: 400 },
    );
  return NextResponse.json(
    snapshot || history
      ? result.data
      : { ...(result.data as TaxLinkView), worker_enabled: taxWorkerEnabled() },
    { headers },
  );
}
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
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBytes(req, 2000),
      ),
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid tax refresh request." },
      { status: 400 },
    );
  }
  const parsed = z
    .object({
      year: z.number().int().min(1900).max(2100),
      force: z.boolean().default(false),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success)
    return NextResponse.json({ error: "Choose a tax year." }, { status: 400 });
  try {
    const { data, error } = await readAccounting(client, "tax", {
      p_year: parsed.data.year,
    });
    if (error) throw new Error(accountingError(error.message));
    const view = data as TaxLinkView;
    if (!view.link?.enabled)
      return NextResponse.json({ state: "disabled" }, { headers });
    const result = await refreshTaxLink(
      taxServer,
      view.link.id,
      parsed.data.force,
    );
    return NextResponse.json(result, {
      headers,
      status: result.state === "failed" ? 422 : 200,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Tax refresh unavailable.",
      },
      { status: 503, headers },
    );
  }
}
