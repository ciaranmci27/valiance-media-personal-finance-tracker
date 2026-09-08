import Papa from "papaparse";
import { createHash } from "node:crypto";
import {
  csvAmount,
  csvDate,
  type ParsedImportGroup,
  type CsvTable,
} from "./csv";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface WaveAccount {
  id: string;
  type: string;
  subtype: string;
  external_names: { wave?: string };
}
export interface WaveImportRow extends ParsedImportGroup {
  kind: "opening" | "manual";
  exclusion_reason?: string;
}
const required = [
  "Transaction ID",
  "Transaction Date",
  "Account Name",
  "Transaction Description",
  "Transaction Line Description",
  "Debit Amount (Two Column Approach)",
  "Credit Amount (Two Column Approach)",
  "Account Group",
  "Account Type",
  "Account ID",
];
export function isWaveLedger(text: string) {
  const header =
    Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { preview: 1 }).data[0] ??
    [];
  return required.every((name) => header.includes(name));
}
export function readWaveCsv(text: string): CsvTable {
  if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024)
    throw new Error("Wave exports must be at most 20 MB.");
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  if (
    parsed.errors.length ||
    parsed.data.length < 2 ||
    parsed.data.length > 50001
  )
    throw new Error("Provide a valid Wave ledger with 1 to 50,000 data rows.");
  const [headers, ...rows] = parsed.data;
  if (
    required.some((name) => !headers.includes(name)) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("Wave ledger headers are missing or duplicated.");
  if (rows.some((row) => row.length !== headers.length))
    throw new Error("A Wave row has an unexpected column count.");
  return {
    headers,
    rows,
    fileHash: createHash("sha256").update(text).digest("hex"),
  };
}
/** Reads caller-supplied bytes only. Never reads the owner's export directory. */
export function waveJournalRows(
  text: string,
  accounts: WaveAccount[],
  earliestDate = "2022-12-31",
): WaveImportRow[] {
  // Wave intentionally includes a literal blank separator header. Preserve it in raw history.
  const { headers, rows } = readWaveCsv(text);
  const mapping = new Map<string, WaveAccount>();
  for (const account of accounts) {
    const name = account.external_names.wave;
    if (!name) continue;
    if (mapping.has(name))
      throw new Error(
        "A Wave account name maps to more than one book account.",
      );
    mapping.set(name, account);
  }
  const groups = new Map<string, WaveImportRow>();
  rows.forEach((values, index) => {
    if (values.length !== headers.length)
      throw new Error(`Wave row ${index + 2} has an unexpected column count.`);
    const raw = Object.fromEntries(headers.map((name, i) => [name, values[i]]));
    const externalId = raw["Transaction ID"].trim();
    if (!externalId)
      throw new Error(`Wave row ${index + 2} has no transaction ID.`);
    const date = csvDate(raw["Transaction Date"], "yyyy-mm-dd");
    if (date < earliestDate)
      throw new Error(
        `Wave row ${index + 2} predates the books history boundary.`,
      );
    const memo = raw["Transaction Description"] || "Imported journal";
    let group = groups.get(externalId);
    if (!group) {
      group = {
        external_id: externalId,
        identity_kind: "provider_id",
        fingerprint: "",
        entry_date: date,
        memo,
        kind: date === earliestDate ? "opening" : "manual",
        lines: [],
        raw: [],
        errors: [],
      };
      groups.set(externalId, group);
    }
    group.raw.push(raw);
    if (group.entry_date !== date || group.memo !== memo)
      group.errors.push(
        "The source group has inconsistent dates or descriptions.",
      );
    const account = mapping.get(raw["Account Name"]);
    const sourceType = raw["Account Group"].trim().toLowerCase();
    if (!account) {
      group.errors.push("A source account has no external_names.wave mapping.");
      return;
    }
    if (account.type !== sourceType)
      group.errors.push("The mapped financial account type differs from Wave.");
    if (
      raw["Account Type"] === "Receivable" &&
      account.subtype !== "receivable"
    )
      group.errors.push(
        "Preserve the receivable subtype; collections must not become income.",
      );
    if (
      raw["Account Type"] === "Payable" &&
      !["payroll_liability", "other"].includes(account.subtype)
    )
      group.errors.push("Preserve the payroll clearing liability subtype.");
    const debit = csvAmount(raw["Debit Amount (Two Column Approach)"], {
      decimal: ".",
      thousands: ",",
    });
    const credit = csvAmount(raw["Credit Amount (Two Column Approach)"], {
      decimal: ".",
      thousands: ",",
    });
    if (
      debit < BigInt("0") ||
      credit < BigInt("0") ||
      (debit > BigInt("0") && credit > BigInt("0"))
    )
      throw new Error(
        `Wave row ${index + 2} must contain one nonnegative debit or credit.`,
      );
    const amount = debit - credit;
    if (amount !== BigInt("0"))
      group.lines.push({
        account_id: account.id,
        amount_cents: amount.toString(),
        memo: raw["Transaction Line Description"],
      });
  });
  return [...groups.values()].map((group) => {
    if (!group.lines.length && !group.errors.length && group.kind === "opening")
      group.exclusion_reason =
        "Zero-valued opening group retained as source history; no journal entry created.";
    else if (group.lines.length < 2)
      group.errors.push(
        "A financial journal requires at least two nonzero lines.",
      );
    if (
      group.lines.reduce(
        (sum, line) => sum + BigInt(line.amount_cents),
        BigInt("0"),
      ) !== BigInt("0")
    )
      group.errors.push(
        "The source journal does not balance. No balancing line was invented.",
      );
    group.fingerprint = digest({
      date: group.entry_date,
      memo: group.memo,
      lines: group.lines.map((line) => JSON.stringify(line)).sort(),
    });
    group.source_hash = digest(
      group.raw
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(
              Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
            ),
          ),
        )
        .sort(),
    );
    return group;
  });
}

/** Proposed classifications need owner account mapping before any import applies. */
export function waveAccountProposals(text: string) {
  const parsed = Papa.parse<Record<string, string>>(
    text.replace(/^\uFEFF/, ""),
    { header: true, skipEmptyLines: "greedy", dynamicTyping: false },
  );
  if (parsed.errors.length) throw new Error("Invalid Wave ledger CSV.");
  const accounts = new Map<
    string,
    {
      name: string;
      type: string;
      subtype: string;
      external_names: { wave: string };
    }
  >();
  for (const row of parsed.data) {
    const name = row["Account Name"],
      type = row["Account Group"]?.trim().toLowerCase(),
      sourceType = row["Account Type"];
    if (
      !name ||
      !type ||
      !["asset", "liability", "equity", "income", "expense"].includes(type)
    )
      throw new Error("Wave account classification is missing or unsupported.");
    const subtype =
      sourceType === "Receivable"
        ? "receivable"
        : sourceType === "Payable"
          ? /payroll|tax/i.test(name)
            ? "payroll_liability"
            : "other"
          : sourceType === "Cash and Bank"
            ? "bank"
            : sourceType === "Credit Card"
              ? "card"
              : sourceType === "Retained Earnings: Profit"
                ? "retained_earnings"
                : sourceType === "Cost of Goods Sold"
                  ? "cost_of_goods_sold"
                  : type === "income"
                    ? "revenue"
                    : type === "expense"
                      ? "operating_expense"
                      : "other";
    const existing = accounts.get(name);
    if (existing && (existing.type !== type || existing.subtype !== subtype))
      throw new Error(
        "A Wave account name has inconsistent financial classifications.",
      );
    accounts.set(name, { name, type, subtype, external_names: { wave: name } });
  }
  return [...accounts.values()];
}

/** Report metadata determines the period. Filenames have no accounting meaning. */
export function waveReportControls(
  text: string,
  earliestHistoryDate = "2022-12-31",
) {
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  if (parsed.errors.length) throw new Error("Invalid Wave report CSV.");
  const cells = parsed.data.flat();
  const range = cells.find((cell) => cell.startsWith("Date Range:"));
  const asOf = cells.find((cell) => cell.startsWith("As of "));
  const basis = cells.find((cell) => cell.startsWith("Report Type:"));
  const dates = (range || asOf || "").match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (!basis || (range ? dates.length !== 2 : dates.length !== 1))
    throw new Error("Wave report period and basis metadata are required.");
  const from = csvDate(dates[0]!, "yyyy-mm-dd"),
    to = csvDate(dates.at(-1)!, "yyyy-mm-dd");
  if (from > to || from.slice(0, 4) !== to.slice(0, 4))
    throw new Error("Wave parity controls must cover one calendar year.");
  const totals = new Map<string, bigint>();
  for (const row of parsed.data) {
    if (
      row.length !== 3 ||
      !/^(total |net profit|gross profit)/i.test(row[1].trim()) ||
      !row[2].trim()
    )
      continue;
    const label = row[1].trim().toLowerCase();
    if (totals.has(label)) throw new Error("Duplicate Wave report total.");
    totals.set(
      label,
      csvAmount(row[2].replace(/\$/g, ""), { decimal: ".", thousands: "," }),
    );
  }
  const requiredTotal = (label: string) => {
    const amount = totals.get(label);
    if (amount === undefined)
      throw new Error(`Wave report is missing ${label}.`);
    return amount;
  };
  const expected: Record<string, string> = range
    ? {
        income_cents: requiredTotal("total income").toString(),
        cost_of_goods_sold_cents: requiredTotal(
          "total cost of goods sold",
        ).toString(),
        gross_profit_cents: requiredTotal("gross profit").toString(),
        operating_expense_cents: requiredTotal(
          "total operating expenses",
        ).toString(),
        expense_cents: (
          requiredTotal("total cost of goods sold") +
          requiredTotal("total operating expenses")
        ).toString(),
        net_income_cents: requiredTotal("net profit").toString(),
      }
    : {
        assets_cents: requiredTotal("total assets").toString(),
        liabilities_cents: requiredTotal("total liabilities").toString(),
        equity_total_cents: requiredTotal("total equity").toString(),
      };
  return {
    fiscal_year: Number(to.slice(0, 4)),
    kind:
      !range && to === earliestHistoryDate
        ? ("opening_balances" as const)
        : ("annual_totals" as const),
    report_kind: range ? ("profit_loss" as const) : ("balance_sheet" as const),
    from:
      !range && to !== earliestHistoryDate ? `${to.slice(0, 4)}-01-01` : from,
    to,
    expected,
    source_report_type: basis.slice("Report Type:".length).trim(),
    // Owner-designated parity basis. Preserve the source label instead of claiming a cash export.
    basis: "cash" as const,
  };
}
