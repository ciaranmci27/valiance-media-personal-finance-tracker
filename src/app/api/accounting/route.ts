import { NextRequest, NextResponse } from "next/server";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { dateSchema } from "@/lib/accounting/contracts";
import {
  extendedRequestSchema,
  registerFilterSchema,
} from "@/lib/accounting/workflows";
import { z } from "zod";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const view = req.nextUrl.searchParams.get("view");
  if (view) {
    let result;
    if (view === "manage") result = await client.rpc("acct_manage");
    else if (view === "feeds") result = await client.rpc("acct_feed_view");
    else if (view === "rules") result = await client.rpc("acct_rules_view");
    else if (view === "history") result = await client.rpc("acct_history_view");
    else if (view === "close-history")
      result = await client.rpc("acct_close_history");
    else if (view === "transfers") {
      const parsed = z
        .object({
          from: dateSchema,
          to: dateSchema,
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
        })
        .refine((v) => v.from <= v.to)
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid transfer range." },
          { status: 400 },
        );
      result = await client.rpc("acct_transfers_view", {
        p_from: parsed.data.from,
        p_to: parsed.data.to,
        p_offset: parsed.data.offset,
      });
    } else if (view === "rules-preview") {
      const parsed = z
        .object({
          from: dateSchema,
          to: dateSchema,
          rule: z.uuid().optional(),
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
        })
        .refine((v) => v.from <= v.to)
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid rule preview range." },
          { status: 400 },
        );
      result = await client.rpc("acct_rules_preview", {
        p_from: parsed.data.from,
        p_to: parsed.data.to,
        p_rule: parsed.data.rule ?? null,
        p_offset: parsed.data.offset,
      });
    } else if (view === "bank-review") {
      const parsed = z
        .object({
          group: z.uuid(),
          query: z.string().max(200).default(""),
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
        })
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose an imported bank movement." },
          { status: 400 },
        );
      result = await client.rpc("acct_bank_review", {
        p_group: parsed.data.group,
        p_query: parsed.data.query,
        p_offset: parsed.data.offset,
      });
    } else if (view === "statement-sources") {
      const parsed = z
        .uuid()
        .safeParse(req.nextUrl.searchParams.get("statement"));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a statement." },
          { status: 400 },
        );
      result = await client.rpc("acct_statement_sources", {
        p_statement: parsed.data,
      });
    } else if (view === "snapshot") {
      const id = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
      if (!id.success)
        return NextResponse.json(
          { error: "Choose a saved report." },
          { status: 400 },
        );
      result = await client.rpc("acct_snapshot_read", { p_id: id.data });
    } else if (view === "reconciliation") {
      const parsed = z
        .object({
          id: z.uuid().optional(),
          account: z.uuid().optional(),
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
          query: z.string().max(200).default(""),
        })
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a statement or account." },
          { status: 400 },
        );
      result = await client.rpc("acct_reconciliation_view", {
        p_id: parsed.data.id ?? null,
        p_account: parsed.data.account ?? null,
        p_offset: parsed.data.offset,
        p_query: parsed.data.query,
      });
    } else if (
      view === "close" ||
      view === "period-impact" ||
      view === "clearing"
    ) {
      const parsed = dateSchema.safeParse(req.nextUrl.searchParams.get("date"));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid date." },
          { status: 400 },
        );
      if (view === "clearing") {
        const account = z
          .uuid()
          .nullable()
          .safeParse(req.nextUrl.searchParams.get("account"));
        if (!account.success)
          return NextResponse.json(
            { error: "Choose an account." },
            { status: 400 },
          );
        result = await client.rpc("acct_clearing_view", {
          p_as_of: parsed.data,
          p_account: account.data,
        });
      } else
        result = await client.rpc(
          view === "close" ? "acct_close_checklist" : "acct_period_impact",
          { p_month: parsed.data },
        );
    } else if (view === "documents") {
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .safeParse(req.nextUrl.searchParams.get("offset") ?? 0);
      if (!offset.success)
        return NextResponse.json(
          { error: "Invalid document page." },
          { status: 400 },
        );
      result = await client.rpc("acct_documents_read", {
        p_id: null,
        p_offset: offset.data,
      });
    } else if (view === "imports") {
      const id = z
        .uuid()
        .nullable()
        .safeParse(req.nextUrl.searchParams.get("batch"));
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .safeParse(req.nextUrl.searchParams.get("offset") ?? 0);
      if (!id.success || !offset.success)
        return NextResponse.json(
          { error: "Invalid import request." },
          { status: 400 },
        );
      result = await client.rpc("acct_imports", {
        p_batch: id.data,
        p_offset: offset.data,
      });
    } else if (view === "evidence") {
      const id = z.uuid().safeParse(req.nextUrl.searchParams.get("entry"));
      if (!id.success)
        return NextResponse.json(
          { error: "Choose an entry." },
          { status: 400 },
        );
      result = await client.rpc("acct_entry_evidence", { p_entry: id.data });
    } else if (view === "register") {
      let raw: unknown;
      try {
        raw = JSON.parse(req.nextUrl.searchParams.get("filter") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Invalid filters." },
          { status: 400 },
        );
      }
      const parsed = registerFilterSchema.safeParse(raw);
      if (!parsed.success)
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid filters." },
          { status: 400 },
        );
      result = await client.rpc("acct_register", { p_filter: parsed.data });
    } else if (view === "account-ledger") {
      const schema = z
        .object({
          account: z.uuid(),
          from: dateSchema,
          to: dateSchema,
          offset: z.coerce.number().int().min(0).default(0),
        })
        .refine((v) => v.from <= v.to);
      const parsed = schema.safeParse(
        Object.fromEntries(req.nextUrl.searchParams),
      );
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose an account and valid range." },
          { status: 400 },
        );
      result = await client.rpc("acct_account_ledger", {
        p_account: parsed.data.account,
        p_from: parsed.data.from,
        p_to: parsed.data.to,
        p_offset: parsed.data.offset,
      });
    } else
      return NextResponse.json(
        { error: "Unknown accounting view." },
        { status: 400 },
      );
    if (result.error)
      return NextResponse.json(
        { error: accountingError(result.error.message) },
        { status: 400 },
      );
    return NextResponse.json(result.data, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (req.nextUrl.searchParams.get("export") === "true") {
    const { data, error } = await client.rpc("acct_books_backup");
    if (error)
      return NextResponse.json(
        { error: accountingError(error.message) },
        { status: 400 },
      );
    return NextResponse.json(data, {
      headers: {
        "Content-Disposition": "attachment; filename=accounting-books.json",
        "Cache-Control": "no-store",
      },
    });
  }
  const from = dateSchema.safeParse(req.nextUrl.searchParams.get("from"));
  const to = dateSchema.safeParse(req.nextUrl.searchParams.get("to"));
  if (!from.success || !to.success || from.data > to.data)
    return NextResponse.json(
      { error: "Choose a valid date range." },
      { status: 400 },
    );
  const { data, error } = await client.rpc("acct_workspace", {
    p_from: from.data,
    p_to: to.data,
  });
  if (error)
    return NextResponse.json(
      { error: accountingError(error.message) },
      { status: 400 },
    );
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
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
  const { data, error } = await client.rpc("acct_operate", {
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
