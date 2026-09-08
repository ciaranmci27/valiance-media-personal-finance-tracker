import Papa from "papaparse";
import { dateSchema } from "./contracts";
import { parseUsd } from "./money";
export const loanScheduleFields = [
  "date",
  "principal",
  "interest",
  "fee",
  "payment",
] as const;
export type LoanScheduleMapping = Record<
  (typeof loanScheduleFields)[number],
  string
>;
export interface LoanScheduleTable {
  headers: string[];
  rows: string[][];
}
export interface LoanScheduleProposal {
  row: number;
  date: string;
  principal: string;
  interest: string;
  fee: string;
  payment: string;
  signature: string;
  error: string;
}
export function readLoanSchedule(text: string): LoanScheduleTable {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
    throw new Error("Choose a CSV smaller than 2 MB.");
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    delimiter: ",",
    dynamicTyping: false,
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length)
    throw new Error(`CSV could not be read: ${parsed.errors[0].message}`);
  const headers = (parsed.data[0] ?? []).map((h) => h.trim());
  if (
    !headers.length ||
    headers.some((h) => !h) ||
    new Set(headers).size !== headers.length
  )
    throw new Error("The first row must contain unique column names.");
  const rows = parsed.data.slice(1);
  if (!rows.length || rows.length > 1000)
    throw new Error("Choose a schedule with 1 to 1,000 payment rows.");
  if (rows.some((r) => r.length !== headers.length))
    throw new Error(
      "Every row must have the same number of columns as the header.",
    );
  return { headers, rows };
}
export function proposeLoanSchedule(
  table: LoanScheduleTable,
  mapping: LoanScheduleMapping,
): LoanScheduleProposal[] {
  if (
    loanScheduleFields.some((f) => !table.headers.includes(mapping[f])) ||
    new Set(Object.values(mapping)).size !== loanScheduleFields.length
  )
    throw new Error(
      "Map a separate column for each field. Enter an explicit zero for fees or interest that do not apply.",
    );
  const seen = new Set<string>();
  return table.rows.map((row, index) => {
    const result: LoanScheduleProposal = {
      row: index + 2,
      date: "",
      principal: "0",
      interest: "0",
      fee: "0",
      payment: "0",
      signature: "",
      error: "",
    };
    try {
      const value = (field: keyof LoanScheduleMapping) =>
        row[table.headers.indexOf(mapping[field])].trim();
      const date = dateSchema.safeParse(value("date"));
      if (!date.success) throw new Error("Use a valid YYYY-MM-DD date.");
      result.date = date.data;
      for (const f of ["principal", "interest", "fee", "payment"] as const) {
        const amount = parseUsd(value(f));
        if (amount < BigInt(0) || amount > BigInt("999999999999999999"))
          throw new Error(
            "Amounts must be nonnegative USD values within the supported range.",
          );
        result[f] = amount.toString();
      }
      if (
        BigInt(result.payment) <= BigInt(0) ||
        BigInt(result.principal) +
          BigInt(result.interest) +
          BigInt(result.fee) !==
          BigInt(result.payment)
      )
        throw new Error(
          "Principal, interest and fees must exactly equal the payment.",
        );
      result.signature = [
        result.date,
        result.principal,
        result.interest,
        result.fee,
      ].join("|");
      if (seen.has(result.signature))
        throw new Error(
          "This payment is repeated in the schedule. Review the duplicate before recording it.",
        );
      seen.add(result.signature);
    } catch (e) {
      result.error = (e as Error).message;
    }
    return result;
  });
}
