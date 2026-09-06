import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@/lib/supabase/server";
import { localAccountingTestClient } from "./local-test-client";

export function documentMime(bytes: Uint8Array, name: string): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (name.toLowerCase().endsWith(".csv")) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return "text/csv";
  }
  throw new Error("Use a PDF, PNG, JPEG, WebP, or UTF-8 CSV file.");
}
function validatedPath(value: string) {
  if (!/^[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid evidence path.");
  return value;
}
function fixtureRoot() {
  return path.join(
    process.env.LOCALAPPDATA ?? process.cwd(),
    "CodexAccountingTest",
    "evidence",
  );
}
export async function storeDocument(
  key: string,
  bytes: Uint8Array,
  mime: string,
) {
  validatedPath(key);
  if (localAccountingTestClient()) {
    const location = path.join(fixtureRoot(), ...key.split("/"));
    await mkdir(path.dirname(location), { recursive: true });
    try {
      await writeFile(location, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const saved = await readFile(location);
      if (!saved.equals(Buffer.from(bytes)))
        throw new Error("Stored evidence differs from this upload.");
    }
    return;
  }
  const client = await createClient();
  const { error } = await client.storage
    .from("accounting-private")
    .upload(key, bytes, {
      contentType: mime,
      upsert: false,
      cacheControl: "0",
    });
  if (error) {
    const saved = await loadDocument(key);
    if (
      createHash("sha256").update(saved).digest("hex") !==
      createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Evidence upload failed. Retry the same file.");
  }
}
export async function loadDocument(key: string): Promise<Uint8Array> {
  validatedPath(key);
  if (localAccountingTestClient())
    return readFile(path.join(fixtureRoot(), ...key.split("/")));
  const client = await createClient();
  const { data, error } = await client.storage
    .from("accounting-private")
    .download(key);
  if (error || !data) throw new Error("Evidence file is unavailable.");
  return new Uint8Array(await data.arrayBuffer());
}
