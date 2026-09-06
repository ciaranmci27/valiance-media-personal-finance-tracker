import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "pg";
import { fixtureAccountId } from "../src/lib/accounting/fixtures";

// Exercise the actual Next.js request boundary against the marked fixture server.
async function main() {
  const base = "http://127.0.0.1:3108";
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const db = new Client({
    connectionString: "postgresql://postgres@127.0.0.1:5447/accounting_test",
  });
  await db.connect();
  try {
    check((await db.query("SELECT label FROM acct_test_marker")).rows, [
      { label: "synthetic-local-accounting" },
    ]);
    const response = await fetch(`${base}/accounting`);
    check(response.status, 200);
    assert.match(await response.text(), /Isolated test books/);
    checks++;
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
    console.log(
      `Accounting HTTP and private evidence: ${checks} assertions passed.`,
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
