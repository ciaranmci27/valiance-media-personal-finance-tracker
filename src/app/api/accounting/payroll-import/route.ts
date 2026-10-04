import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { boundedForm } from "@/lib/accounting/server/request-body";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { loadDocument } from "@/lib/accounting/server/document-storage";
import { readAccounting } from "@/lib/accounting/server/read";
import { patriotItems } from "@/lib/accounting/server/patriot-payload";
import { gustoItems } from "@/lib/accounting/server/gusto-payload";
import {
  parsePatriot,
  patriotMappingSchema,
  patriotChoiceSchema,
} from "@/lib/accounting/patriot-import";
import {
  parseGusto,
  gustoMappingSchema,
  gustoChoiceSchema,
  gustoCredits,
  gustoFeeSelectionSchema,
  gustoFileRange,
  gustoYears,
} from "@/lib/accounting/gusto-import";
import type { DocumentList } from "@/lib/accounting/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Client = Awaited<ReturnType<typeof accountingClient>>;
const noStore = { headers: { "Cache-Control": "no-store" } };

/**
 * Gusto's Payroll data export: same inspect, preview and commit steps as
 * Patriot, against accounting.gusto_import. Commit re-reads the stored,
 * hash-checked workbook, so what is imported is exactly what was previewed.
 */
async function gusto(
  client: Client,
  form: FormData,
  mode: "inspect" | "preview" | "commit",
  bytes: Uint8Array,
  document_id: string | undefined,
  fileName: string,
) {
  const report = parseGusto(bytes);
  const defaults = await client.rpc("gusto_import", {
    request: { mode: "defaults" },
  });
  if (defaults.error) throw new Error(accountingError(defaults.error.message));
  const saved = defaults.data as {
    mapping?: unknown;
    fee_account?: string | null;
    first_year?: number | null;
  };
  // The years the file covers: its payrolls, the date range in Gusto's file
  // name (the stored evidence keeps that name, so a commit sees the same
  // range), and for a file with neither, the year the owner picked. A picked
  // year is checked against the books' first year and the current year.
  const thisYear = new Date().getUTCFullYear();
  const firstYear = Math.min(saved.first_year ?? thisYear - 10, thisYear);
  const range = gustoFileRange(fileName);
  const picked = form.get("year");
  const chosen = picked
    ? z.coerce.number().int().min(firstYear).max(thisYear).parse(picked)
    : null;
  const years = gustoYears(report, range, chosen);
  if (mode === "inspect")
    return NextResponse.json(
      {
        provider: "gusto",
        from: report.from,
        to: report.to,
        employees: report.employees,
        skipped: report.skipped,
        payroll_count: report.runs.length,
        mapping: saved.mapping ?? null,
        fee_account: saved.fee_account ?? null,
        years,
        first_year: firstYear,
        needs_year: years.length === 0,
      },
      noStore,
    );
  const mapping = gustoMappingSchema.parse(
    JSON.parse(String(form.get("mapping"))),
  );
  const choices =
    mode === "commit"
      ? z
          .record(z.string().max(100), gustoChoiceSchema)
          .parse(JSON.parse(String(form.get("choices"))))
      : {};
  const items = gustoItems(report, mapping, choices);
  // Gusto's fee and refund entries in the years the file covers.
  const feeAccount = z
    .guid()
    .nullable()
    .parse((form.get("fee_account") as string | null) || null);
  if (!years.length)
    throw new Error(
      "This file has no payrolls and no date range in its name. Choose the year it covers.",
    );
  const fees = {
    fee_account: feeAccount,
    years,
    credits: gustoCredits(report),
  };
  const selected =
    mode === "commit"
      ? gustoFeeSelectionSchema.parse(
          JSON.parse(String(form.get("fees") ?? "[]")),
        )
      : [];
  if (
    mode === "commit" &&
    ((!Object.keys(choices).length && !selected.length) ||
      Object.keys(choices).some((key) => !items.some((i) => i.key === key)))
  )
    throw new Error("Choose the payrolls to import from the preview.");
  const result = await client.rpc("gusto_import", {
    request: {
      mode,
      mapping,
      items,
      document_id,
      content_hash: createHash("sha256").update(bytes).digest("hex"),
      fees: { ...fees, selected },
    },
  });
  if (result.error) throw new Error(accountingError(result.error.message));
  const feeRows =
    mode === "preview"
      ? await client.rpc("gusto_fees", { request: { ...fees, mapping } })
      : null;
  if (feeRows?.error) throw new Error(accountingError(feeRows.error.message));
  return NextResponse.json(
    {
      provider: "gusto",
      from: report.from,
      to: report.to,
      employees: report.employees,
      skipped: report.skipped,
      mapping,
      results: result.data,
      fee_account: feeAccount,
      fees: feeRows?.data ?? [],
      years,
    },
    noStore,
  );
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
      { error: "Sign in as the accounting owner." },
      { status: 403 },
    );
  }
  try {
    const form = await boundedForm(req, 3 * 1024 * 1024);
    const mode = z
      .enum(["inspect", "preview", "commit"])
      .parse(form.get("mode"));
    const provider = z
      .enum(["patriot", "gusto"])
      .parse(form.get("provider") ?? "patriot");
    let bytes: Uint8Array,
      document_id: string | undefined,
      fileName = "";
    if (mode === "commit") {
      document_id = z.guid().parse(form.get("document_id"));
      const docs = await readAccounting(client, "documents", {
        p_id: document_id,
        p_offset: 0,
      });
      if (docs.error) throw new Error(accountingError(docs.error.message));
      const doc = (docs.data as DocumentList).documents[0];
      if (
        !doc ||
        doc.state !== "available" ||
        Number(doc.size_bytes) > 2_000_000
      )
        throw new Error(
          provider === "gusto"
            ? "The original payroll export is unavailable."
            : "The original payroll CSV is unavailable.",
        );
      bytes = await loadDocument(doc.storage_path);
      fileName = doc.original_name;
      if (createHash("sha256").update(bytes).digest("hex") !== doc.content_hash)
        throw new Error(
          provider === "gusto"
            ? "The stored payroll export failed its integrity check."
            : "The stored CSV failed its integrity check.",
        );
    } else {
      const file = form.get("file");
      const extension = provider === "gusto" ? ".xlsx" : ".csv";
      if (
        !(file instanceof File) ||
        !file.name.toLowerCase().endsWith(extension) ||
        file.size > 2_000_000
      )
        throw new Error(
          provider === "gusto"
            ? "Choose Gusto's Payroll data export (.xlsx) smaller than 2 MB."
            : "Choose a Payroll Details CSV smaller than 2 MB.",
        );
      bytes = new Uint8Array(await file.arrayBuffer());
      fileName = file.name;
    }
    if (provider === "gusto")
      return await gusto(client, form, mode, bytes, document_id, fileName);
    const report = parsePatriot(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const defaults = await client.rpc("patriot_import", {
      request: { mode: "defaults" },
    });
    if (defaults.error)
      throw new Error(accountingError(defaults.error.message));
    const saved = defaults.data as { company_id?: string; mapping?: unknown };
    if (saved.company_id && saved.company_id !== report.company_id)
      throw new Error(
        "This CSV belongs to a different Patriot company than your earlier imports.",
      );
    if (mode === "inspect")
      return NextResponse.json(
        {
          company_id: report.company_id,
          company_name: report.company_name,
          employees: report.employees,
          payroll_count: report.groups.length,
          mapping: saved.mapping ?? null,
        },
        noStore,
      );
    const mapping = patriotMappingSchema.parse(
      JSON.parse(String(form.get("mapping"))),
    );
    const choices =
      mode === "commit"
        ? z
            .record(z.string().max(100), patriotChoiceSchema)
            .parse(JSON.parse(String(form.get("choices"))))
        : {};
    const items = patriotItems(report, mapping, choices);
    if (
      mode === "commit" &&
      (!Object.keys(choices).length ||
        Object.keys(choices).some((key) => !items.some((i) => i.key === key)))
    )
      throw new Error("Choose the payrolls to import from the preview.");
    const result = await client.rpc("patriot_import", {
      request: {
        mode,
        company_id: report.company_id,
        company_name: report.company_name,
        mapping,
        items,
        document_id,
        content_hash: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    if (result.error) throw new Error(accountingError(result.error.message));
    return NextResponse.json(
      {
        company_id: report.company_id,
        company_name: report.company_name,
        employees: report.employees,
        mapping,
        results: result.data,
      },
      noStore,
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? "Review the payroll accounts and selected records."
            : error instanceof Error
              ? error.message
              : "Unable to read this payroll report.",
      },
      { status: 409 },
    );
  }
}
