/**
 * Flat CSV for spreadsheets: a byte order mark so Excel reads UTF-8, every
 * cell quoted, and a leading apostrophe on anything a spreadsheet would
 * otherwise evaluate as a formula. Nested values are written as JSON.
 */
export type CsvRow = Record<string, unknown>;

function cell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  if (/^\s*[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows: CsvRow[], columns?: string[]): string {
  const keys =
    columns ??
    Array.from(
      rows.reduce((set, row) => {
        for (const key of Object.keys(row)) set.add(key);
        return set;
      }, new Set<string>()),
    );
  const lines = [keys.map(cell).join(",")];
  for (const row of rows) lines.push(keys.map((k) => cell(row[k])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Cents as a signed decimal string for spreadsheets. */
export function centsToAmount(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const cents = typeof value === "bigint" ? value : BigInt(String(value));
  const negative = cents < BigInt(0);
  const abs = negative ? -cents : cents;
  const whole = abs / BigInt(100);
  const fraction = (abs % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
