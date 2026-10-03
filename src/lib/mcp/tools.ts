import { z } from "zod";
import {
  API_OPERATIONS,
  type ApiOperation,
  type ApiOperationId,
} from "@/lib/api/operations";
import type { ApiScope } from "@/lib/api/scopes";

/**
 * The finance MCP server's tools, generated from the API registry: one tool
 * per v1 operation plus finance_guide. A tool call runs that operation's own
 * route handler, so what a tool accepts and refuses is exactly what REST
 * accepts and refuses. This file holds no server code, so the reference page
 * can list the tools.
 *
 * Names carry their domain noun (books_, tracker_, tax_) and each lead
 * sentence says plainly what the tool does in 60 characters or fewer: Hermes
 * shows agents the name and the first sentence, and its tool search matches
 * on them.
 */
export const MCP_TOOL_NAMES = {
  "books.summary": {
    tool: "books_summary",
    lead: "Official books: revenue, spending, profit and cash.",
  },
  "books.accounts": {
    tool: "books_list_accounts",
    lead: "Official books: categories and accounts with balances.",
  },
  "books.account_ledger": {
    tool: "books_account_ledger",
    lead: "Get one books account's ledger with running balances.",
  },
  "books.transactions": {
    tool: "books_search_transactions",
    lead: "Find books transactions, such as drafts needing review.",
  },
  "books.transaction": {
    tool: "books_get_transaction",
    lead: "Get one books transaction with all of its lines.",
  },
  "books.reports": {
    tool: "books_list_reports",
    lead: "List the financial reports the books can produce.",
  },
  "books.report": {
    tool: "books_get_report",
    lead: "Official books report: P&L, balance sheet, cash flow.",
  },
  "books.revision": {
    tool: "books_revision",
    lead: "Check whether anything in the books has changed.",
  },
  "books.contacts": {
    tool: "books_list_contacts",
    lead: "List books contacts with roles; search before adding.",
  },
  "books.rules": {
    tool: "books_list_rules",
    lead: "List the books' categorization rules for imports.",
  },
  "books.draft_create": {
    tool: "books_create_draft",
    lead: "Draft an adjusting journal entry, not a bank entry.",
  },
  "books.draft_update": {
    tool: "books_replace_draft",
    lead: "Replace a draft adjustment, lines included.",
  },
  "books.categorize": {
    tool: "books_categorize_draft",
    lead: "Categorize one draft bank or card transaction.",
  },
  "books.split": {
    tool: "books_split_draft",
    lead: "Split one draft bank or card transaction by category.",
  },
  "books.categorize_bulk": {
    tool: "books_categorize_drafts_bulk",
    lead: "Categorize up to 50 draft transactions at once.",
  },
  "books.rule_create": {
    tool: "books_propose_rule",
    lead: "Propose a categorization rule; it starts switched off.",
  },
  "books.contact_create": {
    tool: "books_add_contact",
    lead: "Suggest a new contact for the owner to approve.",
  },
  "books.contact_update": {
    tool: "books_update_contact",
    lead: "Fix a contact you suggested, before it is approved.",
  },
  "books.contact_assign": {
    tool: "books_assign_contact",
    lead: "Set a contact on transactions that have none.",
  },
  "tracker.income": {
    tool: "tracker_income_summary",
    lead: "Owner's manual tracker: monthly take-home income.",
  },
  "tracker.income_items": {
    tool: "tracker_list_income_items",
    lead: "Owner's manual tracker: income items in a date range.",
  },
  "tracker.income_item_create": {
    tool: "tracker_add_income_item",
    lead: "Owner's manual tracker: add an income item.",
  },
  "tracker.income_item_update": {
    tool: "tracker_update_income_item",
    lead: "Owner's manual tracker: change an income item.",
  },
  "tracker.income_item_delete": {
    tool: "tracker_delete_income_item",
    lead: "Owner's manual tracker: delete an income item.",
  },
  "tracker.expenses": {
    tool: "tracker_list_expenses",
    lead: "Owner's manual tracker: fixed costs and subscriptions.",
  },
  "tracker.expense_create": {
    tool: "tracker_add_expense",
    lead: "Owner's manual tracker: add a cost or subscription.",
  },
  "tracker.expense_update": {
    tool: "tracker_update_expense",
    lead: "Owner's manual tracker: change or pause an expense.",
  },
  "tracker.expense_delete": {
    tool: "tracker_delete_expense",
    lead: "Owner's manual tracker: delete an expense.",
  },
  "tracker.net_worth": {
    tool: "tracker_list_net_worth",
    lead: "Owner's manual tracker: net worth over time.",
  },
  "tracker.net_worth_create": {
    tool: "tracker_add_net_worth",
    lead: "Owner's manual tracker: add a net worth entry.",
  },
  "tracker.net_worth_update": {
    tool: "tracker_update_net_worth",
    lead: "Owner's manual tracker: change a net worth entry.",
  },
  "tracker.net_worth_delete": {
    tool: "tracker_delete_net_worth",
    lead: "Owner's manual tracker: delete a net worth entry.",
  },
  "tax.estimate": {
    tool: "tax_estimate",
    lead: "Get the estimated tax for a year from the tax estimator.",
  },
} as const satisfies Record<ApiOperationId, { tool: string; lead: string }>;

export const GUIDE_TOOL = "finance_guide";
export const GUIDE_LEAD =
  "Read first: how the finance tools work and their limits.";

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  annotations: McpToolAnnotations;
}

export interface McpTool {
  /** The v1 operation the tool runs, or null for finance_guide. */
  operation: ApiOperation | null;
  /** The scope a key needs to see the tool; finance_guide needs none. */
  scope: ApiScope | null;
  definition: McpToolDefinition;
  /** Arguments filled in when the agent leaves them out (smaller than REST's). */
  defaults?: Record<string, unknown>;
  /** Shapes the answer for an agent; REST keeps the full shape. */
  present?: (data: unknown) => unknown;
}

/**
 * Where an agent reads differently from REST: smaller default pages, and a
 * page of transactions without lines (it runs past the result cap at REST's
 * default of 50 with them); books_get_transaction has the lines.
 */
const MCP_OVERRIDES: Partial<
  Record<ApiOperationId, Pick<McpTool, "defaults" | "present">>
> = {
  // About 270 characters a row: 100 stays well under the result cap.
  "books.contacts": { defaults: { limit: 100 } },
  "books.rules": { defaults: { limit: 100 } },
  "books.transactions": {
    defaults: { limit: 25 },
    present: (data) => {
      const page = data as { transactions?: Record<string, unknown>[] } | null;
      if (!page?.transactions) return data;
      return {
        ...page,
        transactions: page.transactions.map((row) => {
          const { lines, created_at, ...rest } = row;
          void created_at;
          return {
            ...rest,
            line_count: Array.isArray(lines) ? lines.length : 0,
          };
        }),
      };
    },
  },
};

/** REST paths in the shared descriptions, said as tool names. */
const REST_REFERENCES: Array<[RegExp, string]> = [
  [
    /the ids \/books\/reports\/\{id\} accepts/g,
    "the ids books_get_report accepts",
  ],
  [
    /come from \/books/g,
    "come from the books (books_summary, books_get_report)",
  ],
  [/GET \/tracker\/income/g, "tracker_income_summary"],
];
function mcpText(text: string): string {
  return REST_REFERENCES.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}
function mcpSchemaText(value: unknown): unknown {
  if (typeof value === "string") return mcpText(value);
  if (Array.isArray(value)) return value.map(mcpSchemaText);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mcpSchemaText(item)]),
    );
  return value;
}

/** Optional on creates; the MCP layer makes one when it is left out. */
const IDEMPOTENCY_PROPERTY = {
  type: "string",
  format: "uuid",
  description:
    "Optional. A new uuid for this create. Send the same one again only when retrying this exact call, so it is never saved twice. Left out, the server makes one and returns it.",
};

function jsonSchema(schema: z.ZodObject): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as { properties?: Record<string, unknown>; required?: string[] };
  return { properties: json.properties ?? {}, required: json.required ?? [] };
}

/**
 * One flat object per tool: path parameters, query and body together. The
 * call splits them back by the same schemas, so nothing is renamed.
 */
function inputSchema(op: ApiOperation): McpToolDefinition["inputSchema"] {
  const parts = [op.params, op.query, op.body].filter(
    (part): part is z.ZodObject => !!part,
  );
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const part of parts) {
    const json = jsonSchema(part);
    for (const [name, property] of Object.entries(json.properties)) {
      if (name in properties)
        throw new Error(`${op.id}: parameter ${name} appears twice`);
      properties[name] = property;
    }
    required.push(...json.required);
  }
  if (op.idempotent) properties.idempotency_key = IDEMPOTENCY_PROPERTY;
  for (const [name, value] of Object.entries(
    MCP_OVERRIDES[op.id as ApiOperationId]?.defaults ?? {},
  ))
    if (properties[name] && typeof properties[name] === "object")
      properties[name] = { ...(properties[name] as object), default: value };
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function annotations(op: ApiOperation): McpToolAnnotations {
  const read = op.method === "GET";
  // Creates only add; every other write (bulk categorize included) changes
  // or removes something.
  const additive = op.method === "POST" && op.id.endsWith("_create");
  return {
    readOnlyHint: read,
    destructiveHint: !read && !additive,
    idempotentHint: op.method !== "POST",
    openWorldHint: false,
  };
}

function description(op: ApiOperation): string {
  const { lead } = MCP_TOOL_NAMES[op.id as ApiOperationId];
  // The Idempotency-Key header is the idempotency_key argument here.
  const body = op.description.replace(/\s*Send an Idempotency-Key\./, "");
  const source =
    op.source === "books"
      ? "Answers are labelled source: books, the official numbers."
      : op.source === "tracker"
        ? "Answers are labelled source: tracker, the owner's manual records, not the books."
        : "Answers are labelled source: estimate.";
  return mcpText(`${lead} ${body} ${source}`);
}

const guideDefinition: McpToolDefinition = {
  name: GUIDE_TOOL,
  description: `${GUIDE_LEAD} Covers money in cents, where each number comes from, drafts, retries and errors. Lists the tools this key can use.`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Every tool, guide first, then the registry's order. */
export const MCP_TOOLS: readonly McpTool[] = [
  { operation: null, scope: null, definition: guideDefinition },
  ...(API_OPERATIONS as readonly ApiOperation[]).map((op) => ({
    operation: op,
    scope: op.permission,
    definition: {
      name: MCP_TOOL_NAMES[op.id as ApiOperationId].tool,
      description: description(op),
      inputSchema: mcpSchemaText(
        inputSchema(op),
      ) as McpToolDefinition["inputSchema"],
      annotations: annotations(op),
    },
    ...MCP_OVERRIDES[op.id as ApiOperationId],
  })),
];

/** The tools a key may use: finance_guide, plus every tool whose scope it holds. */
export function toolsForScopes(scopes: readonly string[]): McpTool[] {
  return MCP_TOOLS.filter(
    (tool) => tool.scope === null || scopes.includes(tool.scope),
  );
}
