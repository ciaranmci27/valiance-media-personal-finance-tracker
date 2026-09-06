import Papa from "papaparse";
import { createHash } from "node:crypto";
import { parseUsd } from "../money";
import { dateSchema } from "../contracts";

export interface CsvOptions {
  delimiter: "," | ";" | "\t";
  headerRow: number;
  dateFormat: "yyyy-mm-dd" | "mm/dd/yyyy" | "dd/mm/yyyy";
  decimal: "." | ",";
  thousands: "" | "," | "." | " ";
}
export interface CsvTable {
  headers: string[];
  rows: string[][];
  fileHash: string;
}
export interface JournalMapping {
  group: string;
  date: string;
  memo: string;
  account: string;
  debit?: string;
  credit?: string;
  amount?: string;
  lineMemo?: string;
  stableGroupIds: boolean;
  accounts: Record<string, string>;
}
export interface BankMapping {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  externalId?: string;
  sign: "deposits_positive" | "withdrawals_positive";
  accountId: string;
}
export interface ParsedImportGroup {
  external_id: string;
  identity_kind: "provider_id" | "fingerprint_multiplicity";
  fingerprint: string;
  source_hash?: string;
  entry_date: string;
  memo: string;
  lines: { account_id: string; amount_cents: string; memo: string }[];
  bank_account_id?: string;
  bank_amount_cents?: string;
  raw: Record<string, string>[];
  errors: string[];
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function readCsv(text: string, options: CsvOptions): CsvTable {
  if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024)
    throw new Error(
      "Files are limited to 20 MB. Split larger exports by year.",
    );
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    delimiter: options.delimiter,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  if (parsed.errors.length)
    throw new Error(
      `CSV row ${(parsed.errors[0].row ?? 0) + 1}: ${parsed.errors[0].message}`,
    );
  if (
    !Number.isInteger(options.headerRow) ||
    options.headerRow < 0 ||
    options.headerRow > 50 ||
    !parsed.data[options.headerRow]
  )
    throw new Error("Choose a valid header row.");
  const headers = parsed.data[options.headerRow].map((h) => h.trim());
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
    throw new Error(
      "Headers must be nonempty and unique. Choose the row containing the column names.",
    );
  const rows = parsed.data.slice(options.headerRow + 1);
  if (!rows.length || rows.length > 50000)
    throw new Error("Provide 1 to 50,000 data rows per import.");
  const malformed = rows.findIndex((r) => r.length !== headers.length);
  if (malformed >= 0)
    throw new Error(
      `Row ${malformed + options.headerRow + 2} has a different column count from the header.`,
    );
  return { headers, rows, fileHash: hash(text) };
}
export function csvDate(
  value: string,
  format: CsvOptions["dateFormat"],
): string {
  const s = value.trim();
  let iso = s;
  if (format !== "yyyy-mm-dd") {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!match) throw new Error(`Date "${s}" does not match ${format}.`);
    const month = format === "mm/dd/yyyy" ? match[1] : match[2];
    const day = format === "mm/dd/yyyy" ? match[2] : match[1];
    iso = `${match[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = dateSchema.safeParse(iso);
  if (!parsed.success) throw new Error(`Invalid accounting date "${s}".`);
  return parsed.data;
}
export function csvAmount(
  value: string,
  options: Pick<CsvOptions, "decimal" | "thousands">,
): bigint {
  let s = value.trim();
  if (!s) return BigInt(0);
  if (options.thousands === options.decimal)
    throw new Error("Decimal and thousands separators must differ.");
  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);
  if (options.thousands) {
    const [whole] = s.split(options.decimal);
    const unsigned = whole.replace(/^-/, "");
    if (unsigned.includes(options.thousands)) {
      const groups = unsigned.split(options.thousands);
      if (
        !/^\d{1,3}$/.test(groups[0]) ||
        groups.slice(1).some((g) => !/^\d{3}$/.test(g))
      )
        throw new Error(`Invalid thousands grouping "${value}".`);
    }
    s = s.split(options.thousands).join("");
  }
  if (options.decimal === ",") s = s.replace(",", ".");
  const amount = parseUsd(s);
  if (negative && amount < BigInt(0))
    throw new Error("Do not combine parentheses and a negative sign.");
  return negative ? -amount : amount;
}
function accessor(table: CsvTable, row: string[]) {
  return (column: string | undefined) => {
    if (!column) return "";
    const i = table.headers.indexOf(column);
    if (i < 0) throw new Error(`Column "${column}" is missing.`);
    return row[i].trim();
  };
}
function rawRow(table: CsvTable, row: string[]) {
  return Object.fromEntries(table.headers.map((h, i) => [h, row[i]]));
}
function fingerprint(
  group: Pick<
    ParsedImportGroup,
    "entry_date" | "memo" | "lines" | "bank_account_id" | "bank_amount_cents"
  >,
) {
  return hash(
    JSON.stringify({
      date: group.entry_date,
      memo: group.memo,
      bank: group.bank_account_id,
      amount: group.bank_amount_cents,
      lines: [...group.lines].sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b)
          ? -1
          : JSON.stringify(a) > JSON.stringify(b)
            ? 1
            : 0,
      ),
    }),
  );
}
function identities(groups: ParsedImportGroup[]) {
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const group of groups) {
    group.fingerprint = fingerprint(group);
    group.source_hash = hash(
      JSON.stringify(
        group.raw
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            ),
          )
          .map((row) => JSON.stringify(row))
          .sort(),
      ),
    );
    if (group.identity_kind === "fingerprint_multiplicity") {
      const n = (counts.get(group.fingerprint) ?? 0) + 1;
      counts.set(group.fingerprint, n);
      group.external_id = `${group.fingerprint}:${n}`;
    }
    if (ids.has(group.external_id))
      group.errors.push(
        "This source identity occurs more than once. Verify grouping or the source ID mapping.",
      );
    ids.add(group.external_id);
  }
  return groups;
}
export function journalGroups(
  table: CsvTable,
  options: CsvOptions,
  mapping: JournalMapping,
): ParsedImportGroup[] {
  if (!mapping.group)
    throw new Error(
      "A journal grouping column is required. Date and memo alone cannot identify separate journal entries.",
    );
  if (Boolean(mapping.amount) === Boolean(mapping.debit || mapping.credit))
    throw new Error("Choose signed amounts or debit/credit columns, not both.");
  const groups = new Map<string, ParsedImportGroup>();
  table.rows.forEach((row, index) => {
    const get = accessor(table, row);
    const groupId = get(mapping.group);
    if (!groupId)
      throw new Error(
        `Row ${index + options.headerRow + 2} has no journal group.`,
      );
    let group = groups.get(groupId);
    if (!group) {
      group = {
        external_id: groupId,
        identity_kind: mapping.stableGroupIds
          ? "provider_id"
          : "fingerprint_multiplicity",
        fingerprint: "",
        entry_date: "",
        memo: get(mapping.memo) || "Imported journal",
        lines: [],
        raw: [],
        errors: [],
      };
      groups.set(groupId, group);
    }
    group.raw.push(rawRow(table, row));
    if (get(mapping.memo) && get(mapping.memo) !== group.memo)
      group.errors.push(
        "Journal group memos differ. Map a shared journal memo and put line descriptions in the line memo field.",
      );
    try {
      const date = csvDate(get(mapping.date), options.dateFormat);
      if (group.entry_date && group.entry_date !== date)
        throw new Error("A journal group contains multiple financial dates.");
      group.entry_date = date;
      const sourceAccount = get(mapping.account);
      const account = mapping.accounts[sourceAccount];
      if (!account)
        throw new Error(`Map account "${sourceAccount}" before applying.`);
      const debit = mapping.amount
        ? csvAmount(get(mapping.amount), options)
        : csvAmount(get(mapping.debit), options);
      const credit = mapping.amount
        ? BigInt(0)
        : csvAmount(get(mapping.credit), options);
      if (
        !mapping.amount &&
        (debit < BigInt(0) ||
          credit < BigInt(0) ||
          (debit > BigInt(0) && credit > BigInt(0)))
      )
        throw new Error("Use one positive debit or credit per source line.");
      const amount = debit - credit;
      if (amount === BigInt(0)) return;
      group.lines.push({
        account_id: account,
        amount_cents: amount.toString(),
        memo: get(mapping.lineMemo),
      });
    } catch (e) {
      group.errors.push(
        `Row ${index + options.headerRow + 2}: ${e instanceof Error ? e.message : "Invalid row."}`,
      );
    }
  });
  for (const g of groups.values()) {
    if (g.lines.length < 2 || g.lines.length > 100)
      g.errors.push("Journal groups require 2 to 100 nonzero lines.");
    if (
      g.lines.reduce((sum, l) => sum + BigInt(l.amount_cents), BigInt(0)) !==
      BigInt(0)
    )
      g.errors.push(
        "Debits and credits do not balance. No balancing line was invented.",
      );
  }
  return identities([...groups.values()]);
}
export function bankGroups(
  table: CsvTable,
  options: CsvOptions,
  mapping: BankMapping,
): ParsedImportGroup[] {
  if (Boolean(mapping.amount) === Boolean(mapping.debit || mapping.credit))
    throw new Error(
      "Choose signed amounts or withdrawal/deposit columns, not both.",
    );
  return identities(
    table.rows.map((row, index) => {
      const get = accessor(table, row);
      const group: ParsedImportGroup = {
        external_id: get(mapping.externalId),
        identity_kind: mapping.externalId
          ? "provider_id"
          : "fingerprint_multiplicity",
        fingerprint: "",
        entry_date: "",
        memo: get(mapping.description) || "Imported bank movement",
        lines: [],
        bank_account_id: mapping.accountId,
        raw: [rawRow(table, row)],
        errors: [],
      };
      try {
        group.entry_date = csvDate(get(mapping.date), options.dateFormat);
        let amount: bigint;
        if (mapping.amount) {
          amount = csvAmount(get(mapping.amount), options);
          if (mapping.sign === "withdrawals_positive") amount = -amount;
        } else {
          const withdrawal = csvAmount(get(mapping.debit), options),
            deposit = csvAmount(get(mapping.credit), options);
          if (
            withdrawal < BigInt(0) ||
            deposit < BigInt(0) ||
            (withdrawal > BigInt(0) && deposit > BigInt(0))
          )
            throw new Error("Use one positive withdrawal or deposit per row.");
          amount = deposit - withdrawal;
        }
        if (amount === BigInt(0))
          throw new Error("Zero-value rows do not represent a bank movement.");
        group.bank_amount_cents = amount.toString();
        if (mapping.externalId && !group.external_id)
          throw new Error("A mapped source transaction ID is missing.");
      } catch (e) {
        group.errors.push(
          `Row ${index + options.headerRow + 2}: ${e instanceof Error ? e.message : "Invalid row."}`,
        );
      }
      return group;
    }),
  );
}
/** Spreadsheet programs must not evaluate provider descriptions as formulas. */
export function safeCsvCell(value: string): string {
  return /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
}
