import { createHash } from "node:crypto";
import { Zip, ZipDeflate } from "fflate";
import { booksPackageDocuments } from "../books-package-document";
import { documentCsv } from "../report-document";
import type { BooksPackageSnapshot } from "../books-package";

/** Sequential generation bounds memory and preserves stream backpressure. */
export async function* booksPackageFiles(
  snapshot: BooksPackageSnapshot,
  includePdf = true,
): AsyncGenerator<{ name: string; bytes: Uint8Array }> {
  const documents = booksPackageDocuments(snapshot),
    p = snapshot.payload;
  const manifest: { name: string; sha256: string; bytes: number }[] = [],
    skipped: string[] = [];
  let total = 0,
    pdfRows = 0;
  const file = (name: string, bytes: string | Uint8Array) => {
    const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    total += data.length;
    if (total > 200_000_000)
      throw new Error(
        "This review package exceeds 200 MB. Export its individual reports or use the recovery runner.",
      );
    manifest.push({
      name,
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
    });
    return { name, bytes: data };
  };
  for (const { id, document } of documents) {
    yield file(`csv/${id}.csv`, documentCsv(document));
    if (
      includePdf &&
      id !== "source-document-index" &&
      document.rows.length <= 1500 &&
      pdfRows + document.rows.length <= 6000
    ) {
      pdfRows += document.rows.length;
      yield file(
        `pdf/${id}.pdf`,
        await (await import("./report-pdf")).reportPdf(document),
      );
    } else skipped.push(id);
  }
  yield file("retained-package.json", JSON.stringify(snapshot, null, 2) + "\n");
  yield file(
    "README.txt",
    [
      `${p.core.legal_name}: ${p.year} books review package`,
      `Period: ${p.core.filter.from} through ${p.through}`,
      `Snapshot: ${snapshot.id}`,
      `Book revision: ${snapshot.revision}`,
      `Retained: ${snapshot.created_at}`,
      "",
      ...p.notes,
      "",
      "Review items at capture:",
      ...(p.review_items.length
        ? p.review_items.map((item) => `- ${item.message}`)
        : [
            "No package review items were recorded. This is not a certification of a tax return.",
          ]),
      "",
      `PDFs omitted for these detailed schedules (complete CSV is included): ${skipped.join(", ") || "none"}.`,
      "PDF limits: 1,500 rows per schedule and 6,000 rows across the package. CSV and retained JSON preserve the full supported scope.",
      "manifest.json lists SHA-256 hashes of the included files. This ZIP contains sensitive company data and is not encrypted. Share it deliberately through a secure channel.",
    ].join("\n") + "\n",
  );
  yield {
    name: "manifest.json",
    bytes: Buffer.from(
      JSON.stringify(
        {
          format: "valiance-books-review-package",
          version: 1,
          snapshot_id: snapshot.id,
          financial_revision: snapshot.revision,
          year: p.year,
          through: p.through,
          created_at: snapshot.created_at,
          files: manifest,
        },
        null,
        2,
      ) + "\n",
    ),
  };
}
export async function* booksPackageZip(
  snapshot: BooksPackageSnapshot,
  includePdf = true,
): AsyncGenerator<Uint8Array> {
  let chunks: Uint8Array[] = [],
    failure: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) failure = error;
    else chunks.push(data);
  });
  try {
    for await (const file of booksPackageFiles(snapshot, includePdf)) {
      const entry = new ZipDeflate(file.name, { level: 6 });
      entry.mtime = new Date(snapshot.created_at);
      zip.add(entry);
      for (let offset = 0; offset < file.bytes.length; offset += 262144) {
        entry.push(
          file.bytes.subarray(offset, offset + 262144),
          offset + 262144 >= file.bytes.length,
        );
        if (failure) throw failure;
        const ready = chunks;
        chunks = [];
        for (const chunk of ready) yield chunk;
      }
      if (file.bytes.length === 0) entry.push(new Uint8Array(), true);
    }
    zip.end();
    if (failure) throw failure;
    for (const chunk of chunks) yield chunk;
  } finally {
    zip.terminate();
  }
}
