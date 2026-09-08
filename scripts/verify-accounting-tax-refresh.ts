import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  calculateTaxLink,
  refreshTaxLink,
} from "../src/lib/accounting/tax-refresh";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (a: unknown, b: unknown) => {
    assert.deepEqual(a, b);
    checks++;
  };
  const fail = async (f: () => Promise<unknown>, pattern: RegExp) => {
    await assert.rejects(f, pattern);
    checks++;
  };
  const admin = async (q: string, p: unknown[] = []) => {
    await db.exec("RESET ROLE");
    try {
      return await db.query<Record<string, unknown>>(q, p);
    } finally {
      await db.exec("SET ROLE authenticated");
    }
  };
  const server = async (command: object) => {
    await db.exec("RESET ROLE; SET ROLE service_role");
    try {
      return (
        await db.query<{ r: any }>(
          "SELECT accounting.tax_refresh_server($1) r",
          [JSON.stringify(command)],
        )
      ).rows[0].r;
    } finally {
      await db.exec("RESET ROLE; SET ROLE authenticated");
    }
  };
  const cmd = async (c: object, k = randomUUID()) =>
    (
      await db.query<{ r: any }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
        [k, JSON.stringify(c)],
      )
    ).rows[0].r;
  const view = async () =>
    (await db.query<{ r: any }>("SELECT accounting.tax_link($1) r", [estimate]))
      .rows[0].r;
  const estimate = randomUUID(),
    id = randomUUID(),
    income = [
      {
        id: "business",
        name: "Company",
        amount: 12345,
        income_type: "k1",
        subject_to_se: false,
      },
    ];
  await admin(
    "INSERT INTO tax_estimates(id,tax_year,income_sources,tax_classification) VALUES($1,2026,$2,'s_corp')",
    [estimate, JSON.stringify(income)],
  );
  await admin(
    "UPDATE public.business_profile SET tax_classification_since=2027 WHERE id=1",
  );
  const body = {
    cutoff_mode: "fixed",
    through: "2026-08-31",
    business_target_id: "business",
    forecast: { method: "manual", remaining_cents: "0" },
    separate_targets: [],
    payroll: null,
    manual_separate_review: null,
  };
  const command = {
    type: "tax.link.save",
    id,
    estimate_id: estimate,
    expected_version: 0,
    enabled: true,
    body,
    verified: true,
    reason: "Synthetic opt-in",
  };
  const key = randomUUID();
  check((await cmd(command, key)).version, 1);
  check((await cmd(command, key)).version, 1);
  await fail(() => cmd(command), /ACCT_STALE_VERSION/);
  check((await view()).current, false);
  check(
    (await server({ type: "due" })).map((r: any) => r.id),
    [id],
  );
  const start = await server({ type: "start", link_id: id });
  check(start.state, "running");
  check(start.inputs.estimate.income_sources, income);
  check(start.inputs.source.through, "2026-08-31");
  const computed = calculateTaxLink(start.inputs);
  check(computed.calculation.issues[0].key, "business");
  check(computed.outputs.totalIncome, 12345);
  check(start.inputs.estimate.income_sources, income);
  check(computed.outputs.federalTax.bracketBreakdown.at(-1)?.rangeEnd, null);
  const calls: string[] = [];
  await fail(
    () =>
      refreshTaxLink(async (c) => {
        calls.push(c.type as string);
        if (c.type === "start") return start;
        throw new Error("Uncertain finish response");
      }, id),
    /Uncertain finish/,
  );
  check(calls, ["start", "finish"]);
  const invalid = structuredClone(start);
  invalid.inputs.estimate.income_sources[0].amount = Number.NaN;
  calls.length = 0;
  const badInput = await refreshTaxLink(async (c) => {
    calls.push(c.type as string);
    return c.type === "start" ? invalid : { state: "failed" };
  }, id);
  check(badInput.state, "failed");
  check(calls, ["start", "fail"]);
  check((await server({ type: "start", link_id: id })).state, "busy");
  const payload = {
    calculation: {
      definition_version: 1,
      overlay: { income: [], gains: [], payments: [] },
      issues: [],
    },
    outputs: { test: true },
  };
  check(
    (
      await server({
        type: "finish",
        link_id: id,
        lease_token: randomUUID(),
        payload,
      })
    ).state,
    "superseded",
  );
  const done = await server({
    type: "finish",
    link_id: id,
    lease_token: start.lease_token,
    payload,
  });
  check(done.state, "fresh");
  check((await view()).current, true);
  check((await server({ type: "start", link_id: id })).state, "fresh");
  check(await server({ type: "due" }), []);
  const retained = (await view()).snapshot;
  check(retained.inputs.estimate.income_sources, income);
  check(
    retained.financial_revision,
    (await view()).snapshot.financial_revision,
  );
  // The target retains a current cache, not a separate snapshot history table.
  await fail(
    () =>
      db.query<Record<string, unknown>>(
        "UPDATE accounting.tax_links SET results='{}' WHERE id=$1",
        [id],
      ),
    /permission denied/,
  );
  const forced = await server({ type: "start", link_id: id, force: true });
  await admin("UPDATE tax_estimates SET additional_deductions=1 WHERE id=$1", [
    estimate,
  ]);
  check((await view()).current, false);
  check(
    (
      await server({
        type: "finish",
        link_id: id,
        lease_token: forced.lease_token,
        payload,
      })
    ).state,
    "stale",
  );
  check((await view()).link.status, "stale");
  const retry = await server({ type: "start", link_id: id });
  check(retry.inputs.estimate.additional_deductions, 1);
  await cmd({
    type: "account.create",
    id: randomUUID(),
    code: "",
    name: "Synthetic",
    account_type: "expense",
    normal_side: "debit",
  });
  check(
    (
      await server({
        type: "finish",
        link_id: id,
        lease_token: retry.lease_token,
        payload,
      })
    ).state,
    "stale",
  );
  check((await view()).link.version, 1);
  const interrupted = await server({ type: "start", link_id: id });
  await admin(
    "UPDATE accounting.tax_links SET inputs=jsonb_set(inputs,'{_refresh,until}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1",
    [id],
  );
  check((await server({ type: "due" }))[0].id, id);
  const replacement = await server({ type: "start", link_id: id });
  check(replacement.lease_token !== interrupted.lease_token, true);
  check(
    (
      await server({
        type: "finish",
        link_id: id,
        lease_token: interrupted.lease_token,
        payload,
      })
    ).state,
    "superseded",
  );
  check(
    (
      await server({
        type: "fail",
        link_id: id,
        lease_token: replacement.lease_token,
        error: "Synthetic failure",
      })
    ).state,
    "failed",
  );
  check((await view()).link.error, "Synthetic failure");
  check(await server({ type: "due" }), []);
  await admin(
    "UPDATE accounting.tax_links SET inputs=inputs-'retry_after' WHERE id=$1",
    [id],
  );
  check((await server({ type: "due" })).length, 1);
  const recovery = await server({ type: "start", link_id: id });
  const recovered = await server({
    type: "finish",
    link_id: id,
    lease_token: recovery.lease_token,
    payload,
  });
  check(recovered.state, "fresh");
  check((await view()).snapshot.id, id);
  check(retained.inputs.estimate.additional_deductions, 0);
  check(
    (
      await admin("SELECT income_sources FROM tax_estimates WHERE id=$1", [
        estimate,
      ])
    ).rows[0].income_sources,
    income,
  );
  const ownerVersion = (await view()).link.version;
  await cmd({ ...command, expected_version: ownerVersion, enabled: false });
  check((await view()).current, false);
  check((await server({ type: "start", link_id: id })).state, "disabled");
  check((await view()).estimate.income_sources, income);
  check((await view()).link.version, ownerVersion + 1);
  await fail(
    () =>
      db.query<Record<string, unknown>>(
        "SELECT accounting.tax_refresh_server('{}')",
      ),
    /permission denied/,
  );
  await fail(
    () =>
      db.query<Record<string, unknown>>("SELECT * FROM accounting.tax_links"),
    /permission denied/,
  );
  await db.query<Record<string, unknown>>(
    "SELECT set_config('request.jwt.claim.sub',$1,false)",
    [randomUUID()],
  );
  await fail(() => view(), /ACCT_FORBIDDEN/);
  await db.close();
  console.log(`${checks} tax refresh checks passed.`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
