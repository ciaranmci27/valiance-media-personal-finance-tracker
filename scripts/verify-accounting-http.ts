import { fixtureDatabaseUrl, fixtureAppUrl } from "./accounting-fixture-target";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import { fixtureAccountId } from "../src/lib/accounting/fixtures";

// Exercise the actual Next.js request boundary against the marked fixture server.
async function main() {
  const base = fixtureAppUrl();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const db = new Client({
    connectionString: fixtureDatabaseUrl(),
  });
  await db.connect();
  try {
    check((await db.query("SELECT label FROM accounting_test_marker")).rows, [
      { label: "synthetic-local-accounting" },
    ]);
    const apiOnly = process.argv.includes("--api-only");
    const response = await fetch(
      `${base}/${apiOnly ? "api/accounting?from=2026-01-01&to=2026-12-31" : "accounting"}`,
    );
    check(response.status, 200);
    if (apiOnly) check(Array.isArray((await response.json()).entries), true);
    else {
      assert.match(await response.text(), /Isolated test books/);
      checks++;
    }
    check(
      (
        await fetch(`${base}/api/accounting`, {
          method: "POST",
          headers: {
            Origin: "https://untrusted.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    check(
      (
        await fetch(`${base}/api/accounting`, {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
    );
    const command = async (value: object) => {
      const r = await fetch(`${base}/api/accounting`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ key: randomUUID(), command: value }),
      });
      const result = await r.json();
      assert.equal(r.status, 200, JSON.stringify(result));
      return result;
    };
    const invalidRule = await fetch(`${base}/api/accounting`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({
        key: randomUUID(),
        command: {
          type: "rule.save",
          id: randomUUID(),
          expected_version: 0,
          name: "Invalid money boundary",
          priority: 1,
          description_mode: "exact",
          description: "test",
          bank_account_id: fixtureAccountId(1),
          direction: "decrease",
          min_cents: "0",
          max_cents: "not-money",
          match_payee_id: null,
          category_account_id: fixtureAccountId(6),
          assign_payee_id: null,
          reason: "Verify malformed money returns a validation response",
        },
      }),
    });
    check(invalidRule.status, 400);
    const feedConfig = await fetch(`${base}/api/accounting/feeds`);
    check(feedConfig.status, 200);
    check(await feedConfig.json(), {
      ready: false,
      isolated: true,
      workerEnabled: false,
    });
    const feedView = await fetch(`${base}/api/accounting?view=feeds`);
    check(feedView.status, 200);
    const feedJson = JSON.stringify(await feedView.json());
    check(feedJson.includes("ciphertext"), false);
    check(
      (await fetch(`${base}/api/accounting/jobs/feeds`, { method: "POST" }))
        .status,
      401,
    );
    check(
      (
        await fetch(`${base}/api/accounting/feeds`, {
          method: "POST",
          headers: {
            Origin: "https://untrusted.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    check(
      (
        await fetch(`${base}/api/accounting/feeds`, {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync", id: randomUUID() }),
        })
      ).status,
      409,
    );
    check(
      (
        await fetch(`${base}/api/accounting/feeds`, {
          method: "POST",
          headers: { Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync", id: "invalid" }),
        })
      ).status,
      400,
    );
    const csv =
      "group,date,memo,account,debit,credit\na,2026-04-01,Fixture CSV receipt,Checking,10.00,\na,2026-04-01,Fixture CSV receipt,Income,,10.00\n";
    const uploadId = randomUUID();
    const upload = async () => {
      const form = new FormData();
      form.set("id", uploadId);
      form.set(
        "file",
        new File([csv], "synthetic-http-import.csv", { type: "text/csv" }),
      );
      const r = await fetch(`${base}/api/accounting/documents`, {
        method: "POST",
        headers: { Origin: base },
        body: form,
      });
      const result = await r.json();
      assert.equal(r.status, 200, JSON.stringify(result));
      return result;
    };
    const doc = await upload();
    check(doc.state, "available");
    check((await upload()).id, doc.id);
    const download = await fetch(
      `${base}/api/accounting/documents?id=${doc.id}`,
    );
    check(download.status, 200);
    check(
      createHash("sha256")
        .update(Buffer.from(await download.arrayBuffer()))
        .digest("hex"),
      doc.content_hash,
    );
    check(download.headers.get("x-content-type-options"), "nosniff");
    const bad = new FormData();
    bad.set("id", randomUUID());
    bad.set(
      "file",
      new File(["<script>alert(1)</script>"], "receipt.svg", {
        type: "image/svg+xml",
      }),
    );
    check(
      (
        await fetch(`${base}/api/accounting/documents`, {
          method: "POST",
          headers: { Origin: base },
          body: bad,
        })
      ).status,
      400,
    );
    const options = {
      delimiter: ",",
      headerRow: 0,
      dateFormat: "yyyy-mm-dd",
      decimal: ".",
      thousands: "",
    };
    const inspectForm = new FormData();
    inspectForm.set("file", new File([csv], "synthetic-http-import.csv"));
    inspectForm.set("phase", "inspect");
    inspectForm.set("options", JSON.stringify(options));
    const inspect = await fetch(`${base}/api/accounting/imports`, {
      method: "POST",
      headers: { Origin: base },
      body: inspectForm,
    });
    const inspected = await inspect.json();
    check(inspect.status, 200);
    check(inspected.rowCount, 2);
    check(inspected.values.account, ["Checking", "Income"]);
    const bomCsv = "\uFEFF" + csv,
      bomForm = new FormData();
    bomForm.set("file", new File([bomCsv], "synthetic-bom.csv"));
    bomForm.set("phase", "inspect");
    bomForm.set("options", JSON.stringify(options));
    const bomResponse = await fetch(`${base}/api/accounting/imports`, {
      method: "POST",
      headers: { Origin: base },
      body: bomForm,
    });
    check(bomResponse.status, 200);
    const bomInspection = await bomResponse.json();
    check(
      bomInspection.fileHash,
      createHash("sha256").update(bomCsv).digest("hex"),
    );
    check(bomInspection.headers, inspected.headers);
    const parseForm = new FormData();
    parseForm.set("file", new File([csv], "synthetic-http-import.csv"));
    parseForm.set("phase", "preview");
    parseForm.set("mode", "journal");
    parseForm.set("options", JSON.stringify(options));
    parseForm.set(
      "mapping",
      JSON.stringify({
        group: "group",
        date: "date",
        memo: "memo",
        account: "account",
        debit: "debit",
        credit: "credit",
        stableGroupIds: true,
        accounts: {
          Checking: fixtureAccountId(1),
          Income: fixtureAccountId(5),
        },
      }),
    );
    const parsed = await fetch(`${base}/api/accounting/imports`, {
      method: "POST",
      headers: { Origin: base },
      body: parseForm,
    });
    const preview = await parsed.json();
    check(parsed.status, 200);
    check(preview.errorCount, 0);
    check(preview.groups[0].lines[0].amount_cents, "1000");
    const entry = await command({
      type: "transaction.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2026-04-01",
      memo: "HTTP fixture draft",
      lines: preview.groups[0].lines,
      context: { kind: "income" },
    });
    await command({
      type: "document.link",
      id: doc.id,
      expected_version: doc.version,
      entry_id: entry.id,
    });
    const evidence = await (
      await fetch(`${base}/api/accounting?view=evidence&entry=${entry.id}`)
    ).json();
    check(evidence.documents[0].id, doc.id);
    await command({
      type: "draft.discard",
      id: entry.id,
      expected_version: entry.version,
      reason: "End HTTP fixture test",
    });
    const waveRun = randomUUID();
    const waveAccounts = { receivable: randomUUID(), equity: randomUUID() };
    for (const [kind, account_type, subtype, normal_side] of [
      ["receivable", "asset", "receivable", "debit"],
      ["equity", "equity", "owner_equity", "credit"],
    ] as const) {
      await command({
        type: "account.create",
        id: waveAccounts[kind],
        name: `Synthetic Wave ${kind} ${waveRun}`,
        code: "",
        account_type,
        subtype,
        normal_side,
        external_names: { wave: `Synthetic Wave ${kind} ${waveRun}` },
      });
    }
    const waveHeaders = [
      "Transaction ID",
      "Transaction Date",
      "Account Name",
      "Transaction Description",
      "Transaction Line Description",
      "Debit Amount (Two Column Approach)",
      "Credit Amount (Two Column Approach)",
      "Account Group",
      "Account Type",
      "Account ID",
      " ",
    ];
    const waveRows = [
      [
        `HTTP-OPEN-${waveRun}`,
        "2022-12-31",
        `Synthetic Wave receivable ${waveRun}`,
        "Synthetic carryover",
        "",
        "123.45",
        "0",
        "Asset",
        "Receivable",
        "",
        "",
      ],
      [
        `HTTP-OPEN-${waveRun}`,
        "2022-12-31",
        `Synthetic Wave equity ${waveRun}`,
        "Synthetic carryover",
        "",
        "0",
        "123.45",
        "Equity",
        "Retained Earnings: Profit",
        "",
        "",
      ],
      [
        `HTTP-ZERO-${waveRun}`,
        "2022-12-31",
        `Synthetic Wave equity ${waveRun}`,
        "Synthetic zero",
        "",
        "0",
        "0",
        "Equity",
        "Retained Earnings: Profit",
        "",
        "",
      ],
    ];
    const waveCsv = [waveHeaders, ...waveRows]
      .map((row) => row.join(","))
      .join("\n");
    const waveMapping = {
      group: "Transaction ID",
      date: "Transaction Date",
      memo: "Transaction Description",
      account: "Account Name",
      debit: "Debit Amount (Two Column Approach)",
      credit: "Credit Amount (Two Column Approach)",
      stableGroupIds: true,
      accounts: {
        [`Synthetic Wave receivable ${waveRun}`]: waveAccounts.receivable,
        [`Synthetic Wave equity ${waveRun}`]: waveAccounts.equity,
      },
    };
    const waveRequest = async (phase: string) => {
      const form = new FormData();
      form.set("file", new File([waveCsv], "synthetic-wave.csv"));
      form.set("phase", phase);
      form.set("mode", "journal");
      form.set("options", JSON.stringify(options));
      form.set("mapping", JSON.stringify(waveMapping));
      const response = await fetch(`${base}/api/accounting/imports`, {
        method: "POST",
        headers: { Origin: base },
        body: form,
      });
      const data = await response.json();
      check(response.status, 200);
      return data;
    };
    const waveInspection = await waveRequest("inspect");
    check(waveInspection.adapter, "wave");
    check(waveInspection.headers.at(-1), " ");
    check(waveInspection.accountProposals[0].subtype, "receivable");
    const wavePreview = await waveRequest("preview");
    check(wavePreview.errorCount, 0);
    check(wavePreview.groups[0].lines[0].amount_cents, "12345");
    check(wavePreview.groups[1].lines, []);
    check(typeof wavePreview.groups[1].exclusion_reason, "string");
    const batch = randomUUID();
    let imported = await command({
      type: "import.create",
      id: batch,
      source_system: "wave",
      source_scope: `synthetic-http-${waveRun}`,
      file_hash: wavePreview.fileHash,
      mapping_hash: wavePreview.mappingHash,
      file_name: "synthetic-wave.csv",
      mode: "journal",
      basis: "cash",
      expected_groups: 2,
      from: "2022-12-31",
      to: "2022-12-31",
    });
    const groups = wavePreview.groups.map(
      (g: Record<string, unknown>, ordinal: number) => ({
        ...g,
        id: randomUUID(),
        ordinal,
      }),
    );
    imported = await command({
      type: "import.stage",
      id: batch,
      expected_version: imported.version,
      groups,
    });
    const applied = await command({
      type: "import.apply",
      id: batch,
      expected_version: imported.version,
      group_ids: groups.map((g: { id: string }) => g.id),
    });
    check(applied.posted, 1);
    console.log(
      `Accounting HTTP and private evidence: ${checks} assertions passed (${apiOnly ? "API only; page gate remains separate" : "including accounting page"}).`,
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
