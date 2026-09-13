import { readAccounting } from "@/lib/accounting/server/read";
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
import { contractorFilterSchema } from "@/lib/accounting/contractors";
import { taxScopeSchema } from "@/lib/accounting/tax-workpapers";
import { payrollFilterSchema } from "@/lib/accounting/payroll";
import { registerActionSchema } from "@/lib/accounting/registers";
import { supportReportFilterSchema } from "@/lib/accounting/support-reports";
import { booksPackageScopeSchema } from "@/lib/accounting/books-package";
import { reportFilterSchema } from "@/lib/accounting/reports";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedBytes } from "@/lib/accounting/server/request-body";
import { importComparisonFilterSchema } from "@/lib/accounting/imports/comparison";
import { buildSetupGuide, claimGuide, type SetupStatus } from "@/lib/accounting/setup-guide";
import type { FeedData } from "@/lib/accounting/feeds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get("view");
  let client;
  try {
    client = await accountingClient();
  } catch (e) {
    // Before the owner row exists the guide still has one thing to say.
    if (view === "setup" && e instanceof Error && /not configured/.test(e.message))
      return NextResponse.json(
        claimGuide(
          Number(req.nextUrl.searchParams.get("year")) || new Date().getFullYear(),
        ),
        { headers: { "Cache-Control": "no-store" } },
      );
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  if (view) {
    let result;
    if (view === "import-comparison") {
      let input: unknown;
      try {
        input = JSON.parse(req.nextUrl.searchParams.get("filter") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Choose valid import files and dates." },
          { status: 400 },
        );
      }
      const filter = importComparisonFilterSchema.safeParse(input);
      if (!filter.success)
        return NextResponse.json(
          { error: "Choose two import files and their shared date range." },
          { status: 400 },
        );
      result = await readAccounting(client, "import-comparison", {
        p_filter: filter.data,
      });
    } else if (view === "books-package") {
      const scope = booksPackageScopeSchema.safeParse({
        year: Number(req.nextUrl.searchParams.get("year")),
        through: req.nextUrl.searchParams.get("through"),
      });
      if (!scope.success)
        return NextResponse.json(
          { error: "Choose a year and cutoff within that year." },
          { status: 400 },
        );
      result = await readAccounting(client, "books-package", {
        p_year: scope.data.year,
        p_through: scope.data.through,
      });
    } else if (view === "books-package-history") {
      const scope = z
        .object({
          year: z.coerce.number().int().min(1900).max(2100),
          offset: z.coerce.number().int().min(0).max(10000000),
        })
        .safeParse({
          year: req.nextUrl.searchParams.get("year"),
          offset: req.nextUrl.searchParams.get("offset") ?? 0,
        });
      if (!scope.success)
        return NextResponse.json(
          { error: "Choose a valid package history page." },
          { status: 400 },
        );
      result = await readAccounting(client, "books-package-history", {
        p_year: scope.data.year,
        p_offset: scope.data.offset,
      });
    } else if (view === "manage")
      result = await readAccounting(client, "manage");
    else if (view === "feeds") result = await readAccounting(client, "feeds");
    else if (view === "rules") result = await readAccounting(client, "rules");
    else if (view === "history")
      result = await readAccounting(client, "history");
    else if (view === "close-history")
      result = await readAccounting(client, "close-history");
    else if (view === "tax-workpapers") {
      const scope = taxScopeSchema.safeParse({
        year: Number(req.nextUrl.searchParams.get("year")),
        through: req.nextUrl.searchParams.get("through"),
      });
      if (!scope.success)
        return NextResponse.json(
          { error: "Choose a valid tax year and cutoff." },
          { status: 400 },
        );
      result = await readAccounting(client, "tax-source", {
        p_year: scope.data.year,
        p_through: scope.data.through,
      });
    } else if (view === "setup") {
      const parsed = z
        .object({ year: z.coerce.number().int().min(1900).max(2100) })
        .safeParse({ year: req.nextUrl.searchParams.get("year") });
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid year." },
          { status: 400 },
        );
      const [feeds, status] = await Promise.all([
        readAccounting(client, "feeds"),
        readAccounting(client, "setup-status", { p_year: parsed.data.year }),
      ]);
      // A feed read that fails leaves the bank steps out, as the shell does.
      result = status.error
        ? status
        : {
            data: buildSetupGuide({
              year: parsed.data.year,
              feeds: feeds.error ? null : (feeds.data as FeedData | null),
              status: status.data as SetupStatus,
            }),
            error: null,
          };
    } else if (view === "tax-history") {
      const parsed = z
        .object({
          kind: z.enum(["year", "mapping", "adjustment", "basis"]),
          year: z.coerce.number().int().min(1900).max(2100),
          key: z.uuid().nullable(),
          offset: z.coerce.number().int().min(0).max(10000000),
        })
        .safeParse({
          kind: req.nextUrl.searchParams.get("kind"),
          year: req.nextUrl.searchParams.get("year"),
          key: req.nextUrl.searchParams.get("key"),
          offset: req.nextUrl.searchParams.get("offset") ?? "0",
        });
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid workpaper history." },
          { status: 400 },
        );
      result = await readAccounting(client, "tax-history", {
        p_kind: parsed.data.kind,
        p_year: parsed.data.year,
        p_key: parsed.data.key,
        p_offset: parsed.data.offset,
      });
    } else if (view === "contractors") {
      let input: unknown;
      try {
        input = JSON.parse(req.nextUrl.searchParams.get("filter") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Choose a valid contractor scope." },
          { status: 400 },
        );
      }
      const filter = contractorFilterSchema.safeParse(input);
      if (!filter.success)
        return NextResponse.json(
          { error: "Choose a valid contractor year and cutoff." },
          { status: 400 },
        );
      result = await readAccounting(client, "contractors", {
        p_filter: filter.data,
      });
    } else if (view === "registers" || view === "register-detail") {
      const parsed = z
        .object({
          kind: z.enum(["asset", "loan"]).optional(),
          id: z.uuid().optional(),
          date: dateSchema,
          query: z.string().max(200).default(""),
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
        })
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (
        !parsed.success ||
        (view === "registers" && !parsed.data.kind) ||
        (view === "register-detail" && !parsed.data.id)
      )
        return NextResponse.json(
          { error: "Choose an asset or loan register and valid date." },
          { status: 400 },
        );
      result =
        view === "registers"
          ? await readAccounting(client, "registers", {
              p_kind: parsed.data.kind,
              p_date: parsed.data.date,
              p_query: parsed.data.query,
              p_offset: parsed.data.offset,
            })
          : await readAccounting(client, "register-detail", {
              p_id: parsed.data.id,
              p_date: parsed.data.date,
              p_offset: parsed.data.offset,
            });
    } else if (view === "register-preview") {
      let body: unknown;
      try {
        body = JSON.parse(req.nextUrl.searchParams.get("body") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Check the proposed register entry." },
          { status: 400 },
        );
      }
      const parsed = registerActionSchema.safeParse(body),
        identifier = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
      if (!parsed.success || !identifier.success)
        return NextResponse.json(
          { error: "Check the proposed register entry." },
          { status: 400 },
        );
      result = await readAccounting(client, "register-preview", {
        p_id: identifier.data,
        p_body: parsed.data,
      });
    } else if (view === "payroll-year") {
      const parsed = z
        .object({
          year: z.coerce.number().int().min(1900).max(2100),
          through: dateSchema,
        })
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a payroll year and coverage date." },
          { status: 400 },
        );
      result = await readAccounting(client, "payroll-year", {
        p_year: parsed.data.year,
        p_through: parsed.data.through,
      });
    } else if (view === "support-report") {
      let input: unknown;
      try {
        input = JSON.parse(req.nextUrl.searchParams.get("filter") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Choose valid report filters." },
          { status: 400 },
        );
      }
      const parsed = supportReportFilterSchema.safeParse(input);
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid report and period." },
          { status: 400 },
        );
      result = await readAccounting(client, "support-report", {
        p_filter: parsed.data,
        p_export: false,
      });
    } else if (view === "payroll") {
      let input: unknown;
      try {
        input = JSON.parse(req.nextUrl.searchParams.get("filter") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Choose valid payroll filters." },
          { status: 400 },
        );
      }
      const parsed = payrollFilterSchema.safeParse(input);
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid payroll year and cutoff." },
          { status: 400 },
        );
      result = await readAccounting(client, "payroll", {
        p_filter: parsed.data,
      });
    } else if (view === "payroll-detail") {
      const parsed = z
        .object({
          id: z.uuid(),
          bank_account_id: z.uuid().optional(),
          template: z.enum(["cash", "accrual"]).optional(),
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
        })
        .safeParse(Object.fromEntries(req.nextUrl.searchParams));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a payroll run." },
          { status: 400 },
        );
      result = await readAccounting(client, "payroll-detail", {
        p_id: parsed.data.id,
        p_offset: parsed.data.offset,
        bank_account_id: parsed.data.bank_account_id,
        template: parsed.data.template,
      });
    } else if (view === "report" || view === "report-detail") {
      let input: unknown;
      try {
        input = JSON.parse(req.nextUrl.searchParams.get("filter") ?? "{}");
      } catch {
        return NextResponse.json(
          { error: "Invalid report filters." },
          { status: 400 },
        );
      }
      const parsed = reportFilterSchema.safeParse(input);
      const ledger =
        view === "report" &&
        req.nextUrl.searchParams.get("report") === "general-ledger";
      if (
        !parsed.success ||
        (view === "report" &&
          ((!ledger && parsed.data.account_ids) ||
            parsed.data.account_types ||
            parsed.data.cash_class))
      )
        return NextResponse.json(
          { error: "Choose valid report dates and filters." },
          { status: 400 },
        );
      result = await readAccounting(
        client,
        view === "report"
          ? ledger
            ? "ledger-report"
            : "report"
          : "report-detail",
        { p_filter: parsed.data },
      );
    } else if (view === "cash-review") {
      const line = z.uuid().safeParse(req.nextUrl.searchParams.get("line"));
      if (!line.success)
        return NextResponse.json(
          { error: "Choose a bank cash movement." },
          { status: 400 },
        );
      result = await readAccounting(client, "cash-review", {
        p_line: line.data,
      });
    } else if (view === "transfers") {
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
      result = await readAccounting(client, "transfers", {
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
      result = await readAccounting(client, "rules-preview", {
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
      result = await readAccounting(client, "bank-review", {
        p_group: parsed.data.group,
        p_query: parsed.data.query,
        p_offset: parsed.data.offset,
      });
    } else if (view === "snapshot") {
      const id = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
      if (!id.success)
        return NextResponse.json(
          { error: "Choose a saved report." },
          { status: 400 },
        );
      result = await readAccounting(client, "snapshot", { p_id: id.data });
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
      result = await readAccounting(client, "reconciliation", {
        p_id: parsed.data.id ?? null,
        p_account: parsed.data.account ?? null,
        p_offset: parsed.data.offset,
        p_query: parsed.data.query,
      });
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
      result = await readAccounting(client, "documents", {
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
      result = await readAccounting(client, "imports", {
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
      result = await readAccounting(client, "evidence", { p_entry: id.data });
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
      result = await readAccounting(client, "register", {
        p_filter: parsed.data,
      });
    } else if (view === "close" || view === "period-impact") {
      const parsed = dateSchema.safeParse(req.nextUrl.searchParams.get("date"));
      if (!parsed.success)
        return NextResponse.json(
          { error: "Choose a valid month." },
          { status: 400 },
        );
      result = await readAccounting(client, view, {
        month: `${parsed.data.slice(0, 7)}-01`,
      });
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
      result = await readAccounting(client, "account-ledger", {
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

  const from = dateSchema.safeParse(req.nextUrl.searchParams.get("from"));
  const to = dateSchema.safeParse(req.nextUrl.searchParams.get("to"));
  if (!from.success || !to.success || from.data > to.data)
    return NextResponse.json(
      { error: "Choose a valid date range." },
      { status: 400 },
    );
  const { data, error } = await readAccounting(client, "workspace", {
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
