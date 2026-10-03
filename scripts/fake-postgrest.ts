/**
 * A small stand-in for Supabase's PostgREST over a pglite database, for
 * tests that run real route handlers with the real supabase-js client. It
 * serves only what the finance API sends: rpc calls, selects with
 * eq/is/gte/lte/in/or filters, order and limit, and inserts. Every request
 * runs in its own transaction as service_role with service_role claims and no
 * user, the way PostgREST runs a service-key request. Requests are serialized
 * because pglite has one connection.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PGlite } from "@electric-sql/pglite";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Unsupported identifier ${name}`);
  return `"${name}"`;
};

function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function scalar(value: unknown) {
  return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
}

function filter(column: string, expression: string, params: unknown[]): string {
  const dot = expression.indexOf(".");
  const op = expression.slice(0, dot);
  const value = expression.slice(dot + 1);
  const col = ident(column);
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (op) {
    case "eq":
      return `${col}::text = ${bind(value)}`;
    case "neq":
      return `${col}::text <> ${bind(value)}`;
    case "gte":
      return `${col} >= ${bind(value)}`;
    case "lte":
      return `${col} <= ${bind(value)}`;
    case "gt":
      return `${col} > ${bind(value)}`;
    case "lt":
      return `${col} < ${bind(value)}`;
    case "is":
      if (value === "null") return `${col} IS NULL`;
      if (value === "true" || value === "false") return `${col} IS ${value.toUpperCase()}`;
      throw new Error(`Unsupported is.${value}`);
    case "in": {
      const items = value.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
      return items.length ? `${col}::text IN (${items.map((item) => bind(item.replace(/^"|"$/g, ""))).join(", ")})` : "FALSE";
    }
    default:
      throw new Error(`Unsupported operator ${op}`);
  }
}

/** maxRows plays PostgREST's db-max-rows: no select returns more rows than this. */
export async function startFakePostgrest(db: PGlite, options: { maxRows?: number } = {}) {
  const maxRows = options.maxRows ?? 1000;
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const asService = <T>(work: () => Promise<T>) =>
    serialized(async () => {
      await db.exec("RESET ROLE; BEGIN; SET LOCAL ROLE service_role;");
      await db.query("SELECT set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub','',true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      try {
        const result = await work();
        await db.exec("COMMIT;");
        return result;
      } catch (error) {
        await db.exec("ROLLBACK;");
        throw error;
      }
    });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const fail = (error: unknown) => {
      const code = (error as { code?: string }).code ?? "P0001";
      send(code === "23505" ? 409 : 400, { code, message: (error as Error).message, details: null, hint: null });
    };
    const rest = url.pathname.replace(/^\/rest\/v1\//, "");

    try {
      if (rest.startsWith("rpc/") && request.method === "POST") {
        const fn = rest.slice(4);
        const args = JSON.parse((await body(request)) || "{}") as Record<string, unknown>;
        const params: unknown[] = [];
        const named = Object.entries(args).map(([key, value]) => {
          params.push(scalar(value));
          return `${ident(key)} => $${params.length}`;
        });
        const result = await asService(() => db.query<{ r: unknown }>(`SELECT public.${ident(fn)}(${named.join(", ")}) AS r`, params));
        return send(200, result.rows[0]?.r ?? null);
      }

      const table = ident(rest);
      if (request.method === "GET") {
        const params: unknown[] = [];
        const where: string[] = [];
        let columns = "*";
        let order = "";
        let limit = maxRows;
        let offset = 0;
        for (const [key, value] of url.searchParams) {
          if (key === "select") columns = value === "*" ? "*" : value.split(",").map((c) => ident(c.trim())).join(", ");
          else if (key === "order")
            order =
              " ORDER BY " +
              value
                .split(",")
                .map((part) => {
                  const [col, dir] = part.split(".");
                  return `${ident(col)} ${dir === "desc" ? "DESC" : "ASC"}`;
                })
                .join(", ");
          else if (key === "limit") limit = Math.min(maxRows, Number(value));
          else if (key === "offset") offset = Number(value);
          else if (key === "or") {
            const parts = value.replace(/^\(|\)$/g, "").split(",");
            where.push(
              "(" +
                parts
                  .map((part) => {
                    const [col, ...rest] = part.split(".");
                    return filter(col, rest.join("."), params);
                  })
                  .join(" OR ") +
                ")",
            );
          } else where.push(filter(key, value, params));
        }
        const sql = `SELECT ${columns} FROM public.${table}${where.length ? " WHERE " + where.join(" AND ") : ""}${order} LIMIT ${limit} OFFSET ${offset}`;
        const rows = (await asService(() => db.query(sql, params))).rows;
        if ((request.headers.accept ?? "").includes("vnd.pgrst.object+json")) {
          if (rows.length !== 1)
            return send(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null });
          return send(200, rows[0]);
        }
        return send(200, rows);
      }

      if (request.method === "POST") {
        const payload = JSON.parse(await body(request)) as Record<string, unknown> | Record<string, unknown>[];
        const records = Array.isArray(payload) ? payload : [payload];
        const returning = (request.headers.prefer ?? "").includes("return=representation");
        const out: unknown[] = [];
        await asService(async () => {
          for (const record of records) {
            const keys = Object.keys(record);
            const params = keys.map((key) => scalar(record[key]));
            const result = await db.query(
              `INSERT INTO public.${table} (${keys.map(ident).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})${returning ? " RETURNING *" : ""}`,
              params,
            );
            out.push(...result.rows);
          }
        });
        return returning ? send(201, Array.isArray(payload) ? out : out[0]) : send(201);
      }
      if (request.method === "PATCH") {
        const changes = JSON.parse(await body(request)) as Record<string, unknown>;
        const keys = Object.keys(changes);
        if (keys.length === 0) return send(400, { code: "PGRST000", message: "Empty update" });
        const params: unknown[] = keys.map((key) => scalar(changes[key]));
        const where: string[] = [];
        for (const [key, value] of url.searchParams) {
          if (key === "select" || key === "columns") continue;
          where.push(filter(key, value, params));
        }
        const sql = `UPDATE public.${table} SET ${keys.map((key, i) => `${ident(key)} = $${i + 1}`).join(", ")}${
          where.length ? " WHERE " + where.join(" AND ") : ""
        } RETURNING *`;
        const rows = (await asService(() => db.query(sql, params))).rows;
        if ((request.headers.accept ?? "").includes("vnd.pgrst.object+json")) {
          if (rows.length !== 1)
            return send(406, {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: `The result contains ${rows.length} rows`,
              hint: null,
            });
          return send(200, rows[0]);
        }
        return send(200, rows);
      }
      return send(404, { code: "PGRST000", message: `Unsupported ${request.method} ${url.pathname}` });
    } catch (error) {
      return fail(error);
    }
  }

  const server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
