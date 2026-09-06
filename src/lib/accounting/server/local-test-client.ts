import "server-only";
import { Pool } from "pg";
import { isLocalOrTestEnv } from "@/lib/env";

const allowed = new Map<string, readonly string[]>([
  ["acct_is_owner", []],
  ["acct_command", ["p_key", "p_command"]],
  ["acct_execute", ["p_key", "p_command"]],
  ["acct_operate", ["p_key", "p_command"]],
  ["acct_close_history", []],
  ["acct_history_view", []],
  ["acct_transfers_view", ["p_from", "p_to", "p_offset"]],
  ["acct_bank_review", ["p_group", "p_query", "p_offset"]],
  ["acct_statement_sources", ["p_statement"]],
  ["acct_rules_view", []],
  ["acct_feed_view", []],
  ["acct_rules_preview", ["p_from", "p_to", "p_rule", "p_offset"]],
  [
    "acct_history_preview",
    ["p_from", "p_to", "p_monthly", "p_accounts", "p_totals"],
  ],
  ["acct_snapshot_read", ["p_id"]],
  ["acct_reconciliation_view", ["p_id", "p_account", "p_offset", "p_query"]],
  ["acct_close_checklist", ["p_month"]],
  ["acct_period_impact", ["p_month"]],
  ["acct_clearing_view", ["p_as_of", "p_account"]],
  ["acct_workspace", ["p_from", "p_to", "p_entry_id"]],
  ["acct_register", ["p_filter"]],
  ["acct_account_ledger", ["p_account", "p_from", "p_to", "p_offset"]],
  ["acct_manage", []],
  ["acct_export", []],
  ["acct_books_export", []],
  ["acct_books_backup", []],
  ["acct_entry_evidence", ["p_entry"]],
  ["acct_imports", ["p_batch", "p_offset"]],
  ["acct_documents_read", ["p_id", "p_offset"]],
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
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const keys = service
        ? name === "acct_feed_server"
          ? ["p_command"]
          : undefined
        : allowed.get(name);
      if (!keys)
        return { data: null, error: { message: "Unsupported test command." } };
      const connection = await pool!.connect();
      try {
        const marker = await connection.query(
          "SELECT label FROM public.acct_test_marker",
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
        const values = keys.map((k) =>
          args[k] === undefined
            ? null
            : typeof args[k] === "object" && args[k] !== null
              ? JSON.stringify(args[k])
              : args[k],
        );
        const result = await connection.query(
          `SELECT public.${name}(${keys.map((_, i) => "$" + (i + 1)).join(",")}) AS result`,
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
