import { strFromU8, unzipSync } from "fflate";

/**
 * A small, strict reader for the plain .xlsx workbooks payroll providers
 * export: it unzips only the parts it needs, refuses oversized parts before
 * inflating them, and returns each sheet as rows of raw cell text (numbers
 * and dates stay as the stored number, so callers decide what a column
 * means). Formulas, styles and rich formatting are ignored.
 */
export interface XlsxWorkbook {
  /** Dates are stored as days since 1904-01-01 instead of 1899-12-30. */
  date1904: boolean;
  /** Sheet name to rows; a row is its cells by column, blanks as "". */
  sheets: Map<string, string[][]>;
}

export interface XlsxLimits {
  /** Largest inflated size of any one part, in bytes. */
  partBytes: number;
  /** Largest inflated size of all parts read, in bytes. */
  totalBytes: number;
  /** Most rows in any one sheet. */
  rows: number;
  /** Most columns in any one row. */
  columns: number;
}

const DEFAULT_LIMITS: XlsxLimits = {
  partBytes: 10_000_000,
  totalBytes: 25_000_000,
  rows: 20_000,
  columns: 64,
};

const NOT_A_WORKBOOK = "This file is not an Excel workbook (.xlsx).";

function decode(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (_, entity: string) => {
      if (entity === "amp") return "&";
      if (entity === "lt") return "<";
      if (entity === "gt") return ">";
      if (entity === "quot") return '"';
      if (entity === "apos") return "'";
      const code =
        entity[1] === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    },
  );
}

/** The text runs of a shared or inline string, without phonetic hints. */
function textOf(xml: string): string {
  return [
    ...xml
      .replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
      .matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g),
  ]
    .map((m) => decode(m[1] ?? ""))
    .join("");
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** "AB" to 27; columns are 0-based in the returned rows. */
function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters)
    index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function resolveTarget(target: string): string {
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

/**
 * Reads the named sheets (and only those) from an .xlsx file. Sheets the
 * workbook does not have are simply absent from the result.
 */
export function readXlsx(
  bytes: Uint8Array,
  wanted: readonly string[],
  limits: Partial<XlsxLimits> = {},
): XlsxWorkbook {
  const limit = { ...DEFAULT_LIMITS, ...limits };
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  )
    throw new Error(NOT_A_WORKBOOK);
  let total = 0;
  const unzip = (filter: (name: string) => boolean) => {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (file) => {
          if (!filter(file.name)) return false;
          if (file.originalSize > limit.partBytes)
            throw new Error("This workbook is too large to import.");
          total += file.originalSize;
          if (total > limit.totalBytes)
            throw new Error("This workbook is too large to import.");
          return true;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("This workbook"))
        throw error;
      throw new Error(NOT_A_WORKBOOK);
    }
    for (const [name, data] of Object.entries(files))
      if (data.length > limit.partBytes)
        throw new Error(`This workbook is too large to import (${name}).`);
    return files;
  };
  const text = (data: Uint8Array | undefined) => {
    if (!data) return undefined;
    try {
      return strFromU8(data);
    } catch {
      throw new Error(NOT_A_WORKBOOK);
    }
  };
  const meta = unzip(
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name === "xl/sharedStrings.xml",
  );
  const workbook = text(meta["xl/workbook.xml"]);
  const rels = text(meta["xl/_rels/workbook.xml.rels"]);
  if (!workbook || !rels) throw new Error(NOT_A_WORKBOOK);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(m[0], "Id");
    const target = attribute(m[0], "Target");
    if (id && target) targets.set(id, resolveTarget(decode(target)));
  }
  const paths = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attribute(m[0], "name");
    const id = attribute(m[0], "r:id");
    if (name && id && targets.has(id) && wanted.includes(decode(name)))
      paths.set(decode(name), targets.get(id)!);
  }
  const shared = [
    ...(text(meta["xl/sharedStrings.xml"]) ?? "").matchAll(
      /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g,
    ),
  ].map((m) => textOf(m[1] ?? ""));
  const wantedPaths = new Set(paths.values());
  const parts = unzip((name) => wantedPaths.has(name));
  const sheets = new Map<string, string[][]>();
  for (const [name, path] of paths) {
    const xml = text(parts[path]);
    if (xml === undefined) throw new Error(NOT_A_WORKBOOK);
    const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
    const rows: string[][] = [];
    let rowNumber = 0;
    for (const row of (data?.[1] ?? "").matchAll(
      /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,
    )) {
      const declared = Number(attribute(row[1], "r"));
      rowNumber =
        Number.isInteger(declared) && declared > rowNumber
          ? declared
          : rowNumber + 1;
      if (rowNumber > limit.rows)
        throw new Error(
          `The ${name} sheet has more than ${limit.rows.toLocaleString("en-US")} rows.`,
        );
      const cells: string[] = [];
      let column = -1;
      for (const cell of (row[2] ?? "").matchAll(
        /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
      )) {
        const ref = /^([A-Z]{1,3})\d*$/.exec(attribute(cell[1], "r") ?? "");
        column = ref ? columnIndex(ref[1]) : column + 1;
        if (column >= limit.columns)
          throw new Error(
            `The ${name} sheet has more than ${limit.columns} columns.`,
          );
        const type = attribute(cell[1], "t") ?? "n";
        const body = cell[2] ?? "";
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") {
          const index = Number(raw);
          if (!Number.isInteger(index) || index < 0 || index >= shared.length)
            throw new Error(NOT_A_WORKBOOK);
          value = shared[index];
        } else if (type === "inlineStr")
          value = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else if (type === "e")
          throw new Error(
            `The ${name} sheet has a cell with an error (${decode(raw ?? "")}). Export the report again.`,
          );
        else value = decode(raw ?? "");
        while (cells.length < column) cells.push("");
        cells[column] = value.trim();
      }
      while (rows.length < rowNumber - 1) rows.push([]);
      rows.push(cells);
    }
    sheets.set(name, rows);
  }
  return { date1904, sheets };
}

/** An Excel serial day number (or an ISO or US date string) to YYYY-MM-DD. */
export function xlsxDate(value: string, date1904: boolean): string | null {
  const text = value.trim();
  let iso: string | null = null;
  if (/^\d+(\.0+)?$/.test(text)) {
    const serial = Number(text);
    // 60 is Excel's fictional 1900-02-29; real export dates are far later.
    if (serial < 61 || serial > 2958465) return null;
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    iso = new Date(epoch + serial * 86_400_000).toISOString().slice(0, 10);
  } else {
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (isoMatch) iso = text;
    else if (usMatch)
      iso = `${usMatch[3]}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
    else return null;
    if (
      Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ||
      new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) !== iso
    )
      return null;
  }
  const year = Number(iso.slice(0, 4));
  return year >= 1900 && year <= 2100 ? iso : null;
}
