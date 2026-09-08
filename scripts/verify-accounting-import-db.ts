import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import {
  readCsv,
  journalGroups,
  bankGroups,
  type CsvOptions,
} from "../src/lib/accounting/imports/csv";

async function main() {
  const db = await accountingTestDb();
  let n = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    n++;
  };
  const rpc = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ r: T }>(sql, args)).rows[0].r;
  const cmd = (data: object, key = randomUUID()) =>
    rpc<{ id: string; version: number; posted?: number; drafted?: number }>(
      "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
      [key, JSON.stringify(data)],
    );
  const reject = async (c: object, r: RegExp) => {
    await assert.rejects(cmd(c), r);
    n++;
  };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  type State = {
    batches: { id: string; version: number; status: string }[];
    groups: { id: string; version: number; status: string; entry_id: string }[];
    counts: Record<string, number>;
  };
  const get = (id: string) =>
    rpc<State>("SELECT accounting.imports($1) r", [id]);
  try {
    await cmd({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === fixtureAccountId(1) ? "bank" : "none",
      })),
    });
    const opts: CsvOptions = {
      delimiter: ",",
      headerRow: 0,
      dateFormat: "yyyy-mm-dd",
      decimal: ".",
      thousands: "",
    };
    const csv =
      "Group,Date,Memo,Account,Amount\na,2025-12-01,Opening,Bank,1000\na,2025-12-01,Opening,Equity,-1000\nb,2026-01-05,Income,Bank,200\nb,2026-01-05,Income,Income,-200";
    const table = readCsv(csv, opts);
    const mapping = {
      group: "Group",
      date: "Date",
      memo: "Memo",
      account: "Account",
      amount: "Amount",
      stableGroupIds: true,
      accounts: {
        Bank: fixtureAccountId(1),
        Equity: fixtureAccountId(4),
        Income: fixtureAccountId(5),
      },
    };
    const parsed = journalGroups(table, opts, mapping);
    const id = randomUUID();
    const create = {
      type: "import.create",
      id,
      source_system: "wave",
      source_scope: "test-wave-business",
      file_hash: table.fileHash,
      mapping_hash: sha(JSON.stringify(mapping)),
      file_name: "synthetic.csv",
      mode: "journal",
      basis: "cash",
      expected_groups: 2,
      from: "2025-12-01",
      to: "2026-01-31",
    };
    await cmd(create);
    const groupIds = parsed.map(() => randomUUID());
    await cmd({
      type: "import.stage",
      id,
      expected_version: 1,
      groups: parsed.map((g, i) => ({ ...g, id: groupIds[i], ordinal: i })),
    });
    check((await get(id)).counts.new, 2);
    const apply = {
      type: "import.apply",
      id,
      expected_version: 2,
      group_ids: groupIds,
    };
    const key = randomUUID();
    const applied = await cmd(apply, key);
    check(await cmd(apply, key), applied);
    check(applied.posted, 2);
    await cmd({ type: "import.finish", id, expected_version: 3 });
    check(
      (await get(id)).batches.find((b) => b.id === id)?.status,
      "completed",
    );
    check(
      (
        await rpc<{ reports: { net_income_cents: string } }>(
          "SELECT accounting.workspace('2026-01-01','2026-12-31') r",
        )
      ).reports.net_income_cents,
      "20000",
    );
    check((await cmd({ ...create, id: randomUUID() })).id, id);
    const repeat = randomUUID();
    await cmd({ ...create, id: repeat, file_hash: sha(csv + "\n") });
    await cmd({
      type: "import.stage",
      id: repeat,
      expected_version: 1,
      groups: parsed.map((g, i) => ({ ...g, id: randomUUID(), ordinal: i })),
    });
    check((await get(repeat)).counts.duplicate, 2);
    const changed = randomUUID();
    const altered = journalGroups(
      readCsv(csv.replace(/200/g, "250"), opts),
      opts,
      mapping,
    );
    await cmd({ ...create, id: changed, file_hash: sha("changed") });
    await cmd({
      type: "import.stage",
      id: changed,
      expected_version: 1,
      groups: altered.map((g, i) => ({ ...g, id: randomUUID(), ordinal: i })),
    });
    check((await get(changed)).counts.exception, 1);
    await reject(
      { type: "import.finish", id: changed, expected_version: 2 },
      /ACCT_IMPORT_INCOMPLETE/,
    );
    const bankCsv =
      "Date,Memo,Amount\n2026-01-05,Income,200\n2026-01-09,Software,-12.50";
    const bank = bankGroups(readCsv(bankCsv, opts), opts, {
      date: "Date",
      description: "Memo",
      amount: "Amount",
      sign: "deposits_positive",
      accountId: fixtureAccountId(1),
    });
    const bankId = randomUUID();
    await cmd({
      ...create,
      id: bankId,
      source_system: "csv",
      source_scope: "checking",
      file_hash: sha(bankCsv),
      mode: "bank",
    });
    const bankGroupIds = bank.map(() => randomUUID());
    await cmd({
      type: "import.stage",
      id: bankId,
      expected_version: 1,
      groups: bank.map((g, i) => ({ ...g, id: bankGroupIds[i], ordinal: i })),
    });
    const bankState = await get(bankId);
    check(bankState.counts.ready, 2);
    check(bankState.counts.new, 2);
    const existing = (await get(id)).groups[1].entry_id;
    await cmd({
      type: "import.resolve",
      id: bankGroupIds[0],
      expected_version: 1,
      resolution: "match",
      entry_id: existing,
      reason: "Same cash receipt already imported from Wave.",
    });
    const staged = await get(bankId);
    const v = staged.batches.find((b) => b.id === bankId)!.version;
    const imported = await cmd({
      type: "import.apply",
      id: bankId,
      expected_version: v,
      group_ids: [bankGroupIds[1]],
    });
    check(imported.drafted, 1);
    check(
      (
        await rpc<{
          reports: { net_income_cents: string };
          draft_count: number;
        }>("SELECT accounting.workspace('2026-01-01','2026-12-31') r")
      ).reports.net_income_cents,
      "20000",
    );
    const register = await rpc<{ total: number }>(
      "SELECT accounting.transactions($1) r",
      [JSON.stringify({ source: "csv" })],
    );
    check(register.total, 1);
    await db.exec("RESET ROLE;SET ROLE service_role;");
    await assert.rejects(
      db.query("SELECT accounting.imports()"),
      /permission denied/,
    );
    n++;
    console.log(`Accounting import persistence: ${n} assertions passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
