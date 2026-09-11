import { NextRequest, NextResponse } from "next/server";
import { strToU8, zipSync } from "fflate";
import { createClient } from "@/lib/supabase/server";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import {
  readAccounting,
  type AccountingRpc,
} from "@/lib/accounting/server/read";
import {
  dateSchema,
  type AccountingWorkspace,
  type JournalEntry,
} from "@/lib/accounting/contracts";
import type { ManageData } from "@/lib/accounting/workflows";
import type { DocumentList } from "@/lib/accounting/documents";
import type { FeedData } from "@/lib/accounting/feeds";
import type { PayrollList } from "@/lib/accounting/payroll";
import type { ReportData } from "@/lib/accounting/reports";
import {
  BOOKS_DATASETS,
  isExportDataset,
  type ExportDataset,
  type ExportFormat,
} from "@/lib/export-datasets";
import { centsToAmount, toCsv, type CsvRow } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download your data: the datasets the owner picked, as one JSON document or
 * a zip of spreadsheets. Personal finance comes straight from the public
 * tables under row-level security; the books come from the same accounting
 * reads the screens use, so nothing here can see more than the owner does.
 */

type Table = { name: string; rows: CsvRow[] };
type Collected = { json: unknown; tables: Table[] };
type Collector = () => Promise<Collected>;

const PAGE = 100;
const MAX_ENTRIES = 100_000;

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Spreadsheet row: cents become decimal amounts, nested values become JSON. */
function flat(row: Record<string, unknown>): CsvRow {
  const out: CsvRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_cents")) out[key.slice(0, -6)] = centsToAmount(value);
    else out[key] = value;
  }
  return out;
}

function rows(list: unknown): CsvRow[] {
  return Array.isArray(list)
    ? list.map((r) => flat(r as Record<string, unknown>))
    : [];
}

async function fetchAll(
  client: AccountingRpc,
  from: string,
  to: string,
): Promise<JournalEntry[]> {
  const entries: JournalEntry[] = [];
  for (let offset = 0; offset < MAX_ENTRIES; offset += PAGE) {
    const { data, error } = await readAccounting(client, "register", {
      p_filter: {
        status: "all",
        sort: "date_asc",
        from,
        to,
        offset,
        limit: PAGE,
      },
    });
    if (error) throw new Error(error.message);
    const page = data as { entries: JournalEntry[]; total: number };
    entries.push(...page.entries);
    if (page.entries.length < PAGE || entries.length >= page.total) break;
  }
  return entries;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const requested = (params.get("datasets") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const format = (params.get("format") ?? "json") as ExportFormat;
  const from = params.get("from") || "2000-01-01";
  const to = params.get("to") || today();
  if (
    !requested.length ||
    !requested.every(isExportDataset) ||
    !["json", "csv"].includes(format) ||
    !dateSchema.safeParse(from).success ||
    !dateSchema.safeParse(to).success ||
    from > to
  )
    return NextResponse.json(
      {
        error: "Choose at least one dataset, a format and a valid date range.",
      },
      { status: 400 },
    );
  const datasets = requested as ExportDataset[];

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "Sign in to export your data." },
      { status: 401 },
    );

  // The books need the accounting session, and a few shared lookups.
  let books: AccountingRpc | null = null;
  let booksError = "";
  let manage: ManageData | null = null;
  let workspace: AccountingWorkspace | null = null;
  if (datasets.some((d) => BOOKS_DATASETS.has(d))) {
    try {
      books = await accountingClient();
      const [m, w] = await Promise.all([
        readAccounting(books, "manage"),
        readAccounting(books, "workspace", { from, to }),
      ]);
      if (m.error) throw new Error(m.error.message);
      if (w.error) throw new Error(w.error.message);
      manage = m.data as ManageData;
      workspace = w.data as AccountingWorkspace;
    } catch (error) {
      books = null;
      booksError = accountingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const accountName = new Map(
    (workspace?.accounts ?? []).map((a) => [a.id, a] as const),
  );
  const partyName = new Map(
    (manage?.parties ?? []).map((p) => [p.id, p.name] as const),
  );
  const profile = new Map(
    (manage?.profiles ?? []).map((p) => [p.account_id, p] as const),
  );

  const personal = (table: string) => supabase.from(table);

  const collectors: Record<ExportDataset, Collector> = {
    async income() {
      const [sources, entries, amounts, lineItems] = await Promise.all([
        personal("income_sources").select("*").is("deleted_at", null),
        personal("income_entries").select("*").is("deleted_at", null),
        personal("income_amounts").select("*"),
        personal("income_line_items").select("*").is("deleted_at", null),
      ]);
      for (const r of [sources, entries, amounts, lineItems])
        if (r.error) throw new Error(r.error.message);
      const active = new Set((entries.data ?? []).map((e) => e.id));
      const keep = (list: { entry_id: string }[] | null) =>
        (list ?? []).filter((x) => active.has(x.entry_id));
      const json = {
        income_sources: sources.data ?? [],
        income_entries: entries.data ?? [],
        income_amounts: keep(amounts.data),
        income_line_items: keep(lineItems.data),
      };
      return {
        json,
        tables: Object.entries(json).map(([name, list]) => ({
          name,
          rows: rows(list),
        })),
      };
    },
    async expenses() {
      const expenses = await personal("expenses")
        .select("*")
        .is("deleted_at", null);
      if (expenses.error) throw new Error(expenses.error.message);
      const ids = (expenses.data ?? []).map((e) => e.id);
      const history = ids.length
        ? await personal("expense_history").select("*").in("expense_id", ids)
        : { data: [], error: null };
      if (history.error) throw new Error(history.error.message);
      const json = {
        expenses: expenses.data ?? [],
        expense_history: history.data ?? [],
      };
      return {
        json,
        tables: [
          { name: "expenses", rows: rows(json.expenses) },
          { name: "expense_history", rows: rows(json.expense_history) },
        ],
      };
    },
    async net_worth() {
      const result = await personal("net_worth")
        .select("*")
        .is("deleted_at", null);
      if (result.error) throw new Error(result.error.message);
      return {
        json: result.data ?? [],
        tables: [{ name: "net_worth", rows: rows(result.data) }],
      };
    },
    async tax_estimates() {
      const result = await personal("tax_estimates").select("*");
      if (result.error) throw new Error(result.error.message);
      return {
        json: result.data ?? [],
        tables: [{ name: "tax_estimates", rows: rows(result.data) }],
      };
    },
    async transactions() {
      if (!books) throw new Error(booksError);
      const entries = await fetchAll(books, from, to);
      const lines: CsvRow[] = [];
      for (const e of entries)
        for (const l of e.lines) {
          const account = accountName.get(l.account_id);
          lines.push({
            entry_id: e.id,
            date: e.entry_date,
            description: e.memo,
            status: e.status === "posted" ? "reviewed" : e.status,
            source: e.primary_origin,
            bank_description: e.source_description ?? "",
            payee: partyName.get(e.context?.payee_id ?? "") ?? "",
            account_code: account?.code ?? "",
            account: account?.name ?? l.account_id,
            amount: centsToAmount(l.amount_cents),
            line_note: l.memo,
          });
        }
      return { json: entries, tables: [{ name: "transactions", rows: lines }] };
    },
    async accounts() {
      if (!books || !workspace) throw new Error(booksError);
      const list = workspace.balances.map((a) => {
        const p = profile.get(a.id);
        return {
          code: a.code,
          name: a.name,
          type: a.account_type,
          subtype: p?.subtype ?? "",
          cash_kind: p?.cash_kind ?? "none",
          purpose: p?.purpose ?? "",
          archived: a.is_archived,
          opening_cents: a.opening_cents,
          debits_cents: a.debit_cents,
          credits_cents: a.credit_cents,
          ending_cents: a.ending_cents,
        };
      });
      return { json: list, tables: [{ name: "accounts", rows: rows(list) }] };
    },
    async statements() {
      if (!books) throw new Error(booksError);
      const result = await readAccounting(books, "report", {
        p_filter: { from, to, mode: "posted", offset: 0 },
      });
      if (result.error) throw new Error(result.error.message);
      const report = result.data as ReportData;
      const json = {
        totals: report.totals,
        monthly: report.monthly,
        accounts: report.accounts,
      };
      return {
        json,
        tables: [
          { name: "profit_loss_monthly", rows: rows(report.monthly) },
          { name: "profit_loss_accounts", rows: rows(report.accounts) },
        ],
      };
    },
    async payees() {
      if (!manage) throw new Error(booksError);
      const list = manage.parties.map((p) => ({
        ...p,
        default_category:
          accountName.get(p.default_account_id ?? "")?.name ?? "",
      }));
      return { json: list, tables: [{ name: "payees", rows: rows(list) }] };
    },
    async documents() {
      if (!books) throw new Error(booksError);
      const result = await readAccounting(books, "documents", {});
      if (result.error) throw new Error(result.error.message);
      const list = (result.data as DocumentList).documents;
      const table = list.map((d) => ({
        id: d.id,
        file: d.original_name,
        type: d.mime_type,
        size_bytes: d.size_bytes,
        state: d.state,
        uploaded_at: d.created_at,
        linked_entries: (d.entries ?? []).map((e) => e.memo).join("; "),
      }));
      return { json: list, tables: [{ name: "documents", rows: rows(table) }] };
    },
    async bank_connections() {
      if (!books) throw new Error(booksError);
      const result = await readAccounting(books, "feeds");
      if (result.error) throw new Error(result.error.message);
      const feeds = result.data as FeedData;
      const json = {
        connections: feeds.connections,
        accounts: feeds.accounts.map((a) => ({
          ...a,
          account: accountName.get(a.account_id)?.name ?? a.account_id,
        })),
        identities: feeds.identities.map((i) => ({
          ...i,
          balance_cents: i.balance?.balance_cents ?? null,
          balance: undefined,
          account: undefined,
        })),
      };
      return {
        json,
        tables: [
          { name: "bank_connections", rows: rows(json.connections) },
          { name: "bank_accounts", rows: rows(json.accounts) },
          { name: "bank_identities", rows: rows(json.identities) },
        ],
      };
    },
    async payroll() {
      if (!books) throw new Error(booksError);
      const runs: PayrollList["runs"][number][] = [];
      const first = Number(from.slice(0, 4)),
        last = Number(to.slice(0, 4));
      for (let year = first; year <= last; year++) {
        for (let offset = 0; offset < MAX_ENTRIES; offset += 50) {
          const result = await readAccounting(books, "payroll", {
            p_filter: { year, as_of: to, query: "", offset },
          });
          if (result.error) throw new Error(result.error.message);
          const page = result.data as PayrollList;
          runs.push(...page.runs);
          if (page.runs.length < 50 || runs.length >= page.count) break;
        }
      }
      return {
        json: runs,
        tables: [{ name: "payroll_runs", rows: rows(runs) }],
      };
    },
  };

  const exported: Record<string, unknown> = {};
  const tables: { dataset: string; table: Table }[] = [];
  const errors: Record<string, string> = {};
  for (const dataset of datasets) {
    try {
      const result = await collectors[dataset]();
      exported[dataset] = result.json;
      for (const table of result.tables) tables.push({ dataset, table });
    } catch (error) {
      errors[dataset] = accountingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (Object.keys(exported).length === 0)
    return NextResponse.json(
      { error: Object.values(errors)[0] ?? "Nothing could be exported." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );

  const stamp = today();
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (format === "json")
    return new NextResponse(
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          range: { from, to },
          datasets: exported,
          ...(Object.keys(errors).length ? { errors } : {}),
        },
        null,
        2,
      ),
      {
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="valiance-export-${stamp}.json"`,
        },
      },
    );

  const files: Record<string, Uint8Array> = {};
  for (const { dataset, table } of tables)
    files[`${dataset}/${table.name}.csv`] = strToU8(toCsv(table.rows));
  files["README.txt"] = strToU8(
    [
      `Valiance Media data export, ${stamp}`,
      `Books range: ${from} through ${to}`,
      `Datasets: ${Object.keys(exported).join(", ")}`,
      ...(Object.keys(errors).length
        ? [
            "",
            "Not included:",
            ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`),
          ]
        : []),
      "",
      "Amounts are in US dollars. One CSV per table, UTF-8 with a byte order mark.",
      "",
    ].join("\n"),
  );
  const zip = zipSync(files, { level: 6 });
  return new NextResponse(Buffer.from(zip), {
    headers: {
      ...headers,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="valiance-export-${stamp}.zip"`,
    },
  });
}
