import { readAccounting } from "@/lib/accounting/server/read";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  accountingClient,
  accountingError,
} from "@/lib/accounting/server/access";
import type { BooksPackageSnapshot } from "@/lib/accounting/books-package";
import { booksPackageDocuments } from "@/lib/accounting/books-package-document";
import { documentCsv } from "@/lib/accounting/report-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let client;
  try {
    client = await accountingClient();
  } catch {
    return NextResponse.json(
      { error: "Accounting is unavailable for this session." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const { id } = await params,
      format = req.nextUrl.searchParams.get("format") ?? "zip",
      // Layout 2 is the branded package the redesigned page downloads.
      layout = req.nextUrl.searchParams.get("layout") === "2" ? 2 : 1,
      // One report from the package, as a PDF or CSV.
      report = req.nextUrl.searchParams.get("report");
    if (
      !z.guid().safeParse(id).success ||
      !(report ? ["pdf", "csv"] : ["zip", "csv-zip", "json"]).includes(format) ||
      (report !== null && !/^[a-z-]{1,60}$/.test(report))
    )
      return NextResponse.json(
        { error: "Choose a retained books package and a supported format." },
        { status: 400 },
      );
    const { data, error } = await readAccounting(client, "snapshot", {
      p_id: id,
    });
    if (error) throw error;
    const snapshot = data as BooksPackageSnapshot | null;
    if (
      snapshot?.payload?.type !== "books_package" ||
      snapshot.payload.export_definition !== 1
    )
      return NextResponse.json(
        { error: "This retained books package is unavailable." },
        { status: 404 },
      );
    const documents = booksPackageDocuments(snapshot, layout);
    const filename = `books-package-${snapshot.payload.year}-${snapshot.payload.through}-${id.slice(0, 8)}`;
    const headers = {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accounting-Snapshot": id,
    };
    if (report) {
      const found = documents.find((d) => d.id === report);
      if (!found)
        return NextResponse.json(
          { error: "This report is not in the retained package." },
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      const name = `${report}-${snapshot.payload.year}-${snapshot.payload.through}.${format}`;
      const body =
        format === "csv"
          ? documentCsv(found.document)
          : new Uint8Array(
              await (await import("@/lib/accounting/server/report-pdf")).reportPdf(found.document),
            );
      return new NextResponse(body, {
        headers: {
          ...headers,
          "Content-Type": format === "csv" ? "text/csv;charset=utf-8" : "application/pdf",
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      });
    }
    if (format === "json")
      return new NextResponse(JSON.stringify(snapshot, null, 2), {
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${filename}.json"`,
        },
      });
    if (format === "zip") await import("@/lib/accounting/server/report-pdf");
    const { booksPackageZip } = await import(
      "@/lib/accounting/server/books-package-zip"
    );
    const iterator = booksPackageZip(snapshot, format === "zip", layout);
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    });
    return new NextResponse(stream, {
      headers: {
        ...headers,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}.zip"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: accountingError(
          error instanceof Error ? error.message : String(error),
        ),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
