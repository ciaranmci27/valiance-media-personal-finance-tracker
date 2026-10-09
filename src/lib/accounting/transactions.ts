import type {
  AccountingAccount,
  CategorizedBy,
  EntryContext,
  JournalEntry,
  JournalLine,
} from "./contracts";
import type { AccountProfile } from "./workflows";
import { parseUsd, readCents } from "./money";

export const defaultEntryContext: EntryContext = {
  kind: "manual",
};

export function isTransactionReviewed(entry: JournalEntry): boolean {
  return entry.status === "posted" && !entry.review_pending;
}
/** What a click on a row opens: a draft goes straight to its editor, anything else to the detail view. */
export function transactionRowAction(entry: JournalEntry): "edit" | "detail" {
  // One side of a proposed transfer changes through its pair, never the editor.
  return entry.status === "draft" && !entry.pair_entry_id ? "edit" : "detail";
}
export function isTransactionReversed(entry: JournalEntry): boolean {
  return Boolean(entry.reverses_entry_id || entry.reversed_by_entry_id);
}
export function canRestoreTransaction(entry: JournalEntry): boolean {
  return Boolean(
    entry.reversed_by_entry_id &&
      !entry.reverses_entry_id &&
      !entry.restored_by_entry_id &&
      !entry.replacement_entry_id &&
      !entry.payroll_run_id &&
      !entry.restore_workflow,
  );
}
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
  // A linked transfer keeps its original lines and kind; the group id is the durable marker.
  const transfer =
    !!entry.transfer_group_id ||
    !!entry.pair_entry_id ||
    (accounts.length > 1 && bankLines.length === entry.lines.length);
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
      !entry.transfer_group_id &&
      !["transfer", "payroll", "opening", "invoice_receipt"].includes(
        entry.context?.kind ?? "",
      ),
    categorized:
      balanced && !entry.lines.some((l) => suspense.has(l.account_id)),
  };
}

/** The family of a category's source; the screen picks one icon and tone per kind. */
export type CategorySourceKind =
  | "you"
  | "member"
  | "agent"
  | "api"
  | "rule"
  | "prior"
  | "payee_default"
  | "transfer"
  | "import"
  | "unknown";
export interface CategorySourceView {
  kind: CategorySourceKind;
  /** The accessible name and tooltip, in the owner's words. */
  label: string;
}
const importLabels = {
  wave_import: "From Wave history",
  gusto_import: "From Gusto import",
  patriot_import: "From Patriot import",
} as const;

/**
 * Who or what chose a transaction's category, drafts and reviewed alike.
 * Null while nothing is categorized: the books' suggestions speak for those
 * rows. A categorized row the history cannot explain reads as plainly
 * categorized, never as a guess.
 */
export function categorySource(
  entry: JournalEntry,
  categorized: boolean,
): CategorySourceView | null {
  if (!categorized) return null;
  // A draft read before the source was recorded still knows how the books filled it.
  const by: CategorizedBy | null =
    entry.categorized_by ??
    (entry.status === "draft" && entry.fill
      ? { source: entry.fill.source, rule_name: entry.fill.rule_name }
      : null);
  if (!by)
    return { kind: "unknown", label: "Categorized, source not recorded" };
  const name = by.actor_name?.trim();
  const agent = by.actor_role === "agent";
  const self = by.self === true;
  switch (by.source) {
    case "person":
      if (self) return { kind: "you", label: "Categorized by you" };
      if (agent)
        return { kind: "agent", label: `Categorized by ${name || "an agent"}` };
      return {
        kind: "member",
        label: `Categorized by ${name || "a team member"}`,
      };
    case "api":
      if (agent)
        return {
          kind: "agent",
          label: self
            ? "Categorized by you"
            : `Categorized by ${name || "an agent"}`,
        };
      return {
        kind: "api",
        label: self
          ? "Categorized through the API with your key"
          : `Categorized through the API by ${name || "a team member"}`,
      };
    case "rule":
      return {
        kind: "rule",
        label: by.rule_name
          ? `Categorized by rule: ${by.rule_name}`
          : "Categorized by a rule",
      };
    case "prior":
      return {
        kind: "prior",
        label: "Suggested by the books: same as last time",
      };
    case "payee_default":
      return {
        kind: "payee_default",
        label: entry.payee_name
          ? `Suggested by the books: ${entry.payee_name}'s default category`
          : "Suggested by the books: the contact's default category",
      };
    case "transfer_pair":
      return {
        kind: "transfer",
        label: "Matched transfer, paired by the books",
      };
    case "wave_import":
    case "gusto_import":
    case "patriot_import":
      return { kind: "import", label: importLabels[by.source] };
    default:
      return { kind: "unknown", label: "Categorized, source not recorded" };
  }
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
