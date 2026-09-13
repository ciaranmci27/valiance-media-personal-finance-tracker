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
import {
  parsePatriot,
  patriotMappingSchema,
  patriotChoiceSchema,
} from "@/lib/accounting/patriot-import";
import type { DocumentList } from "@/lib/accounting/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    let bytes: Uint8Array, document_id: string | undefined;
    if (mode === "commit") {
      document_id = z.uuid().parse(form.get("document_id"));
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
        throw new Error("The original payroll CSV is unavailable.");
      bytes = await loadDocument(doc.storage_path);
      if (createHash("sha256").update(bytes).digest("hex") !== doc.content_hash)
        throw new Error("The stored CSV failed its integrity check.");
    } else {
      const file = form.get("file");
      if (
        !(file instanceof File) ||
        !file.name.toLowerCase().endsWith(".csv") ||
        file.size > 2_000_000
      )
        throw new Error("Choose a Payroll Details CSV smaller than 2 MB.");
      bytes = new Uint8Array(await file.arrayBuffer());
    }
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
        { headers: { "Cache-Control": "no-store" } },
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
      { headers: { "Cache-Control": "no-store" } },
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
