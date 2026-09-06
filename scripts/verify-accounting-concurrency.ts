import assert from "node:assert/strict";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { fixtureOwner, fixtureAccountId } from "../src/lib/accounting/fixtures";

async function main() {
  const url =
    process.env.ACCOUNTING_TEST_DATABASE_URL ??
    "postgresql://postgres@127.0.0.1:5447/accounting_test";
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/accounting_test")
    throw new Error("Only the dedicated local fixture database is allowed.");
  const clients = [
    new Client({ connectionString: url }),
    new Client({ connectionString: url }),
    new Client({ connectionString: url }),
  ];
  const [a, b, operator] = clients;
  await Promise.all(clients.map((c) => c.connect()));
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  async function command(client: Client, value: object, key = randomUUID()) {
    return (
      await client.query("SELECT public.acct_operate($1,$2::jsonb) result", [
        key,
        JSON.stringify(value),
      ])
    ).rows[0].result;
  }
  try {
    const marker = await operator.query(
      "SELECT label FROM public.acct_test_marker",
    );
    check(marker.rows, [{ label: "synthetic-local-accounting" }]);
    await operator.query(
      "SELECT set_config('request.jwt.claim.sub',$1,false)",
      [fixtureOwner],
    );
    const revision = async () =>
      (
        await operator.query(
          "SELECT financial_revision::text revision FROM acct_settings",
        )
      ).rows[0].revision;
    for (const client of [a, b]) {
      await client.query("SET ROLE authenticated");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub',$1,false)",
        [fixtureOwner],
      );
      await client.query("SET statement_timeout='8s'");
    }
    await operator.query("SET statement_timeout='8s'");
    const id = randomUUID(),
      key = randomUUID();
    const draft = {
      type: "draft.save",
      id,
      expected_version: 0,
      entry_date: "2091-01-05",
      memo: "Isolated concurrency fixture",
      lines: [
        { account_id: fixtureAccountId(1), amount_cents: "1", memo: "" },
        { account_id: fixtureAccountId(2), amount_cents: "-1", memo: "" },
      ],
    };
    // Both connections submit the same receipt. One waits, then returns the original result.
    await a.query("BEGIN");
    const first = await command(a, draft, key);
    let settled = false;
    const repeat = command(b, draft, key).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    check(settled, false);
    await a.query("COMMIT");
    check(await repeat, first);
    check(
      (
        await operator.query(
          "SELECT count(*)::integer n FROM acct_journal_entries WHERE id=$1",
          [id],
        )
      ).rows[0].n,
      1,
    );
    // Two approvals at one version produce one posting and one stale-version rejection.
    await a.query("BEGIN");
    await command(a, { type: "entry.post", id, expected_version: 1 });
    const competing = command(b, {
      type: "entry.post",
      id,
      expected_version: 1,
    }).then(
      () => ({ error: "" }),
      (error) => ({ error: String(error.message) }),
    );
    await a.query("COMMIT");
    assert.match((await competing).error, /ACCT_STALE_VERSION/);
    checks++;
    // A reviewed close waits behind posting and rejects its now-stale report revision.
    const secondId = randomUUID();
    await command(a, { ...draft, id: secondId, entry_date: "2091-02-05" });
    await command(operator, {
      type: "year.configure",
      id: randomUUID(),
      year: 2024,
      classification: "s_corp",
      expected_revision: await revision(),
    });
    const reviewedRevision = await revision();
    await a.query("BEGIN");
    await command(a, { type: "entry.post", id: secondId, expected_version: 1 });
    let closeFinished = false;
    const close = command(operator, {
      type: "period.close",
      id: randomUUID(),
      month: "2024-01-01",
      expected_revision: reviewedRevision,
    })
      .then(
        () => ({ error: "" }),
        (error) => ({ error: String(error.message) }),
      )
      .finally(() => {
        closeFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    check(closeFinished, false);
    await a.query("COMMIT");
    assert.match((await close).error, /ACCT_STALE_VERSION/);
    checks++;
    await command(operator, {
      type: "period.close",
      id: randomUUID(),
      month: "2024-01-01",
      expected_revision: await revision(),
    });
    check(
      (
        await operator.query(
          "SELECT is_locked FROM acct_periods WHERE month_start='2024-01-01'",
        )
      ).rows[0].is_locked,
      true,
    );
    // A writer waiting behind a close must recheck the period after the lock is released.
    await operator.query("BEGIN");
    await command(operator, {
      type: "period.close",
      id: randomUUID(),
      month: "2024-03-01",
      expected_revision: await revision(),
    });
    const blocked = command(b, {
      ...draft,
      id: randomUUID(),
      entry_date: "2024-03-05",
    }).then(
      () => ({ error: "" }),
      (error) => ({ error: String(error.message) }),
    );
    await operator.query("COMMIT");
    assert.match((await blocked).error, /ACCT_PERIOD_LOCKED/);
    checks++;
    // Cleanup is a supported reversal in the fixture books, preserving audit history.
    await command(operator, {
      type: "period.reopen",
      id: randomUUID(),
      month: "2024-01-01",
      expected_revision: await revision(),
      reason: "End isolated concurrency test",
    });
    for (const entry of [id, secondId])
      await command(a, {
        type: "entry.reverse",
        id: entry,
        expected_version: 2,
        entry_date: "2091-03-31",
        reason: "Reverse isolated concurrency fixture",
      });
    console.log(
      `Real PostgreSQL concurrency: ${checks} assertions passed across three independent connections.`,
    );
  } finally {
    for (const client of clients) {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
