/**
 * The invoice source contract: what the books read from, and write back to,
 * any invoicing system they connect to through an HTTPS base URL and an API
 * key. Shared by the Next.js routes (Node) and the sync-invoice-sources edge
 * function (Deno). Nothing here opens a connection; callers pass the
 * transport for their runtime.
 *
 *   GET    {base}/api/v1/invoices?page&limit
 *   GET    {base}/api/v1/billing/earned-work?from&to
 *   POST   {base}/api/v1/projects/{project}/invoices/{invoice}/payments
 *   DELETE {base}/api/v1/projects/{project}/invoices/{invoice}/payments/{payment}
 *
 * Money arrives as dollars with two decimals and is kept as whole cents. An
 * invoice's `amount` is before tax and its `total` is what the client owes;
 * the tax between them becomes a "tax" line, which the books map to a
 * liability, never to income.
 */
import { z } from "zod";

export class InvoiceSourceError extends Error {
  constructor(
    public code:
      | "auth"
      | "invalid_url"
      | "invalid_response"
      | "unreachable"
      | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "InvoiceSourceError";
  }
}

export type SourceRequest = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  apiKey: string;
  body?: unknown;
};
export type SourceResponse = { status: number; body: string };
export type SourceTransport = (
  request: SourceRequest,
) => Promise<SourceResponse>;

/** A public IPv4 or global unicast IPv6 address; private, loopback, link-local and documentation ranges are refused. */
export function publicAddress(address: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (address.includes(":")) {
    const normalized = address.toLowerCase(),
      [first, second] = normalized
        .split(":")
        .map((part) => parseInt(part || "0", 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !normalized.includes(".") &&
      !normalized.includes("%") &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      first !== 0x2002 &&
      first !== 0x3fff
    );
  }
  return false;
}

/** The connection's base URL: public HTTPS on port 443, no credentials, query or fragment, never a private address. */
export function sourceBaseUrl(raw: string): URL {
  if (raw.length > 500 || /[\u0000- \u007f]/.test(raw))
    throw new InvoiceSourceError("invalid_url", "The address is not valid.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvoiceSourceError("invalid_url", "The address is not valid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new InvoiceSourceError(
      "invalid_url",
      "Use a public HTTPS address without a port, credentials, query or fragment.",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (literal && !publicAddress(host))
  )
    throw new InvoiceSourceError(
      "invalid_url",
      "The address must be on the public internet.",
    );
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dollars = z.number().finite();
const text = (max: number) => z.string().max(max);
const id = z.string().min(1).max(200);

const invoiceSchema = z.object({
  id,
  invoice_number: text(100).nullish(),
  status: z.enum(["draft", "sent", "overdue", "paid", "cancelled"]),
  date: day,
  due_date: day.nullish(),
  amount: dollars,
  tax_amount: dollars.nullish(),
  total: dollars.min(0),
  updated_at: z.string().max(64).nullish(),
  project: z.object({ id, name: text(200).nullish() }),
  customer: z
    .object({
      name: z.string().nullish(),
      company: z.string().nullish(),
      email: z.string().nullish(),
    })
    .nullish(),
  lines: z
    .array(
      z.object({
        key: id,
        type: z.enum(["hourly", "fixed", "recurring", "reimbursement"]),
        description: z.string().nullish(),
        amount: dollars,
        service_from: day.nullish(),
        service_to: day.nullish(),
      }),
    )
    .max(500),
  payments: z
    .array(
      z.object({
        id,
        amount: dollars.positive(),
        paid_date: day,
        external_id: text(200).nullish(),
        recorded_via: z.enum(["app", "api"]).nullish(),
      }),
    )
    .max(500),
});
const listSchema = z.object({
  success: z.literal(true),
  data: z.array(invoiceSchema).max(1000),
  meta: z.object({
    page: z.number().int().min(1),
    total_pages: z.number().int().min(0),
  }),
});
const earnedSchema = z.object({
  success: z.literal(true),
  data: z.object({
    projects: z
      .array(
        z.object({
          project: z.object({ id }),
          time: z.array(z.object({ date: day, amount: dollars })).max(20000),
          scheduled: z
            .array(
              z.object({
                retainer_id: z.string().min(1).max(150),
                period_start: day,
                period_end: day,
                amount: dollars,
              }),
            )
            .max(5000),
        }),
      )
      .max(5000),
  }),
});
const paymentSchema = z.object({
  success: z.literal(true),
  data: z.object({
    payment: z.object({ id }),
    replayed: z.boolean().optional(),
  }),
});

export type BooksLine = {
  key: string;
  type: "hourly" | "fixed" | "recurring" | "reimbursement" | "tax";
  description: string;
  amount_cents: string;
  service_from: string | null;
  service_to: string | null;
};
export type BooksInvoice = {
  external_id: string;
  number: string;
  project_ref: string;
  project_name: string;
  customer_name: string;
  issue_date: string;
  due_date: string | null;
  status: "draft" | "issued" | "paid" | "void";
  total_cents: string;
  lines: BooksLine[];
  payments: {
    id: string;
    amount_cents: string;
    paid_date: string;
    recorded_via: "app" | "api";
    external_id: string | null;
  }[];
  source_updated_at: string | null;
};
export type BooksEarned = {
  kind: "time" | "scheduled";
  external_ref: string;
  project_ref: string;
  earned_from: string;
  earned_to: string;
  amount_cents: string;
};

/** Dollars with two decimals to whole cents, without binary drift (0.29 is 29). */
export function toCents(value: number): bigint {
  return BigInt(Math.round(value * 100));
}
export function toDollars(cents: bigint | string): number {
  return Number(BigInt(cents)) / 100;
}

const STATUS: Record<
  z.infer<typeof invoiceSchema>["status"],
  BooksInvoice["status"]
> = {
  draft: "draft",
  sent: "issued",
  overdue: "issued",
  paid: "paid",
  cancelled: "void",
};

/**
 * One source invoice in the books' terms. Lines always add up to what the
 * client owes: the tax between amount and total is its own line, any other
 * gap one correction line, and a line-less invoice one fixed line.
 */
export function booksInvoice(
  invoice: z.infer<typeof invoiceSchema>,
): BooksInvoice {
  const total = toCents(invoice.total);
  const lines: BooksLine[] = invoice.lines.map((line) => {
    const dated = !!line.service_from && !!line.service_to;
    return {
      key: line.key,
      type: line.type,
      description: (line.description ?? "").slice(0, 300),
      amount_cents: toCents(line.amount).toString(),
      service_from: dated ? line.service_from! : null,
      service_to: dated ? line.service_to! : null,
    };
  });
  const tax = toCents(invoice.tax_amount ?? 0);
  if (tax !== BigInt(0))
    lines.push({
      key: `tax:${invoice.id}`,
      type: "tax",
      description: "Sales tax",
      amount_cents: tax.toString(),
      service_from: null,
      service_to: null,
    });
  const sum = lines.reduce(
    (acc, line) => acc + BigInt(line.amount_cents),
    BigInt(0),
  );
  if (!lines.length || sum !== total)
    lines.push({
      key: lines.length ? `correction:${invoice.id}` : `legacy:${invoice.id}`,
      type: "fixed",
      description: lines.length
        ? "Difference between the lines and the invoice total"
        : "",
      amount_cents: (total - sum).toString(),
      service_from: null,
      service_to: null,
    });
  return {
    external_id: invoice.id,
    number: invoice.invoice_number ?? "",
    project_ref: invoice.project.id,
    project_name: (invoice.project.name ?? "").slice(0, 200),
    customer_name: (
      invoice.customer?.company ||
      invoice.customer?.name ||
      ""
    ).slice(0, 200),
    issue_date: invoice.date,
    due_date: invoice.due_date ?? null,
    status: STATUS[invoice.status],
    total_cents: total.toString(),
    lines,
    payments: invoice.payments.map((payment) => ({
      id: payment.id,
      amount_cents: toCents(payment.amount).toString(),
      paid_date: payment.paid_date,
      recorded_via: payment.recorded_via ?? "app",
      external_id: payment.external_id ?? null,
    })),
    source_updated_at: invoice.updated_at ?? null,
  };
}

function parse<T>(schema: z.ZodType<T>, body: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvoiceSourceError(
      "invalid_response",
      `The source returned unreadable ${what}.`,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new InvoiceSourceError(
      "invalid_response",
      `The source returned ${what} the books do not understand.`,
    );
  return parsed.data;
}

/** The source's own error message, trimmed to one plain line, never the request. */
export function sourceMessage(body: string, fallback: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })
      ?.error?.message;
    if (typeof message === "string" && message.trim())
      return message.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    /* Not JSON: the fallback says what happened. */
  }
  return fallback;
}

export type PushOutcome =
  | { outcome: "recorded"; external_payment_id: string | null }
  | { outcome: "removed" }
  | { outcome: "retry"; error: string }
  | { outcome: "failed"; error: string };

/** A client for one connection. Authentication failures throw; everything else is an outcome or a parse error. */
export function sourceClient(
  baseUrl: string,
  apiKey: string,
  transport: SourceTransport,
) {
  const base = sourceBaseUrl(baseUrl).href.replace(/\/+$/, "");
  const call = async (
    method: SourceRequest["method"],
    path: string,
    body?: unknown,
  ) => {
    let response: SourceResponse;
    try {
      response = await transport({ method, url: base + path, apiKey, body });
    } catch (error) {
      if (error instanceof InvoiceSourceError) throw error;
      throw new InvoiceSourceError(
        "unreachable",
        "The invoicing system could not be reached.",
      );
    }
    return response;
  };
  const read = async <T>(path: string, schema: z.ZodType<T>, what: string) => {
    const response = await call("GET", path);
    if (response.status === 401 || response.status === 403)
      throw new InvoiceSourceError(
        "auth",
        sourceMessage(
          response.body,
          "The invoicing system refused the key. Paste a new key with invoice read and payment access.",
        ),
      );
    if (response.status !== 200)
      throw new InvoiceSourceError(
        "unreachable",
        `The invoicing system answered HTTP ${response.status} for ${what}.`,
      );
    return parse(schema, response.body, what);
  };
  const paymentsPath = (project: string, invoice: string) =>
    `/api/v1/projects/${encodeURIComponent(project)}/invoices/${encodeURIComponent(invoice)}/payments`;
  return {
    /** Every invoice, all pages: a complete listing, so a missing invoice is really gone. */
    async invoices(): Promise<BooksInvoice[]> {
      const out: BooksInvoice[] = [];
      for (let page = 1; page <= 500; page++) {
        const result = await read(
          `/api/v1/invoices?page=${page}&limit=100`,
          listSchema,
          "invoices",
        );
        out.push(...result.data.map(booksInvoice));
        if (page >= result.meta.total_pages || result.data.length === 0)
          return out;
      }
      throw new InvoiceSourceError(
        "invalid_response",
        "The source listed more invoices than the books read in one run.",
      );
    },
    /** Earned work from `from` through `to`, read in windows the contract allows, one row per day or retainer period. */
    async earnedWork(from: string, to: string): Promise<BooksEarned[]> {
      const rows = new Map<string, BooksEarned>();
      for (
        let start = new Date(`${from}T00:00:00Z`);
        start.toISOString().slice(0, 10) <= to;
        start = new Date(start.getTime() + 366 * 86400000)
      ) {
        const windowFrom = start.toISOString().slice(0, 10);
        const end = new Date(start.getTime() + 365 * 86400000)
          .toISOString()
          .slice(0, 10);
        const windowTo = end < to ? end : to;
        const result = await read(
          `/api/v1/billing/earned-work?from=${windowFrom}&to=${windowTo}`,
          earnedSchema,
          "earned work",
        );
        for (const group of result.data.projects) {
          const project = group.project.id;
          for (const row of group.time) {
            const cents = toCents(row.amount);
            if (cents <= BigInt(0)) continue;
            const key = `${project}:${row.date}`;
            const prior = rows.get(`time:${key}`);
            rows.set(`time:${key}`, {
              kind: "time",
              external_ref: key,
              project_ref: project,
              earned_from: row.date,
              earned_to: row.date,
              amount_cents: (
                cents + (prior ? BigInt(prior.amount_cents) : BigInt(0))
              ).toString(),
            });
          }
          for (const row of group.scheduled) {
            const cents = toCents(row.amount);
            if (cents <= BigInt(0)) continue;
            if (row.period_end < row.period_start)
              throw new InvoiceSourceError(
                "invalid_response",
                "The source returned a retainer period that ends before it starts.",
              );
            const key = `${row.retainer_id}:${row.period_start}`;
            rows.set(`scheduled:${key}`, {
              kind: "scheduled",
              external_ref: key,
              project_ref: project,
              earned_from: row.period_start,
              earned_to: row.period_end,
              amount_cents: cents.toString(),
            });
          }
        }
      }
      return [...rows.values()];
    },
    async record(input: {
      project_ref: string;
      invoice_external_id: string;
      amount_cents: string;
      paid_date: string;
      link_id: string;
    }): Promise<PushOutcome> {
      const response = await call(
        "POST",
        paymentsPath(input.project_ref, input.invoice_external_id),
        {
          amount: toDollars(input.amount_cents),
          paid_date: input.paid_date,
          method: "ach",
          reference: "Recorded by the books from a matched deposit",
          external_id: input.link_id,
        },
      );
      if (response.status === 200 || response.status === 201)
        return {
          outcome: "recorded",
          external_payment_id: parse(paymentSchema, response.body, "a payment")
            .data.payment.id,
        };
      if (response.status === 401)
        throw new InvoiceSourceError(
          "auth",
          "The invoicing system refused the key.",
        );
      if (response.status === 403)
        throw new InvoiceSourceError(
          "auth",
          sourceMessage(
            response.body,
            "The key cannot record payments. Give it payment access.",
          ),
        );
      if (response.status === 409)
        return {
          outcome: "failed",
          error:
            "The invoicing system already holds a different payment for this link.",
        };
      if (response.status === 404)
        return {
          outcome: "failed",
          error: "The invoice no longer exists in the invoicing system.",
        };
      if (response.status === 422 || response.status === 400)
        return {
          outcome: "failed",
          error: sourceMessage(
            response.body,
            "The invoicing system refused the payment.",
          ),
        };
      return {
        outcome: "retry",
        error: `The invoicing system answered HTTP ${response.status}.`,
      };
    },
    async remove(input: {
      project_ref: string;
      invoice_external_id: string;
      external_payment_id: string;
    }): Promise<PushOutcome> {
      const response = await call(
        "DELETE",
        `${paymentsPath(input.project_ref, input.invoice_external_id)}/${encodeURIComponent(input.external_payment_id)}`,
      );
      if (
        response.status === 200 ||
        response.status === 204 ||
        response.status === 404
      )
        return { outcome: "removed" };
      if (response.status === 401)
        throw new InvoiceSourceError(
          "auth",
          "The invoicing system refused the key.",
        );
      if (
        response.status === 403 ||
        response.status === 409 ||
        response.status === 422
      )
        return {
          outcome: "failed",
          error: sourceMessage(
            response.body,
            "The invoicing system keeps this payment.",
          ),
        };
      return {
        outcome: "retry",
        error: `The invoicing system answered HTTP ${response.status}.`,
      };
    },
  };
}
