import { z } from "zod";
import { CONTACT_ROLES } from "@/lib/accounting/contacts";
import type { ApiScope } from "./scopes";

/**
 * Every API operation, in one place. withApi enforces `permission` and parses
 * `params` and `query` from this list; the docs page and /api/v1/openapi.json
 * are generated from it, so what is documented is what is enforced. The list
 * holds no handlers and no server code, so pages can import it.
 */

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Not a calendar date");
/** Any well-formed id: the books also hold ids derived with md5()::uuid, which are not RFC 4122. */
const uuid = z.guid();
const cents = z
  .string()
  .regex(/^-?\d+$/)
  .describe("Integer cents as a string; 12345 is $123.45");
const bookMode = z
  .enum(["working", "posted"])
  .default("working")
  .describe(
    "working (default, what the screens show): every balanced transaction, reviewed or not. posted: reviewed transactions only.",
  );
const offset = z.coerce.number().int().min(0).max(10_000_000).default(0);

/** Money in a request body: integer cents as a string, like every answer. */
const centsInput = z
  .string()
  .regex(
    /^-?\d{1,13}$/,
    'Integer cents as a string, for example "12345" for $123.45',
  );
const positiveCents = centsInput.refine(
  (value) => BigInt(value) > BigInt(0),
  "Must be more than zero",
);
const note = z.string().trim().max(2000).nullable().optional();
const EXPENSE_CATEGORIES = [
  "housing",
  "transport",
  "utilities",
  "health",
  "entertainment",
  "subscriptions",
  "software",
  "hosting",
  "marketing",
  "fees",
  "services",
  "contractors",
  "payroll",
  "insurance",
  "other",
] as const;
const nonEmpty = (body: Record<string, unknown>) =>
  Object.values(body).some((value) => value !== undefined);

const incomeItem = z.object({
  id: uuid,
  received_date: date,
  month: date,
  source_id: uuid,
  amount_cents: cents,
  notes: z.string().nullable(),
  external_source: z
    .string()
    .nullable()
    .describe(
      "Set when the item came from another system, such as a paid invoice",
    ),
});
const expense = z.object({
  id: uuid,
  name: z.string(),
  amount_cents: cents,
  frequency: z.enum(["weekly", "monthly", "quarterly", "annual"]),
  monthly_cents: cents,
  expense_type: z.enum(["personal", "business"]),
  category: z.string().nullable(),
  is_active: z.boolean(),
  effective_date: date,
  notes: z.string().nullable(),
});
const netWorthEntry = z.object({
  id: uuid,
  date,
  amount_cents: cents,
  notes: z.string().nullable(),
});

/** Kinds an agent may give a draft; transfers, payroll, opening and corrections stay in the app. */
const DRAFT_KINDS = [
  "manual",
  "income",
  "expense",
  "refund",
  "owner",
  "loan",
  "asset",
] as const;
const draftLines = z
  .array(
    z
      .object({
        account_id: uuid,
        amount_cents: centsInput.refine(
          (value) => BigInt(value) !== BigInt(0),
          "A line cannot be zero",
        ),
        memo: z.string().max(500).optional(),
      })
      .strict(),
  )
  .min(2, "A transaction needs at least two lines")
  .max(100)
  .refine(
    (lines) =>
      lines.reduce(
        (sum, line) => sum + BigInt(line.amount_cents),
        BigInt(0),
      ) === BigInt(0),
    "Lines must balance: debits are positive, credits negative, and they must add up to zero",
  );
const draftFields = {
  entry_date: date,
  memo: z.string().trim().min(1).max(500),
  lines: draftLines,
  contact_id: uuid
    .nullable()
    .optional()
    .describe("Who it was with: a contact id from books_list_contacts"),
  kind: z.enum(DRAFT_KINDS).optional().describe("Defaults to manual"),
};
const version = z
  .number()
  .int()
  .min(1)
  .describe("The version you read; a stale one is refused with 409");
const written = z.object({
  id: uuid,
  version: z.number().nullable(),
  status: z.literal("draft"),
  review_url: z.string().describe("Where the owner reviews it in the app"),
});
const ruleConditions = z
  .object({
    descriptor_key: z.union([
      z.object({ equals: z.string().trim().min(1).max(250) }).strict(),
      z.object({ prefix: z.string().trim().min(1).max(250) }).strict(),
      z.object({ contains: z.string().trim().min(1).max(250) }).strict(),
    ]),
    bank_account_id: uuid.optional(),
    direction: z.enum(["increase", "decrease", "in", "out"]).optional(),
    amount_min: centsInput.optional(),
    amount_max: centsInput.optional(),
    contact_id: uuid.optional(),
  })
  .strict();
const ruleActions = z.union([
  z
    .object({
      account_id: uuid,
      contact_id: uuid.optional(),
      memo: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      splits: z
        .array(
          z
            .object({
              account_id: uuid,
              share_bps: z.number().int().min(1).max(9999),
            })
            .strict(),
        )
        .min(2)
        .max(100)
        .refine(
          (splits) =>
            splits.reduce((n, split) => n + split.share_bps, 0) === 10000,
          "Split shares must total 10000 (100%)",
        ),
      contact_id: uuid.optional(),
      memo: z.string().max(2000).optional(),
    })
    .strict(),
]);
const limit = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const nameSearch = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe("Only names containing this text (any case)");
const contactRole = z.enum(CONTACT_ROLES);
const contactRoles = z
  .array(contactRole)
  .min(1)
  .max(CONTACT_ROLES.length)
  .describe(
    "One or more of client (pays us), vendor (we buy from), contractor (1099 worker or firm), employee, government (tax agencies), financial (banks, cards, lenders, brokers) and owner",
  );
const contactName = z.string().trim().min(1).max(120);
const contactFields = {
  email: z.email().max(254).nullable().optional(),
  phone: z.string().trim().min(1).max(40).nullable().optional(),
  website: z.string().trim().min(1).max(300).nullable().optional(),
  notes: z.string().max(2000).optional(),
  default_account_id: uuid
    .nullable()
    .optional()
    .describe(
      "A category (income or expense account) that fills new bank transactions from this contact",
    ),
  not_duplicate_of: z
    .array(uuid)
    .max(50)
    .optional()
    .describe(
      "Ids of possible duplicates you checked and found to be different contacts",
    ),
};
const contactWritten = z.object({
  id: uuid,
  version: z.number().nullable(),
  review_status: z.enum(["suggested", "confirmed"]),
  review_url: z.string().describe("Where the owner reviews it in the app"),
});
const listPage = {
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
  next_offset: z.number().nullable(),
};

const quality = z
  .object({
    draft_count: z.number().describe("Transactions not yet reviewed"),
    unbalanced_drafts: z.number(),
    uncategorized_lines: z.number(),
    unclassified_cash_lines: z.number(),
  })
  .describe(
    "How settled the numbers are. Non-zero counts mean the figures can still change.",
  );

const transaction = z.object({
  id: uuid,
  date,
  memo: z.string(),
  description: z
    .string()
    .nullable()
    .describe("The bank's original description, when imported"),
  status: z.enum(["draft", "posted", "discarded"]),
  version: z
    .number()
    .describe("Send it back as expected_version when changing this draft"),
  reviewed: z.boolean(),
  kind: z.string(),
  origin: z.string(),
  amount_cents: cents.describe(
    "Signed movement on the bank or card line: positive is money in",
  ),
  bank_account: z.object({ id: uuid, name: z.string() }).nullable(),
  categories: z.array(
    z.object({
      account_id: uuid,
      account_name: z.string(),
      amount_cents: cents,
    }),
  ),
  transfer: z.boolean(),
  categorized: z.boolean(),
  contact_id: uuid.nullable(),
  contact_name: z.string().nullable(),
  descriptor_key: z
    .string()
    .nullable()
    .describe(
      "The normalized bank description that categorization rules match on",
    ),
  prior_treatment: z
    .object({
      last_category: z.string().nullable(),
      last_category_name: z.string().nullable(),
      contact_id: z.string().nullable(),
      count: z.number(),
    })
    .nullable()
    .describe(
      "How earlier transactions with this description were categorized",
    ),
  lines: z.array(
    z.object({
      id: uuid,
      account_id: uuid,
      account_name: z.string(),
      amount_cents: cents,
      memo: z.string(),
      cash_class: z.string().nullable(),
    }),
  ),
  reverses_entry_id: uuid.nullable(),
  reversed_by_entry_id: uuid.nullable(),
  created_at: z.string(),
  posted_at: z.string().nullable(),
});

/** The kinds the books give a transaction (journal_entries.kind). */
const ENTRY_KINDS = [
  "manual",
  "income",
  "expense",
  "refund",
  "transfer",
  "owner",
  "payroll",
  "loan",
  "asset",
  "opening",
  "correction",
] as const;

/** A page row small enough that 100 fit far under the MCP result cap. */
const compactTransaction = z.object({
  id: uuid,
  date,
  amount_cents: cents.describe(
    "Signed movement on the bank or card line: positive is money in",
  ),
  description: z
    .string()
    .describe("The memo, shortened to 80 characters"),
  contact_name: z.string().nullable(),
  categories: z.array(z.string()).describe("Category names"),
  bank_account: z.string().nullable(),
  status: z.enum(["draft", "posted", "discarded"]),
  reviewed: z.boolean(),
  transfer: z.boolean(),
});

const totals = z
  .object({
    count: z.number().describe("Every match, not just this page"),
    in_cents: cents.describe("Money in across every match"),
    out_cents: cents.describe("Money out across every match, as a positive amount"),
    net_cents: cents.describe("in_cents minus out_cents"),
    without_bank_line: z
      .number()
      .describe(
        "Matches with no single bank, card or cash line (adjustments, or a transfer kept as one entry): counted, but in neither in_cents nor out_cents",
      ),
  })
  .describe(
    "Sums of amount_cents over every match of the filters, not only this page",
  );

/** A comma-separated list in one query parameter, such as "a,b,c". */
const commaList = <T extends z.ZodType<unknown, string>>(
  item: T,
  max: number,
  what: string,
) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1).max(max))
    .describe(`${what}, comma separated (up to ${max})`);

const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;

const contactSeen = {
  first_date: date
    .nullable()
    .describe("Date of this contact's first transaction, or null with none"),
  last_date: date.nullable().describe("Date of the latest transaction"),
  in_cents: cents.describe(
    "Money received from this contact, all time (drafts and reviewed)",
  ),
  out_cents: cents.describe(
    "Money paid to this contact, all time, as a positive amount",
  ),
};

const reconciliationAccount = z.object({
  account: z.object({
    id: uuid,
    name: z.string(),
    code: z.string().nullable(),
    kind: z.enum(["bank", "card", "cash"]),
    institution: z.string().nullable(),
    mask: z.string().nullable(),
  }),
  book_cents: cents.describe(
    "Balance in the books today, drafts included. Normal side: cash held positive, card debt owed positive",
  ),
  book_posted_cents: cents.describe("The same, reviewed transactions only"),
  bank_cents: cents
    .nullable()
    .describe("The balance the bank reported, same sign; null without a feed"),
  bank_observed_at: z
    .string()
    .nullable()
    .describe("When the bank reported that balance"),
  gap_cents: cents
    .nullable()
    .describe(
      "Books minus bank on the day the bank reported, same sign. Zero means they match",
    ),
  off_since: z
    .string()
    .nullable()
    .describe(
      "When the gap began: the first bank report since which it has been non-zero without a break; null when they match",
    ),
  pending_count: z.number().describe("Bank lines still pending"),
  unmatched: z.object({
    count: z.number(),
    amount_cents: cents,
    oldest: date.nullable(),
  }).describe("Posted bank lines that never became a transaction in the books"),
  last_reconciled_through: date
    .nullable()
    .describe("End of the latest completed statement reconciliation"),
  feed: z
    .object({
      connection_id: uuid,
      connection: z.string(),
      status: z.string().describe("active, reconnect_required or disconnected"),
      last_success_at: z.string().nullable(),
      last_error: z.string().nullable(),
      stale: z
        .boolean()
        .describe("Not active, or no successful sync for over 24 hours"),
    })
    .nullable(),
  status: z
    .enum(["ok", "gap", "no_feed", "stale_feed"])
    .describe(
      "no_feed: no bank feed; stale_feed: the feed is down or silent, so the bank figure is old; gap: books and bank differ; ok: they match",
    ),
});

/** Income, expense and net for one breakdown group, as the profit and loss shows them (both positive). */
const activityAmounts = {
  income_cents: cents.optional(),
  expense_cents: cents.optional(),
  net_cents: cents.optional().describe("income_cents minus expense_cents"),
  count: z
    .number()
    .optional()
    .describe("Transactions in this group in the period"),
  balance_cents: cents
    .optional()
    .describe(
      "measure=balance: the balance at the period's end (or at `to`), on the normal side: cash held and card debt owed positive",
    ),
};
const breakdownCompared = z
  .object({
    income_cents: cents.optional(),
    expense_cents: cents.optional(),
    net_cents: cents.optional(),
    balance_cents: cents.optional(),
  })
  .optional();
const breakdownRow = z.object({
  key: z
    .string()
    .describe(
      "The period's first day, an account or contact id, a role, or none (no contact / no single bank account)",
    ),
  label: z.string(),
  type: z
    .string()
    .optional()
    .describe("group_by=category: the account type (income, expense...)"),
  ...activityAmounts,
  compare: breakdownCompared.describe(
    "The same figures for the comparison period",
  ),
  change: breakdownCompared.describe("This period less the comparison"),
});

const supportReportIds = [
  "payroll-register",
  "contractor-worksheet",
  "tax-workpapers",
  "asset-register",
  "loan-register",
] as const;

const recurringSeries = z.object({
  contact: z
    .object({ id: uuid, name: z.string() })
    .nullable()
    .describe("Who is charging; null when the series is a bank description"),
  descriptor_key: z
    .string()
    .nullable()
    .describe("The bank description of the latest charge"),
  category: z.string().nullable().describe("Category of the latest charge"),
  bank_account: z
    .string()
    .nullable()
    .describe("The bank or card the latest charge hit"),
  cadence: z.enum(["weekly", "monthly", "quarterly", "annual"]),
  count: z.number().describe("Charges found (same-day charges are one)"),
  first_date: date,
  last_date: date,
  next_expected: date.describe("last_date plus one cadence"),
  status: z
    .enum(["active", "stopped"])
    .describe("stopped: no charge for over 1.5 cadences"),
  last_cents: cents.describe("The latest charge, positive"),
  previous_cents: cents.describe("The charge before it"),
  average_cents: cents,
  price_change: z
    .object({ on: date, from_cents: cents, to_cents: cents })
    .nullable()
    .describe("The latest charge whose amount differs from the one before"),
  annual_cents: cents.describe("last_cents times charges a year"),
});

const account = z.object({
  id: uuid,
  code: z.string().nullable(),
  name: z.string(),
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  subtype: z.string(),
  purpose: z
    .string()
    .nullable()
    .describe(
      "A system role such as uncategorized_expense or distributions; null for ordinary accounts",
    ),
  parent_id: uuid.nullable(),
  is_archived: z.boolean(),
  cash_kind: z.string().describe("bank, card, cash or none"),
  normal_side: z.enum(["debit", "credit"]),
  balance_cents: cents.describe(
    "Balance on the as_of date, as the Accounts screen shows it: positive is the normal balance (an asset held, a liability owed, income earned)",
  ),
  period_cents: cents.describe(
    "Activity from January 1 of the as_of year to as_of, signed the same way",
  ),
});

const reportRow = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["heading", "account", "subtotal", "total"]),
  code: z.string().optional(),
  values: z
    .array(z.string())
    .describe(
      "One value per column: integer cents strings, or a percentage like 12.50%",
    ),
});

export interface ApiOperation {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  permission: ApiScope;
  source: "books" | "tracker" | "estimate";
  tag: "Books" | "Tracker" | "Tax";
  summary: string;
  description: string;
  params?: z.ZodObject;
  query: z.ZodObject;
  /** JSON body for writes, parsed strictly. */
  body?: z.ZodObject;
  /** Creates: the caller must send an Idempotency-Key (a uuid); a retry replays the first answer. */
  idempotent?: boolean;
  response: z.ZodType;
}

export const API_OPERATIONS = [
  {
    id: "books.summary",
    method: "GET",
    path: "/api/v1/books/summary",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Income, expenses, profit and cash for a period",
    description:
      "The headline business numbers from the books for a date range, with a month-by-month series. Check `quality` before treating them as final.",
    query: z
      .object({
        from: date
          .optional()
          .describe(
            "Defaults to January 1 of the current year (books time zone)",
          ),
        to: date.optional().describe("Defaults to today (books time zone)"),
        mode: bookMode,
      })
      .strict(),
    response: z.object({
      from: date,
      to: date,
      book_mode: z.enum(["working", "posted"]),
      basis: z.string(),
      currency: z.string(),
      income_cents: cents,
      cost_of_goods_sold_cents: cents,
      gross_profit_cents: cents,
      operating_expense_cents: cents,
      expense_cents: cents,
      net_income_cents: cents,
      assets_cents: cents,
      liabilities_cents: cents,
      equity_cents: cents,
      cash_opening_cents: cents,
      cash_ending_cents: cents,
      monthly: z.array(
        z.object({
          month: date,
          income_cents: cents,
          expense_cents: cents,
          net_cents: cents,
        }),
      ),
      quality,
      revision: z.string(),
    }),
  },
  {
    id: "books.accounts",
    method: "GET",
    path: "/api/v1/books/accounts",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Chart of accounts with balances",
    description:
      "Every account with its balance on a date. Categories are accounts: income and expense accounts are the categories.",
    query: z
      .object({
        as_of: date.optional().describe("Defaults to today (books time zone)"),
        mode: bookMode,
        include_archived: z.enum(["true", "false"]).default("false"),
        type: z
          .enum(["asset", "liability", "equity", "income", "expense"])
          .optional()
          .describe(
            "Only this type; income and expense accounts are the categories",
          ),
        q: nameSearch,
      })
      .strict(),
    response: z.object({
      as_of: date,
      book_mode: z.enum(["working", "posted"]),
      accounts: z.array(account),
      revision: z.string(),
    }),
  },
  {
    id: "books.account_ledger",
    method: "GET",
    path: "/api/v1/books/accounts/{id}/ledger",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "One account's ledger with running balances",
    description:
      "Every journal line on the account in the range, oldest first, with the running balance. Page with `offset`.",
    params: z.object({ id: uuid }),
    query: z
      .object({
        from: date
          .optional()
          .describe("Defaults to January 1 of the current year"),
        to: date.optional().describe("Defaults to today"),
        mode: bookMode,
        offset,
        limit: limit(100, 100).describe(
          "Lines per page; lower it when long memos make a page too large",
        ),
      })
      .strict(),
    response: z.object({
      account_id: uuid,
      from: date,
      to: date,
      opening_cents: cents,
      total_cents: cents.describe("Net movement in the range"),
      total: z.number().describe("Lines in the range"),
      next_offset: z.number().nullable(),
      lines: z.array(
        z.object({
          id: uuid,
          entry_id: uuid,
          date,
          memo: z.string(),
          line_memo: z.string(),
          status: z.string(),
          amount_cents: cents,
          running_cents: cents,
        }),
      ),
      revision: z.string(),
    }),
  },
  {
    id: "books.transactions",
    method: "GET",
    path: "/api/v1/books/transactions",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Search transactions",
    description:
      "The transaction register, newest first unless `sort` says otherwise, as the Transactions screen shows it: bank line, categories, review state. `totals` sums every match, not just the page, so one call answers how much in total. `view=compact` gives short rows (100 fit in one answer). Page with `offset` and `limit`.",
    query: z
      .object({
        sort: z
          .enum(["date_desc", "date_asc", "amount_desc", "amount_asc"])
          .default("date_desc")
          .describe(
            "amount_desc lists the biggest first, by size whatever the direction",
          ),
        min_cents: z
          .string()
          .regex(/^\d{1,13}$/, "Whole cents, not negative")
          .optional()
          .describe(
            "Only transactions at least this big (cents, by size whatever the direction)",
          ),
        max_cents: z
          .string()
          .regex(/^\d{1,13}$/, "Whole cents, not negative")
          .optional()
          .describe("Only transactions at most this big (cents, by size)"),
        kind: z
          .enum(ENTRY_KINDS)
          .optional()
          .describe(
            "Only this kind, such as expense, income, refund, owner or payroll",
          ),
        transfers: z
          .enum(["include", "exclude", "only"])
          .default("include")
          .describe(
            "Transfers between the business's own accounts (card payments included): exclude leaves them out, only lists just them",
          ),
        view: z
          .enum(["full", "compact"])
          .default("full")
          .describe(
            "compact: id, date, amount, memo, contact, category names, bank account, status, reviewed and transfer only",
          ),
        from: date.optional(),
        to: date.optional(),
        account: uuid
          .optional()
          .describe("Only transactions touching this account"),
        contact: z
          .union([uuid, z.literal("none")])
          .optional()
          .describe(
            "Only this contact's transactions, or none for those without a contact",
          ),
        status: z.enum(["draft", "posted", "reversed"]).optional(),
        review: z
          .enum(["needed", "done"])
          .optional()
          .describe("needed: not yet reviewed"),
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Text search over memo, description and amounts"),
        descriptor_key: z
          .string()
          .trim()
          .min(1)
          .max(250)
          .optional()
          .describe(
            "Only transactions with this descriptor_key, the bank description rules match on",
          ),
        offset,
        limit: limit(100, 50),
      })
      .strict(),
    response: z.object({
      total: z.number(),
      needs_review_count: z.number(),
      offset: z.number(),
      limit: z.number(),
      next_offset: z.number().nullable(),
      totals,
      transactions: z.array(z.union([transaction, compactTransaction])),
    }),
  },
  {
    id: "books.transaction",
    method: "GET",
    path: "/api/v1/books/transactions/{id}",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "One transaction",
    description: "A single transaction with all of its lines.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    response: transaction,
  },
  {
    id: "books.reports",
    method: "GET",
    path: "/api/v1/books/reports",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "List the reports",
    description:
      "The reports the books produce, with the ids /books/reports/{id} accepts.",
    query: z.object({}).strict(),
    response: z.object({
      reports: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          description: z.string(),
          group: z.string(),
        }),
      ),
    }),
  },
  {
    id: "books.report",
    method: "GET",
    path: "/api/v1/books/reports/{id}",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "A financial report",
    description:
      "The same report the Reports screen shows, row for row: profit-loss, balance-sheet, cash-flow, customer-income, vendor-expenses, trial-balance, general-ledger or owner-activity. Add compare_from and compare_to for a comparison column. Narrow it with `category` (account ids), `contact` and `account_types`: vendor-expenses with category set to Meals lists who the meals were bought from. `top` (profit-loss, customer-income, vendor-expenses) sorts the rows biggest first, keeps that many, and rolls the rest into one Other row so the rows still add up to the total.",
    params: z.object({
      id: z.enum([
        "profit-loss",
        "balance-sheet",
        "cash-flow",
        "customer-income",
        "vendor-expenses",
        "trial-balance",
        "general-ledger",
        "owner-activity",
      ]),
    }),
    query: z
      .object({
        from: date.optional(),
        to: date.optional(),
        compare_from: date.optional(),
        compare_to: date.optional(),
        mode: bookMode,
        category: commaList(
          uuid,
          50,
          "Only these accounts (categories are income and expense accounts)",
        ).optional(),
        contact: z
          .union([uuid, z.literal("none")])
          .optional()
          .describe(
            "Only this contact's transactions, or none for those without a contact",
          ),
        account_types: commaList(
          z.enum(ACCOUNT_TYPES),
          5,
          "Only these account types: asset, liability, equity, income, expense",
        ).optional(),
        top: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "profit-loss, customer-income and vendor-expenses: biggest rows first, this many per section, the rest as one Other row",
          ),
      })
      .strict(),
    response: z.object({
      id: z.string(),
      title: z.string(),
      from: date,
      to: date,
      book_mode: z.enum(["working", "posted"]),
      columns: z.array(z.string()),
      rows: z.array(reportRow),
      footnotes: z.array(z.string()),
      quality,
      revision: z.string(),
    }),
  },
  {
    id: "books.revision",
    method: "GET",
    path: "/api/v1/books/revision",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Has anything changed?",
    description:
      "A counter that goes up on every change to the books, with a small work signal. Poll this and re-read only when it moves. The counter also moves on bank syncs that bring nothing new, so read the signal to decide whether there is work: actionable_drafts are the drafts waiting for a category (uncategorized, not a transfer), with a fingerprint of their ids that changes only when that set changes, and newest_at, when the newest of them arrived. New work shows as a new fingerprint with a higher count or a later newest_at; a lower count alone means drafts were categorized. contacts_needed counts transactions dated since its since date (the last 30 days) with no contact, transfers left out: the rows a transactions search with contact=none, transfers=exclude and from set to since lists.",
    query: z.object({}).strict(),
    response: z.object({
      revision: z.string(),
      actionable_drafts: z.object({
        count: z.number().int(),
        fingerprint: z
          .string()
          .describe(
            "16 hex characters over the sorted draft ids; edits to a waiting draft do not change it",
          ),
        newest_at: z
          .string()
          .nullable()
          .describe("When the newest of these drafts arrived, UTC; null when there are none"),
      }),
      contacts_needed: z.object({
        count: z.number().int(),
        since: date,
      }),
    }),
  },
  {
    id: "tracker.income",
    method: "GET",
    path: "/api/v1/tracker/income",
    permission: "income.read",
    source: "tracker",
    tag: "Tracker",
    summary: "Monthly take-home (income tracker)",
    description:
      "The owner's manual record of what reached their pocket each month, by source. Not revenue or profit: those come from /books. Up to 120 months per request. by_source can name a source that was later deleted; month totals still include it, as the Income screen does.",
    query: z
      .object({
        from: date
          .optional()
          .describe("First month to include; defaults to 12 months ago"),
        to: date
          .optional()
          .describe("Last month to include; defaults to this month"),
      })
      .strict(),
    response: z.object({
      from: date,
      to: date,
      sources: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          slug: z.string(),
          is_active: z.boolean(),
        }),
      ),
      months: z.array(
        z.object({
          month: date,
          total_cents: cents,
          notes: z.string().nullable(),
          by_source: z.array(
            z.object({ source_id: uuid, amount_cents: cents }),
          ),
        }),
      ),
      total_cents: cents,
    }),
  },
  {
    id: "tracker.expenses",
    method: "GET",
    path: "/api/v1/tracker/expenses",
    permission: "expenses.read",
    source: "tracker",
    tag: "Tracker",
    summary: "Fixed costs and subscriptions (expenses tracker)",
    description:
      "The owner's list of known recurring costs. Subscriptions are the rows with category subscriptions, software or hosting; the plan is in the name or notes. Not the books' expenses: those come from /books.",
    query: z
      .object({
        category: z.string().trim().min(1).max(30).optional(),
        type: z.enum(["personal", "business"]).optional(),
        active: z.enum(["true", "false", "all"]).default("true"),
      })
      .strict(),
    response: z.object({
      expenses: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          amount_cents: cents,
          frequency: z.enum(["weekly", "monthly", "quarterly", "annual"]),
          monthly_cents: cents.describe("The amount as a monthly figure"),
          expense_type: z.enum(["personal", "business"]),
          category: z.string().nullable(),
          is_active: z.boolean(),
          effective_date: date,
          notes: z.string().nullable(),
        }),
      ),
      monthly_total_cents: cents.describe("Active rows only"),
    }),
  },
  {
    id: "tracker.net_worth",
    method: "GET",
    path: "/api/v1/tracker/net-worth",
    permission: "net_worth.read",
    source: "tracker",
    tag: "Tracker",
    summary: "Net worth over time",
    description: "The owner's net worth entries, oldest first.",
    query: z.object({ from: date.optional(), to: date.optional() }).strict(),
    response: z.object({
      entries: z.array(
        z.object({
          id: uuid,
          date,
          amount_cents: cents,
          notes: z.string().nullable(),
        }),
      ),
      latest_cents: cents.nullable(),
    }),
  },
  {
    id: "tax.estimate",
    method: "GET",
    path: "/api/v1/tax/estimate",
    permission: "tax.read",
    source: "estimate",
    tag: "Tax",
    summary: "Estimated tax for a year",
    description:
      "The Tax Estimator's figures for one year, computed by the same engine as the screen: liability, what has been paid, and what remains. Uses the inputs as last saved (`saved_at`). When `books_linked` is true, some inputs come from the books and refresh when the estimator is opened, so they can lag the books until then.",
    query: z
      .object({
        year: z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .optional()
          .describe("Defaults to this year"),
      })
      .strict(),
    response: z.object({
      year: z.number(),
      saved_at: z
        .string()
        .describe("When the estimator last saved these inputs"),
      books_linked: z
        .boolean()
        .describe(
          "Some inputs are linked to the books and refresh when the estimator is opened",
        ),
      filing_status: z.string(),
      state: z.string().nullable(),
      total_income_cents: cents,
      agi_cents: cents,
      taxable_income_cents: cents,
      federal_liability_cents: cents,
      state_liability_cents: cents,
      self_employment_tax_cents: cents,
      total_liability_cents: cents,
      total_paid_cents: cents,
      remaining_cents: cents,
      federal_remaining_cents: cents,
      state_remaining_cents: cents,
      payments: z.array(
        z.object({
          type: z.enum(["federal", "state"]),
          category: z.string().nullable().describe("withholding or payment"),
          quarter: z.string().nullable(),
          label: z.string(),
          amount_cents: cents,
        }),
      ),
    }),
  },
  {
    id: "tracker.income_items",
    method: "GET",
    path: "/api/v1/tracker/income/items",
    permission: "income.read",
    source: "tracker",
    tag: "Tracker",
    summary: "Income tracker items",
    description:
      "The individual income items behind the monthly totals, oldest first, with the ids that edits need.",
    query: z.object({ from: date.optional(), to: date.optional() }).strict(),
    response: z.object({ items: z.array(incomeItem) }),
  },
  {
    id: "tracker.income_item_create",
    method: "POST",
    path: "/api/v1/tracker/income/items",
    permission: "income.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Add an income item",
    description:
      "Adds money received to the income tracker, as the Income screen does: the month is created when needed and its totals update. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({
        received_date: date,
        source_id: uuid.describe(
          "An income source id from GET /tracker/income",
        ),
        amount_cents: centsInput.refine(
          (value) => BigInt(value) !== BigInt(0),
          "Must not be zero",
        ),
        notes: note,
      })
      .strict(),
    idempotent: true,
    response: incomeItem,
  },
  {
    id: "tracker.income_item_update",
    method: "PATCH",
    path: "/api/v1/tracker/income/items/{id}",
    permission: "income.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Change an income item",
    description:
      "Changes the fields you send. Moving the date to another month moves the item to that month.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        received_date: date.optional(),
        source_id: uuid.optional(),
        amount_cents: centsInput
          .refine((value) => BigInt(value) !== BigInt(0), "Must not be zero")
          .optional(),
        notes: note,
      })
      .strict()
      .refine(nonEmpty, "Send at least one field to change"),
    response: incomeItem,
  },
  {
    id: "tracker.income_item_delete",
    method: "DELETE",
    path: "/api/v1/tracker/income/items/{id}",
    permission: "income.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Delete an income item",
    description:
      "Moves the item to Trash, where it can be restored in the app. The month's totals update.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    response: z.object({ id: uuid, deleted: z.literal(true) }),
  },
  {
    id: "tracker.expense_create",
    method: "POST",
    path: "/api/v1/tracker/expenses",
    permission: "expenses.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Add an expense or subscription",
    description:
      "Adds a recurring cost. Use category subscriptions, software or hosting for subscriptions. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({
        name: z.string().trim().min(1).max(100),
        amount_cents: positiveCents,
        frequency: z
          .enum(["weekly", "monthly", "quarterly", "annual"])
          .default("monthly"),
        expense_type: z.enum(["personal", "business"]),
        category: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
        effective_date: date.optional().describe("Defaults to today"),
        notes: note,
      })
      .strict(),
    idempotent: true,
    response: expense,
  },
  {
    id: "tracker.expense_update",
    method: "PATCH",
    path: "/api/v1/tracker/expenses/{id}",
    permission: "expenses.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Change, pause or resume an expense",
    description:
      "Changes the fields you send. Set is_active false to pause and true to resume. Changes are recorded in the expense's history.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        amount_cents: positiveCents.optional(),
        frequency: z
          .enum(["weekly", "monthly", "quarterly", "annual"])
          .optional(),
        expense_type: z.enum(["personal", "business"]).optional(),
        category: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
        is_active: z.boolean().optional(),
        effective_date: date.optional(),
        notes: note,
      })
      .strict()
      .refine(nonEmpty, "Send at least one field to change"),
    response: expense,
  },
  {
    id: "tracker.expense_delete",
    method: "DELETE",
    path: "/api/v1/tracker/expenses/{id}",
    permission: "expenses.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Delete an expense",
    description:
      "Moves the expense to Trash, where it can be restored in the app.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    response: z.object({ id: uuid, deleted: z.literal(true) }),
  },
  {
    id: "tracker.net_worth_create",
    method: "POST",
    path: "/api/v1/tracker/net-worth",
    permission: "net_worth.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Add a net worth entry",
    description:
      "One entry per date; a date that already has one is refused with 409. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z.object({ date, amount_cents: centsInput, notes: note }).strict(),
    idempotent: true,
    response: netWorthEntry,
  },
  {
    id: "tracker.net_worth_update",
    method: "PATCH",
    path: "/api/v1/tracker/net-worth/{id}",
    permission: "net_worth.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Change a net worth entry",
    description: "Changes the fields you send.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        date: date.optional(),
        amount_cents: centsInput.optional(),
        notes: note,
      })
      .strict()
      .refine(nonEmpty, "Send at least one field to change"),
    response: netWorthEntry,
  },
  {
    id: "tracker.net_worth_delete",
    method: "DELETE",
    path: "/api/v1/tracker/net-worth/{id}",
    permission: "net_worth.manage",
    source: "tracker",
    tag: "Tracker",
    summary: "Delete a net worth entry",
    description:
      "Moves the entry to Trash, where it can be restored in the app.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    response: z.object({ id: uuid, deleted: z.literal(true) }),
  },
  {
    id: "books.contacts",
    method: "GET",
    path: "/api/v1/books/contacts",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Contacts",
    description:
      "Who the business pays and who pays it: roles, contact details, whether the owner has approved each one (review_status), how many transactions name it, when they started and last appeared, and money in and out all time. Search here before adding a contact. `category` lists the contacts whose money mostly goes through one category; `view=compact` gives short rows. Sorted by name; page with `offset` and `limit`.",
    query: z
      .object({
        q: nameSearch,
        role: contactRole.optional(),
        category: uuid
          .optional()
          .describe(
            "Only contacts whose top_category is this account, such as the hosting vendors",
          ),
        view: z
          .enum(["full", "compact"])
          .default("full")
          .describe(
            "compact: id, name, roles, review_status, top category name, transaction count, first and last date, money in and out",
          ),
        review_status: z
          .enum(["suggested", "confirmed"])
          .optional()
          .describe("suggested: added by an agent and waiting for the owner"),
        include_archived: z.enum(["true", "false"]).default("false"),
        offset,
        limit: limit(500, 200),
      })
      .strict(),
    response: z.object({
      ...listPage,
      contacts: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          roles: z.array(contactRole),
          email: z.string().nullable(),
          phone: z.string().nullable(),
          website: z.string().nullable(),
          notes: z.string(),
          default_account_id: uuid.nullable(),
          review_status: z.enum(["suggested", "confirmed"]),
          suggested_by_name: z.string().nullable(),
          is_archived: z.boolean(),
          version: z.number(),
          transaction_count: z.number(),
          top_category: z
            .object({ id: uuid, name: z.string() })
            .nullable()
            .describe(
              "The category most of this contact's money went through (drafts and reviewed, by amount), or null with no categorized transactions",
            ),
          ...contactSeen,
        }).or(
          z.object({
            id: uuid,
            name: z.string(),
            roles: z.array(contactRole),
            review_status: z.enum(["suggested", "confirmed"]),
            top_category: z.string().nullable(),
            transaction_count: z.number(),
            ...contactSeen,
          }),
        ),
      ),
    }),
  },
  {
    id: "books.rules",
    method: "GET",
    path: "/api/v1/books/rules",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Categorization rules",
    description:
      "The rules that categorize imported transactions, in the order they apply. Check here before adding one. Page with `offset` and `limit`.",
    query: z
      .object({
        q: nameSearch,
        enabled: z
          .enum(["true", "false"])
          .optional()
          .describe(
            "true: only rules that are on; false: only proposals and rules switched off",
          ),
        offset,
        limit: limit(500, 200),
      })
      .strict(),
    response: z.object({
      ...listPage,
      rules: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          priority: z.number(),
          enabled: z.boolean(),
          auto_post: z.boolean(),
          conditions: z.record(z.string(), z.unknown()),
          actions: z.record(z.string(), z.unknown()),
          version: z.number(),
        }),
      ),
    }),
  },
  {
    id: "books.draft_create",
    method: "POST",
    path: "/api/v1/books/drafts",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Prepare a draft transaction",
    description:
      "Creates a journal entry as a draft. It does not touch the official numbers until the owner reviews and posts it in the app. For adjustments between non-cash accounts (accruals, depreciation, reclassifications): a line on a bank, card or cash account is refused, since those transactions come from the feeds. Lines are signed cents: debits positive, credits negative, adding up to zero. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z.object(draftFields).strict(),
    idempotent: true,
    response: written,
  },
  {
    id: "books.draft_update",
    method: "PUT",
    path: "/api/v1/books/drafts/{id}",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Replace a draft",
    description:
      "Rewrites a draft adjustment with what you send, including all of its lines. Only drafts can change; a posted transaction is refused with 409. A bank or card transaction is categorized or split instead, never rewritten.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z.object({ expected_version: version, ...draftFields }).strict(),
    response: written,
  },
  {
    id: "books.categorize",
    method: "POST",
    path: "/api/v1/books/transactions/{id}/categorize",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Categorize a draft",
    description:
      "Puts a draft bank or card transaction in one category (an income or expense account), as the Transactions screen does, which also sets its kind (an expense on money in is a refund). It stays a draft for the owner to review.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        expected_version: version,
        account_id: uuid.describe(
          "The category: an account that is not a bank, card or cash account",
        ),
        contact_id: uuid.optional(),
        memo: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    response: written,
  },
  {
    id: "books.split",
    method: "POST",
    path: "/api/v1/books/transactions/{id}/split",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Split a draft across categories",
    description:
      "Splits a draft bank or card transaction across categories, by positive amounts that add up to the transaction (for money in or out alike) or by shares in basis points that total 10000. It stays a draft.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        expected_version: version,
        splits: z
          .array(
            z
              .object({
                account_id: uuid,
                amount_cents: positiveCents.optional(),
                share_bps: z.number().int().min(1).max(9999).optional(),
              })
              .strict()
              .refine(
                (split) =>
                  (split.amount_cents === undefined) !==
                  (split.share_bps === undefined),
                "Give each split amount_cents or share_bps",
              ),
          )
          .min(2)
          .max(99)
          .refine(
            (splits) =>
              splits.every((split) => split.amount_cents !== undefined) ||
              splits.every((split) => split.share_bps !== undefined),
            "Use amounts for every split or shares for every split",
          ),
        contact_id: uuid.optional(),
        memo: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
    response: written,
  },
  {
    id: "books.categorize_bulk",
    method: "POST",
    path: "/api/v1/books/transactions/categorize",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Categorize many drafts at once",
    description:
      "Categorizes up to 50 drafts in one go. All or nothing: if any one is refused (stale version, posted, wrong account), none change. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({
        items: z
          .array(
            z
              .object({
                id: uuid,
                expected_version: version,
                account_id: uuid,
                contact_id: uuid.optional(),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    idempotent: true,
    response: z.object({ results: z.array(written) }),
  },
  {
    id: "books.rule_create",
    method: "POST",
    path: "/api/v1/books/rules",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Add a categorization rule",
    description:
      "Proposes a rule that categorizes future imports. Rules made through the API start switched off and never post on their own: the owner reviews and turns them on in the app. Accounts and contacts it names must exist. Existing rules cannot be changed here. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({
        name: z.string().trim().min(1).max(120),
        priority: z.number().int().min(1).max(10000).default(100),
        conditions: ruleConditions,
        actions: ruleActions,
        reason: z.string().trim().min(1).max(1000).optional(),
      })
      .strict(),
    idempotent: true,
    response: z.object({
      id: uuid,
      version: z.number().nullable(),
      review_url: z.string().describe("Where the owner sees it in the app"),
    }),
  },
  {
    id: "books.contact_create",
    method: "POST",
    path: "/api/v1/books/contacts",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Suggest a contact",
    description:
      "Adds a contact as a suggestion the owner approves in the app. Search books_list_contacts first. A name that matches an existing contact, ignoring case, punctuation and endings like Inc or LLC, is refused with 409 reason duplicate and that contact in details.existing: use it. A name that holds another as whole words (Google and Google Workspace) is refused with 409 reason possible_duplicate and details.candidates: use one if it is the same, or send all their ids in not_duplicate_of. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({ name: contactName, roles: contactRoles, ...contactFields })
      .strict(),
    idempotent: true,
    response: contactWritten,
  },
  {
    id: "books.contact_update",
    method: "PATCH",
    path: "/api/v1/books/contacts/{id}",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Change a suggested contact",
    description:
      "Changes the fields you send on a contact that is still a suggestion; the rest stay. Once the owner approves a contact it is theirs, and a change is refused with 409 reason contact_confirmed. A new name gets the same duplicate checks as books_add_contact.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        expected_version: version,
        name: contactName.optional(),
        roles: contactRoles.optional(),
        ...contactFields,
      })
      .strict()
      .refine(
        (body) =>
          Object.entries(body).some(
            ([key, value]) =>
              value !== undefined &&
              key !== "expected_version" &&
              key !== "not_duplicate_of",
          ),
        "Send at least one field to change",
      ),
    response: contactWritten,
  },
  {
    id: "books.contact_assign",
    method: "POST",
    path: "/api/v1/books/contacts/{id}/assign",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Set a contact on transactions",
    description:
      "Sets this contact on up to 100 transactions that have none, drafts or reviewed, in open months. Nothing else on them changes. All or nothing: a transaction that already has a contact (409 reason contact_already_set, with it in details), a transfer between the business's own accounts (422 reason transfer_no_contact), a stale version or a closed month refuses the whole call. remember: true also fills this contact on future bank transactions with the same descriptor_key, unless another contact already owns that description (listed in not_remembered). Send an Idempotency-Key.",
    params: z.object({ id: uuid }),
    query: z.object({}).strict(),
    body: z
      .object({
        entries: z
          .array(z.object({ id: uuid, expected_version: version }).strict())
          .min(1)
          .max(100)
          .refine(
            (list) =>
              new Set(list.map((item) => item.id.toLowerCase())).size ===
              list.length,
            "List each transaction once",
          ),
        remember: z
          .boolean()
          .default(false)
          .describe(
            "Also fill this contact on future bank transactions with the same descriptor_key",
          ),
      })
      .strict(),
    idempotent: true,
    response: z.object({
      contact_id: uuid,
      entries: z.array(z.object({ id: uuid, version: z.number() })),
      remembered: z
        .array(z.string())
        .describe("Descriptions that now fill this contact"),
      already_remembered: z.array(z.string()),
      not_remembered: z
        .array(
          z.object({
            descriptor_key: z.string(),
            contact: z.object({ id: uuid, name: z.string() }),
          }),
        )
        .describe("Descriptions another contact already owns"),
      review_url: z.string().describe("Where the owner sees the contact"),
    }),
  },
  {
    id: "books.reconciliation",
    method: "GET",
    path: "/api/v1/books/reconciliation",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Bank balances against the books",
    description:
      "For every bank, card and cash account: the balance in the books, the balance the bank last reported, the gap between them on the day the bank reported, since when that gap has lasted (off_since), bank lines still pending or never taken into the books, and whether the bank feed is working. Amounts are on each account's normal side: cash held positive, card debt owed positive.",
    query: z
      .object({
        account: uuid
          .optional()
          .describe("Only this bank, card or cash account"),
      })
      .strict(),
    response: z.object({
      as_of: date,
      checked_at: z.string(),
      accounts: z.array(reconciliationAccount),
      revision: z.string(),
    }),
  },
  {
    id: "books.attention",
    method: "GET",
    path: "/api/v1/books/attention",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "What needs the owner",
    description:
      "Whether anything in the books is genuinely wrong. Alerts: a gap between the books and the bank lasting over a day, a bank feed down or silent for a day, a single transaction over $1,000 waiting for review for two days, a likely duplicate charge, drafts that do not balance, bank lines left out of a closed month. Info: the review backlog, contacts waiting for approval, what still sits in Uncategorized. Each item keeps the same id while the issue lasts. `alert` is true only when an alert item exists.",
    query: z
      .object({
        include_info: z
          .enum(["true", "false"])
          .default("true")
          .describe("false: alert items only"),
      })
      .strict(),
    response: z.object({
      as_of: date,
      checked_at: z.string(),
      alert: z
        .boolean()
        .describe("True only when at least one alert item exists"),
      counts: z.object({ alert: z.number(), info: z.number() }),
      items: z.array(
        z.object({
          id: z
            .string()
            .describe("Stays the same while the same issue lasts"),
          severity: z.enum(["alert", "info"]),
          kind: z.enum([
            "recon_gap",
            "feed_down",
            "large_unreviewed",
            "possible_duplicate",
            "unbalanced_drafts",
            "closed_month_unmatched",
            "review_backlog",
            "suggested_contacts",
            "uncategorized",
          ]),
          title: z.string(),
          detail: z.string(),
          since: z
            .string()
            .optional()
            .describe("When the issue began: a date or a timestamp"),
          amount_cents: cents.optional(),
          link: z.string().optional().describe("Where the owner fixes it"),
        }),
      ),
      revision: z.string(),
    }),
  },
  {
    id: "books.missed_create",
    method: "POST",
    path: "/api/v1/books/missed-transactions",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Add a bank transaction the feed missed",
    description:
      "Drafts a bank, card or cash movement the bank feed never delivered, for the owner to review. Use it only when the owner tells you about a specific missing charge or deposit, or when books_reconciliation shows a gap and the owner gave you the details; never invent a transaction to close a gap. It is accepted only while that account shows a gap right now, in the direction that shrinks the gap and never by more than the gap (reasons no_gap, wrong_direction, exceeds_gap, after_balance; details.closes_with_cents is the amount that would close it). The same amount on that account within 10 days, in the books or the bank's records, is refused as a likely duplicate (reason possible_duplicate, with the candidate). The date must be in an open month, not in the future and not before the books start. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({
        bank_account_id: uuid.describe(
          "The bank, card or cash account the movement hit (an account id from books_reconciliation)",
        ),
        entry_date: date,
        amount_cents: centsInput
          .refine((value) => BigInt(value) !== BigInt(0), "Must not be zero")
          .describe(
            "Signed from the account's point of view: money out (a charge, a payment) negative, money in positive",
          ),
        description: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("What the bank statement says, such as AMAZON WEB SERVICES"),
        account_id: uuid.describe(
          "The category: an income or expense account (not bank, card or cash)",
        ),
        contact_id: uuid
          .optional()
          .describe("Who it was with: a contact id from books_list_contacts"),
        note: z
          .string()
          .trim()
          .max(500)
          .optional()
          .describe("Where the details came from, for the owner"),
      })
      .strict(),
    idempotent: true,
    response: written,
  },
  {
    id: "books.breakdown",
    method: "GET",
    path: "/api/v1/books/breakdown",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Totals by month, category, contact, bank account or role",
    description:
      "One call for any \"by X\" or \"over time\" question, added up in the books. measure=activity (default) is the profit and loss: income, expense and net per group, the same figures books_get_report shows. measure=balance is the balance at each period's end (group_by month or quarter) or per account at `to` (group_by category or bank_account), for the accounts in `category` or `account_types`, by default every bank and cash account (the cash position). group_by: month or quarter (every period, oldest first), category, contact, bank_account (the bank or card the money went through) or role (a contact with several roles counts once, under the first of owner, employee, contractor, government, financial, client, vendor). Contact, category, bank account and role rows are biggest first, cut at `top`, and the rest rolled into `other`, so rows plus other equal `total`. compare=previous_period (the period just before; whole months compare with whole months) or previous_year (the same dates a year earlier), or compare_from and compare_to, add compare and change to every row.",
    query: z
      .object({
        from: date
          .optional()
          .describe("Defaults to January 1 of the year of `to`"),
        to: date.optional().describe("Defaults to today (books time zone)"),
        mode: bookMode,
        group_by: z
          .enum(["month", "quarter", "category", "contact", "bank_account", "role"])
          .default("month"),
        measure: z
          .enum(["activity", "balance"])
          .default("activity")
          .describe(
            "activity: income, expense and net in the period. balance: ending balances",
          ),
        compare: z
          .enum(["previous_period", "previous_year"])
          .optional()
          .describe("Adds compare and change to every row"),
        compare_from: date.optional().describe("With compare_to, instead of compare"),
        compare_to: date.optional(),
        category: commaList(
          uuid,
          50,
          "Only these accounts (activity: income or expense accounts; balance: any account)",
        ).optional(),
        account_types: commaList(
          z.enum(ACCOUNT_TYPES),
          5,
          "Only these account types (activity: income, expense)",
        ).optional(),
        contact: z
          .union([uuid, z.literal("none")])
          .optional()
          .describe("activity: only this contact, or none for no contact"),
        role: contactRole
          .optional()
          .describe("activity: only contacts holding this role"),
        kind: z
          .enum(ENTRY_KINDS)
          .optional()
          .describe("activity: only this kind of transaction"),
        bank_account: uuid
          .optional()
          .describe(
            "activity: only transactions through this bank, card or cash account",
          ),
        top: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe(
            "Rows kept for category, contact, bank_account and role; the rest is `other`",
          ),
      })
      .strict(),
    response: z.object({
      from: date,
      to: date,
      book_mode: z.enum(["working", "posted"]),
      measure: z.enum(["activity", "balance"]),
      group_by: z.string(),
      top: z.number(),
      compare: z.object({ from: date, to: date }).nullable(),
      rows: z.array(breakdownRow),
      other: breakdownRow
        .omit({ key: true, type: true })
        .extend({ groups: z.number() })
        .nullable()
        .describe("Every group past `top`, added together; null when none"),
      total: breakdownRow.omit({ key: true, label: true, type: true }),
      quality,
      revision: z.string(),
    }),
  },
  {
    id: "books.recurring",
    method: "GET",
    path: "/api/v1/books/recurring",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Recurring charges and subscriptions found in the books",
    description:
      "Charges that repeat, found in the books' own transactions (not the expenses tracker): money out of one bank, card or cash account to an expense category, never transfers or card payments, grouped by contact, or by bank description when there is no contact. Same-day charges count as one. The cadence is the median gap between charges (weekly 5 to 9 days, monthly 25 to 35, quarterly 80 to 100, annual 330 to 400) and at least 60% of the gaps must fit it; anything else is not listed. A series is stopped once no charge has come for 1.5 cadences. Active first, then by annual cost. Each row has the last, previous and average charge, the latest price change with its date, the next expected date and the annual cost.",
    query: z
      .object({
        status: z
          .enum(["all", "active", "stopped"])
          .default("all"),
        min_count: z.coerce
          .number()
          .int()
          .min(2)
          .max(100)
          .default(3)
          .describe(
            "Charges a series needs; 2 also finds a yearly renewal seen only twice",
          ),
        from: date
          .optional()
          .describe("Look back from here; defaults to 37 months before as_of"),
        as_of: date
          .optional()
          .describe("Judge active or stopped as of this date; defaults to today"),
        contact: uuid.optional().describe("Only this contact's charges"),
        mode: bookMode,
        offset,
        limit: limit(80, 50),
      })
      .strict(),
    response: z.object({
      as_of: date,
      from: date,
      book_mode: z.enum(["working", "posted"]),
      total: z.number().describe("Series matching status"),
      offset: z.number(),
      limit: z.number(),
      next_offset: z.number().nullable(),
      totals: z.object({
        active: z.number(),
        stopped: z.number(),
        active_annual_cents: cents.describe("Annual cost of every active series"),
        active_monthly_cents: cents.describe("The same, per month"),
      }),
      series: z.array(recurringSeries),
      revision: z.string(),
    }),
  },
  {
    id: "books.support_report",
    method: "GET",
    path: "/api/v1/books/support-reports/{id}",
    permission: "accounting.payroll",
    source: "books",
    tag: "Books",
    summary: "Payroll register, 1099 worksheet, tax workpapers",
    description:
      "The owner's year-end support reports, read only, from reviewed (posted) books. payroll-register: each payroll run (gross wages, employee withholding, employer taxes, net pay). contractor-worksheet: each contact with the contractor role, cash paid net of refunds (bank and cash only: card payments are reported by the card company and listed separately), classification, W-9 documentation status and meets_threshold against the year's 1099 threshold (threshold_cents). tax-workpapers: each account's book profit and ordinary taxable contribution, adjustments, and a summary (book profit, adjusted ordinary income, book-to-tax difference, unmapped accounts). asset-register and loan-register: register balances. Pass year, or from and to; the contractor worksheet and tax workpapers cover one calendar year (tax workpapers from January 1). Rows are cells in column order; columns says which are cents.",
    params: z.object({ id: z.enum(supportReportIds) }),
    query: z
      .object({
        year: z.coerce
          .number()
          .int()
          .min(2000)
          .max(2100)
          .optional()
          .describe(
            "January 1 to December 31, or to today for the current year",
          ),
        from: date.optional(),
        to: date.optional(),
        offset,
        limit: limit(200, 100),
      })
      .strict(),
    response: z.object({
      id: z.enum(supportReportIds),
      title: z.string(),
      from: date,
      to: date,
      columns: z.array(z.object({ label: z.string(), numeric: z.boolean() })),
      rows: z.array(
        z.object({
          id: z.string(),
          cells: z
            .array(z.string().nullable())
            .describe("One per column; numeric columns are cents strings"),
          meets_threshold: z
            .boolean()
            .optional()
            .describe("contractor-worksheet: cash paid reaches threshold_cents"),
        }),
      ),
      count: z.number(),
      offset: z.number(),
      limit: z.number(),
      next_offset: z.number().nullable(),
      total_cells: z.array(z.string().nullable()),
      notes: z.array(z.string()),
      threshold_cents: cents
        .optional()
        .describe("contractor-worksheet: the year's 1099 reporting threshold"),
      summary: z
        .object({
          book_profit_cents: cents,
          mapped_ordinary_cents: cents,
          adjusted_ordinary_cents: cents,
          book_to_tax_cents: cents,
          separately_stated: z.record(z.string(), cents),
          unmapped_accounts: z.number(),
          drafts: z.number().nullable(),
          classification: z.string().nullable(),
        })
        .optional()
        .describe("tax-workpapers: the year's figures"),
      controls: z
        .unknown()
        .optional()
        .describe("asset-register and loan-register: register against the books"),
      revision: z.string(),
    }),
  },
] as const satisfies readonly ApiOperation[];

export type ApiOperationId = (typeof API_OPERATIONS)[number]["id"];

export function apiOperation<I extends ApiOperationId>(id: I) {
  const op = API_OPERATIONS.find((candidate) => candidate.id === id);
  if (!op) throw new Error(`Unknown API operation ${id}`);
  return op as Extract<(typeof API_OPERATIONS)[number], { id: I }>;
}
