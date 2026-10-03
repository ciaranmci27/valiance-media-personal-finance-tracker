import { z } from "zod";
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
  payee_id: uuid.nullable().optional(),
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
    payee_id: uuid.optional(),
  })
  .strict();
const ruleActions = z.union([
  z
    .object({
      account_id: uuid,
      payee_id: uuid.optional(),
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
      payee_id: uuid.optional(),
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
    incomplete_imports: z.number(),
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
  payee_id: uuid.nullable(),
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
      payee_id: z.string().nullable(),
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
      "The transaction register, newest first, as the Transactions screen shows it: bank line, categories, review state. Page with `offset` and `limit`.",
    query: z
      .object({
        from: date.optional(),
        to: date.optional(),
        account: uuid
          .optional()
          .describe("Only transactions touching this account"),
        payee: uuid.optional(),
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
      transactions: z.array(transaction),
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
      "The same report the Reports screen shows, row for row: profit-loss, balance-sheet, cash-flow, customer-income, vendor-expenses, trial-balance, general-ledger or owner-activity. Add compare_from and compare_to for a comparison column.",
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
      "A counter that goes up on every change to the books. Poll this and re-read only when it moves.",
    query: z.object({}).strict(),
    response: z.object({ revision: z.string() }),
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
    id: "books.payees",
    method: "GET",
    path: "/api/v1/books/payees",
    permission: "accounting.read",
    source: "books",
    tag: "Books",
    summary: "Payees",
    description:
      "Vendors and customers, with the ids drafts, rules and categorizing take. Sorted by name; page with `offset` and `limit`.",
    query: z
      .object({
        q: nameSearch,
        kind: z.enum(["vendor", "customer", "both"]).optional(),
        include_archived: z.enum(["true", "false"]).default("false"),
        offset,
        limit: limit(500, 200),
      })
      .strict(),
    response: z.object({
      ...listPage,
      payees: z.array(
        z.object({
          id: uuid,
          name: z.string(),
          kind: z.enum(["vendor", "customer", "both"]),
          default_account_id: uuid.nullable(),
          is_archived: z.boolean(),
          version: z.number(),
        }),
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
        payee_id: uuid.optional(),
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
        payee_id: uuid.optional(),
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
                payee_id: uuid.optional(),
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
      "Proposes a rule that categorizes future imports. Rules made through the API start switched off and never post on their own: the owner reviews and turns them on in the app. Accounts and payees it names must exist. Existing rules cannot be changed here. Send an Idempotency-Key.",
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
    id: "books.payee_create",
    method: "POST",
    path: "/api/v1/books/payees",
    permission: "accounting.draft",
    source: "books",
    tag: "Books",
    summary: "Add a payee",
    description:
      "Adds a vendor or customer. Existing payees cannot be changed here. Send an Idempotency-Key.",
    query: z.object({}).strict(),
    body: z
      .object({
        name: z.string().trim().min(1).max(200),
        kind: z.enum(["vendor", "customer", "both"]),
        default_account_id: uuid.nullable().optional(),
        notes: z.string().max(2000).optional(),
      })
      .strict(),
    idempotent: true,
    response: z.object({
      id: uuid,
      version: z.number().nullable(),
      review_url: z.string().describe("Where the owner sees it in the app"),
    }),
  },
] as const satisfies readonly ApiOperation[];

export type ApiOperationId = (typeof API_OPERATIONS)[number]["id"];

export function apiOperation<I extends ApiOperationId>(id: I) {
  const op = API_OPERATIONS.find((candidate) => candidate.id === id);
  if (!op) throw new Error(`Unknown API operation ${id}`);
  return op as Extract<(typeof API_OPERATIONS)[number], { id: I }>;
}
