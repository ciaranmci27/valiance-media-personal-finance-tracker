import type {
  AccountingAccount,
  EntryContext,
  JournalEntry,
  JournalLine,
} from "./contracts";
import type { AccountProfile } from "./workflows";
import { parseUsd, readCents } from "./money";

export const defaultEntryContext: EntryContext = {
  kind: "manual",
};
export interface TransactionPresentation {
  accountIds: string[];
  bankLine: JournalLine | null;
  categoryLines: JournalLine[];
  amount: bigint;
  movement: boolean;
  transfer: boolean;
  editable: boolean;
  categorized: boolean;
}

/** Present an economic movement without pretending every debit is cash income. */
export function presentTransaction(
  entry: JournalEntry,
  profiles: AccountProfile[],
  selectedAccount?: string,
): TransactionPresentation {
  const cash = new Set(
    profiles.filter((p) => p.cash_kind !== "none").map((p) => p.account_id),
  );
  const bankLines = entry.lines.filter((l) => cash.has(l.account_id));
  const accounts = [...new Set(bankLines.map((l) => l.account_id))];
  const bankLine = bankLines.length === 1 ? bankLines[0] : null;
  const categoryLines = bankLine
    ? entry.lines.filter((l) => l.id !== bankLine.id)
    : [];
  const balanced =
    entry.lines.length >= 2 &&
    entry.lines.every((l) => readCents(l.amount_cents) !== BigInt(0)) &&
    entry.lines.reduce((s, l) => s + readCents(l.amount_cents), BigInt(0)) ===
      BigInt(0);
  const raw = bankLine ? readCents(bankLine.amount_cents) : BigInt(0);
  const selectedLines = selectedAccount
    ? entry.lines.filter((l) => l.account_id === selectedAccount)
    : [];
  const selectedAmount = selectedLines.reduce(
    (s, l) => s + readCents(l.amount_cents),
    BigInt(0),
  );
  const transfer =
    accounts.length > 1 && bankLines.length === entry.lines.length;
  const sameDirection = categoryLines.every((l) =>
    raw > BigInt(0)
      ? readCents(l.amount_cents) < BigInt(0)
      : readCents(l.amount_cents) > BigInt(0),
  );
  const suspense = new Set(
    profiles
      .filter((p) =>
        [
          "uncategorized_income",
          "uncategorized_expense",
          "opening_balance_equity",
        ].includes(p.purpose ?? ""),
      )
      .map((p) => p.account_id),
  );
  return {
    accountIds: accounts,
    bankLine,
    categoryLines,
    amount: selectedLines.length
      ? selectedAmount
      : bankLine
        ? raw
        : entry.lines.reduce(
            (s, l) =>
              s +
              (readCents(l.amount_cents) > BigInt(0)
                ? readCents(l.amount_cents)
                : BigInt(0)),
            BigInt(0),
          ),
    movement:
      !!bankLine || (!!selectedLines.length && cash.has(selectedAccount!)),
    transfer,
    editable:
      !!bankLine &&
      balanced &&
      sameDirection &&
      !entry.reverses_entry_id &&
      !entry.reversed_by_entry_id &&
      !["transfer", "payroll", "opening", "invoice_receipt"].includes(
        entry.context?.kind ?? "",
      ),
    categorized:
      balanced && !entry.lines.some((l) => suspense.has(l.account_id)),
  };
}

export interface SimpleTransactionInput {
  account: string;
  direction: "in" | "out";
  amount: string;
  splits: { account: string; amount: string; memo: string }[];
}
export function simpleTransactionLines(
  input: SimpleTransactionInput,
  accounts: AccountingAccount[],
  profiles: AccountProfile[],
): { account_id: string; amount_cents: string; memo: string }[] {
  const account = accounts.find(
    (a) => a.id === input.account && !a.is_archived,
  );
  if (
    !account ||
    !profiles.some((p) => p.account_id === account.id && p.cash_kind !== "none")
  )
    throw new Error("Choose an active bank, cash, or card account.");
  const total = parseUsd(input.amount);
  if (total <= BigInt(0)) throw new Error("Enter an amount greater than zero.");
  if (!input.splits.length || input.splits.length > 99)
    throw new Error("Use between 1 and 99 categories.");
  const direction = input.direction === "in" ? BigInt(1) : BigInt(-1);
  const lines = input.splits.map((s) => {
    const category = accounts.find((a) => a.id === s.account && !a.is_archived);
    if (!category || category.id === account.id)
      throw new Error("Choose a category different from the payment account.");
    if (
      profiles.some(
        (p) => p.account_id === category.id && p.cash_kind !== "none",
      )
    )
      throw new Error(
        "Use Transfer for movements between bank, cash, or card accounts.",
      );
    const amount = parseUsd(s.amount);
    if (amount <= BigInt(0))
      throw new Error("Each split needs an amount greater than zero.");
    return {
      account_id: category.id,
      amount_cents: readCents((-direction * amount).toString()).toString(),
      memo: s.memo,
    };
  });
  if (
    lines.reduce((sum, l) => sum + readCents(l.amount_cents), BigInt(0)) !==
    -direction * total
  )
    throw new Error("Split amounts must equal the transaction total.");
  return [
    {
      account_id: account.id,
      amount_cents: readCents((direction * total).toString()).toString(),
      memo: "",
    },
    ...lines,
  ];
}
