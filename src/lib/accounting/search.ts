import type { JournalEntry } from "./contracts";
import { centsToDecimal, formatCents, readCents } from "./money";

/**
 * The ledger search, as the database runs it (`accounting.search_terms` and
 * the query clause of `accounting.transactions`), mirrored here for the demo
 * books and for tests. Every term must match somewhere on the entry: the
 * description, the bank descriptor, the kind, the date in four spellings,
 * the contact, each line's category, memo and amount, and the bank
 * institution and card mask behind a cash account. Quoted words search as
 * one phrase; an amount matches a line or the entry total; > and < compare
 * the total.
 */
export type SearchTerm =
  | { kind: "text"; text: string }
  /** `text` is the plain number (no sign, $ or commas), matched on digit boundaries. */
  | { kind: "amount" | "dollars"; text: string; cents: bigint }
  | {
      kind: "compare";
      text: string;
      cents: bigint;
      op: ">" | ">=" | "<" | "<=";
    };

const TERM = /"([^"]*)"|(\S+)/g;
const NUMBER = /^([<>]=?|[-+])?\$?(\d{1,3}(,\d{3})+|\d{1,15})(\.\d{1,2})?$/;
const HUNDRED = BigInt(100);
const LIMIT = 12;

export function parseSearchTerms(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  let ordinal = 0;
  for (const match of query.slice(0, 200).matchAll(TERM)) {
    if (++ordinal > LIMIT) break;
    const text = (match[1] ?? match[2] ?? "")
      .replace(/^[ "]+|[ "]+$/g, "")
      .toLowerCase();
    if (!text) continue;
    if (!NUMBER.test(text)) {
      terms.push({ kind: "text", text });
      continue;
    }
    const op = /^([<>]=?)/.exec(text)?.[1] as SearchTerm extends {
      op: infer O;
    }
      ? O
      : never;
    const number = text.replace(/^([<>]=?|[-+])?\$?/, "").replace(/,/g, "");
    const [whole, fraction = ""] = number.split(".");
    const cents =
      BigInt(whole) * HUNDRED + BigInt(fraction.padEnd(2, "0").slice(0, 2));
    if (op) terms.push({ kind: "compare", text: number, cents, op });
    else if (number.includes("."))
      terms.push({ kind: "amount", text: number, cents });
    else terms.push({ kind: "dollars", text: number, cents });
  }
  return terms;
}

/** A number appears in the text on its own, not inside a longer digit run. */
function hasNumber(document: string, number: string): boolean {
  let from = 0;
  for (;;) {
    const at = document.indexOf(number, from);
    if (at < 0) return false;
    const before = document[at - 1] ?? " ";
    const after = document[at + number.length] ?? " ";
    if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true;
    from = at + 1;
  }
}

export type SearchLookups = {
  partyName: (id: string) => string | undefined;
  account: (id: string) => { code?: string | null; name: string } | undefined;
  /** Institution and card mask behind a cash account, when the books know it. */
  bankLabel?: (accountId: string) => string | undefined;
};

const dateShort = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const dateLong = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const abs = (cents: bigint) => (cents < BigInt(0) ? -cents : cents);

/** Everything a text term can match on one entry, lowercased. */
export function searchDocument(
  entry: JournalEntry,
  lookups: SearchLookups,
): string {
  const [year, month, day] = entry.entry_date.split("-");
  const date = new Date(`${entry.entry_date}T00:00:00Z`);
  const pieces: (string | null | undefined)[] = [
    entry.memo,
    entry.source_description,
    entry.context?.kind,
    entry.entry_date,
    dateShort.format(date),
    dateLong.format(date),
    `${Number(month)}/${Number(day)}/${year}`,
    entry.context?.payee_id ? lookups.partyName(entry.context.payee_id) : "",
  ];
  for (const line of entry.lines) {
    const account = lookups.account(line.account_id);
    const amount = abs(readCents(line.amount_cents));
    pieces.push(
      account?.code,
      account?.name,
      line.memo,
      centsToDecimal(amount),
      formatCents(amount).slice(1),
      lookups.bankLabel?.(line.account_id),
    );
  }
  return pieces
    .filter((piece) => piece)
    .join(" ")
    .toLowerCase();
}

/**
 * Whether one entry satisfies every term. `magnitude` is the amount the row
 * shows (see presentTransaction), which the compare terms are measured
 * against and the amount terms may match.
 */
export function entryMatchesSearch(
  entry: JournalEntry,
  terms: SearchTerm[],
  lookups: SearchLookups,
  magnitude: bigint,
): boolean {
  if (!terms.length) return true;
  const document = searchDocument(entry, lookups);
  const amounts = [
    ...entry.lines.map((line) => abs(readCents(line.amount_cents))),
    abs(magnitude),
  ];
  const total = abs(magnitude);
  return terms.every((term) => {
    switch (term.kind) {
      case "compare":
        return term.op === ">"
          ? total > term.cents
          : term.op === ">="
            ? total >= term.cents
            : term.op === "<"
              ? total < term.cents
              : total <= term.cents;
      case "amount":
        return amounts.includes(term.cents) || hasNumber(document, term.text);
      case "dollars":
        return (
          amounts.some((v) => v / HUNDRED === term.cents / HUNDRED) ||
          hasNumber(document, term.text)
        );
      default:
        return document.includes(term.text);
    }
  });
}
