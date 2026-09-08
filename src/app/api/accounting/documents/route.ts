import { readAccounting } from "@/lib/accounting/server/read";
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import { sameOrigin } from "@/lib/accounting/server/request-origin";
import { boundedForm } from "@/lib/accounting/server/request-body";
import {
  documentMime,
  storeDocument,
  loadDocument,
} from "@/lib/accounting/server/document-storage";
import type {
  DocumentList,
  AccountingDocument,
} from "@/lib/accounting/documents";
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
  const id = z.uuid().safeParse(req.nextUrl.searchParams.get("id"));
  if (!id.success)
    return NextResponse.json({ error: "Choose a document." }, { status: 400 });
  try {
    const result = await readAccounting(client, "documents", {
      p_id: id.data,
      p_offset: 0,
    });
    if (result.error) throw new Error(accountingError(result.error.message));
    const doc = (result.data as DocumentList).documents[0];
    if (!doc || !["available", "archived"].includes(doc.state))
      return NextResponse.json(
        { error: "Evidence is not available yet." },
        { status: 404 },
      );
    const bytes = await loadDocument(doc.storage_path);
    if (createHash("sha256").update(bytes).digest("hex") !== doc.content_hash)
      throw new Error(
        "Evidence integrity check failed. Restore this file from a verified backup.",
      );
    return new NextResponse(bytes as BodyInit, {
      headers: {
        "Content-Type": doc.mime_type,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Evidence is unavailable.",
      },
      { status: 409 },
    );
  }
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
      { error: "Accounting is unavailable for this session." },
      { status: 403 },
    );
  }
  try {
    const form = await boundedForm(req, 21 * 1024 * 1024),
      id = z.uuid().parse(form.get("id")),
      file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size < 1 ||
      file.size > 20 * 1024 * 1024
    )
      throw new Error("Choose a file between 1 byte and 20 MB.");
    const name = file.name.replace(/[\x00-\x1f\\/]/g, "_").slice(0, 240);
    const bytes = new Uint8Array(await file.arrayBuffer()),
      mime = documentMime(bytes, name),
      hash = createHash("sha256").update(bytes).digest("hex");
    const existing = await readAccounting(client, "documents", {
      p_id: id,
      p_offset: 0,
    });
    if (existing.error)
      throw new Error(accountingError(existing.error.message));
    let doc: Pick<
      AccountingDocument,
      | "id"
      | "version"
      | "storage_path"
      | "content_hash"
      | "original_name"
      | "state"
    > = (existing.data as DocumentList).documents[0];
    if (doc) {
      if (doc.content_hash !== hash || doc.original_name !== name)
        throw new Error(
          "This upload ID belongs to a different file. Start a new upload.",
        );
    } else {
      const prepared = await readAccounting(client, "operate", {
        p_key: id,
        p_command: {
          type: "document.prepare",
          id,
          original_name: name,
          content_hash: hash,
          mime_type: mime,
          size_bytes: String(bytes.length),
        },
      });
      if (prepared.error)
        throw new Error(accountingError(prepared.error.message));
      doc = {
        ...(prepared.data as {
          id: string;
          version: number;
          storage_path: string;
        }),
        content_hash: hash,
        original_name: name,
        state: "uploading",
      };
    }
    if (doc.state === "archived")
      throw new Error("This document is archived. Start a new upload.");
    if (doc.state === "uploading") {
      await storeDocument(doc.storage_path, bytes, mime);
      const completed = await readAccounting(client, "operate", {
        p_key: randomUUID(),
        p_command: {
          type: "document.complete",
          id,
          expected_version: doc.version,
        },
      });
      if (completed.error) {
        const refreshed = await readAccounting(client, "documents", {
          p_id: id,
          p_offset: 0,
        });
        if (
          refreshed.error ||
          (refreshed.data as DocumentList).documents[0]?.state !== "available"
        )
          throw new Error(accountingError(completed.error.message));
      }
    }
    const result = await readAccounting(client, "documents", {
      p_id: id,
      p_offset: 0,
    });
    if (result.error) throw new Error(accountingError(result.error.message));
    return NextResponse.json((result.data as DocumentList).documents[0], {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Upload paused. Retry the same file.",
      },
      { status: 400 },
    );
  }
}
