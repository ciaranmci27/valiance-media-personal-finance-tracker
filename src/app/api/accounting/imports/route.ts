import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { accountingClient } from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import {
  readCsv,
  journalGroups,
  bankGroups,
} from "@/lib/accounting/imports/csv";
import {
  csvOptionsSchema,
  journalMappingSchema,
  bankMappingSchema,
} from "@/lib/accounting/imports/contracts";
import { boundedForm } from "@/lib/accounting/server/request-body";
import {isWaveLedger, readWaveCsv, waveAccountProposals, waveJournalRows, type WaveAccount} from "@/lib/accounting/imports/wave";

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
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 21 * 1024 * 1024)
    return NextResponse.json(
      { error: "CSV files are limited to 20 MB." },
      { status: 413 },
    );
  try {
    const form = await boundedForm(req, 21 * 1024 * 1024);
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size > 20 * 1024 * 1024 ||
      !file.name.toLowerCase().endsWith(".csv")
    )
      throw new Error("Choose a CSV export up to 20 MB.");
    const options = csvOptionsSchema.parse(
      JSON.parse(String(form.get("options"))),
    );
    const bytes = await file.arrayBuffer();
    // Preserve a UTF-8 BOM in the file hash while the CSV reader removes it from headers.
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const wave = form.get("adapter") === "wave" || isWaveLedger(text);
    const table = wave ? readWaveCsv(text) : readCsv(text, options);
    if (form.get("phase") === "inspect")
      return NextResponse.json(
        {
          headers: table.headers,
          samples: table.rows.slice(0, 8),
          rowCount: table.rows.length,
          fileHash: table.fileHash,
          ...(wave ? {adapter: "wave", accountProposals: waveAccountProposals(text)} : {}),
          values: Object.fromEntries(
            table.headers.map((header, index) => [
              header,
              [...new Set(table.rows.map((row) => row[index].trim()))].slice(
                0,
                501,
              ),
            ]),
          ),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    const mode = String(form.get("mode"));
    const rawMapping = JSON.parse(String(form.get("mapping")));
    const mapping =
      mode === "journal"
        ? journalMappingSchema.parse(rawMapping)
        : mode === "bank"
          ? bankMappingSchema.parse(rawMapping)
          : null;
    if (!mapping) throw new Error("Choose journal or bank import.");
    if (wave && mode !== "journal") throw new Error("Import a Wave ledger as journal entries.");
    let waveAccounts: WaveAccount[] = [];
    let historyStart = "2022-12-31";
    if (wave) {
      const {data, error} = await client.rpc("context", {view: "manage", params: {}});
      if (error) throw new Error("Unable to load the books account mappings.");
      waveAccounts = data.profiles.map((p: {account_id: string; type: string; subtype: string; external_names: {wave?: string}}) => ({...p, id: p.account_id}));
      historyStart = data.preferences.business_profile.earliest_history_date;
      const selected = journalMappingSchema.parse(mapping).accounts;
      for (const [name, id] of Object.entries(selected)) {
        if (!waveAccounts.some(a => a.id === id && a.external_names.wave === name)) throw new Error("Save each Wave account name on its mapped book account before parsing the import.");
      }
    }
    const groups = wave ? waveJournalRows(text, waveAccounts, historyStart) :
      mode === "journal"
        ? journalGroups(table, options, journalMappingSchema.parse(mapping))
        : bankGroups(table, options, bankMappingSchema.parse(mapping));
    return NextResponse.json(
      {
        fileHash: table.fileHash,
        mappingHash: createHash("sha256")
          .update(JSON.stringify({ options, mapping, parserVersion: wave ? "wave-1" : 1, ...(wave ? {accounts: waveAccounts.map(a => ({id:a.id,type:a.type,subtype:a.subtype,external_names:a.external_names})), historyStart} : {}) }))
          .digest("hex"),
        groups,
        errorCount: groups.filter((g) => g.errors.length).length,
        headers: table.headers,
        rowCount: table.rows.length,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to parse this CSV.",
      },
      { status: 400 },
    );
  }
}
