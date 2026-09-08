import "server-only";
import { Pool } from "pg";
import { isLocalOrTestEnv } from "@/lib/env";

const allowed = new Map<string, readonly string[]>([
  ["context", ["view", "params"]],
  ["operate", ["command"]],
  ["workspace", ["from_date", "to_date"]],
  ["transactions", ["filter", "page"]],
  ["entry_detail", ["entry"]],
  ["documents", ["filter"]],
  ["bank_review", ["filter"]],
  ["prior_treatment", ["descriptor_key", "bank_account_id", "max_rows"]],
  ["rules_preview", ["filter"]],
  ["imports", ["batch"]],
  ["history_preview", ["controls"]],
  ["import_compare", ["batch_a", "batch_b", "filter"]],
  ["close_checklist", ["month"]],
  ["tax_source", ["year", "cutoff"]],
  ["tax_link", ["id"]],
  ["payroll", ["view"]],
  ["registers", ["view"]],
  ["contractor_report", ["year", "cutoff"]],
  ["report", ["kind", "params"]],
  ["report_lines", ["kind", "params", "account"]],
  ["ledger", ["account", "from_date", "to_date"]],
  ["snapshot_read", ["id"]],
  ["books_package", ["params"]],
  ["support_report", ["params"]],
]);
let pool: Pool | undefined;
/** A separately configured loopback-only fixture database for integration testing. */
export function localAccountingTestClient() {
  return fixtureClient(false);
}
export function localAccountingFeedService() {
  return fixtureClient(true);
}
function fixtureClient(service: boolean) {
  const url = process.env.ACCOUNTING_TEST_DATABASE_URL;
  if (!url) return null;
  const parsed = new URL(url);
  if (
    !isLocalOrTestEnv ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/accounting_test"
  ) {
    throw new Error(
      "The accounting test database must be an explicit local fixture database.",
    );
  }
  pool ??= new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5000,
  });
  return {
    async recordStorageObject(key: string, mime: string, size: number) {
      if (service) throw new Error("Owner storage uploads only.");
      const connection = await pool!.connect();
      try {
        const marker = await connection.query(
          "SELECT label FROM public.accounting_test_marker",
        );
        if (
          marker.rows.length !== 1 ||
          marker.rows[0].label !== "synthetic-local-accounting"
        )
          throw new Error("Accounting test database marker is missing.");
        await connection.query("BEGIN");
        await connection.query("SET LOCAL ROLE authenticated");
        await connection.query(
          "SELECT set_config('request.jwt.claim.sub',$1,true)",
          ["10000000-0000-4000-8000-000000000001"],
        );
        await connection.query(
          "INSERT INTO storage.objects(bucket_id,name,metadata) SELECT 'accounting-private',$1,$2::jsonb WHERE NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='accounting-private' AND name=$1)",
          [key, JSON.stringify({ mimetype: mime, size })],
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = service
        ? ["sync_server", "tax_refresh_server"].includes(name)
          ? ["command"]
          : undefined
        : allowed.get(name);
      if (!keys)
        return { data: null, error: { message: "Unsupported test command." } };
      const connection = await pool!.connect();
      try {
        const marker = await connection.query(
          "SELECT label FROM public.accounting_test_marker",
        );
        if (
          marker.rows.length !== 1 ||
          marker.rows[0].label !== "synthetic-local-accounting"
        )
          throw new Error("Accounting test database marker is missing.");
        await connection.query("BEGIN");
        await connection.query(
          service
            ? "SET LOCAL ROLE service_role"
            : "SET LOCAL ROLE authenticated",
        );
        await connection.query(
          "SELECT set_config('request.jwt.claim.sub',$1,true)",
          [service ? "" : "10000000-0000-4000-8000-000000000001"],
        );
        const values = keys
          .filter((k) => k in args)
          .map((k) =>
            args[k] === undefined
              ? null
              : typeof args[k] === "object" && args[k] !== null
                ? JSON.stringify(args[k])
                : args[k],
          );
        const result = await connection.query(
          `SELECT accounting.${name}(${keys
            .filter((k) => k in args)
            .map((k, i) => `${k} => $${i + 1}`)
            .join(",")}) AS result`,
          values,
        );
        await connection.query("COMMIT");
        return { data: result.rows[0].result, error: null };
      } catch (error) {
        await connection.query("ROLLBACK");
        return {
          data: null,
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Test database request failed.",
          },
        };
      } finally {
        connection.release();
      }
    },
  };
}
