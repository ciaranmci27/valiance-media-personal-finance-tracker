import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { fixtureAccountId } from "../src/lib/accounting/fixtures";

async function main() {
  const base = "http://127.0.0.1:3108",
    db = new Client({
      connectionString: "postgresql://postgres@127.0.0.1:5447/accounting_test",
    });
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  await db.connect();
  try {
    check((await db.query("SELECT label FROM acct_test_marker")).rows, [
      { label: "synthetic-local-accounting" },
    ]);
    async function post(path: string, body: FormData | object) {
      const form = body instanceof FormData;
      const r = await fetch(`${base}/api/accounting${path}`, {
        method: "POST",
        headers: {
          Origin: base,
          ...(!form ? { "Content-Type": "application/json" } : {}),
        },
        body: form ? body : JSON.stringify(body),
      });
      const data = await r.json();
      assert.equal(r.status, 200, JSON.stringify(data));
      return data;
    }
    const command = (value: object) =>
      post("", { key: randomUUID(), command: value });
    const csv =
        "\uFEFFid,date,description,amount\nmay-receipt,2026-05-12,Synthetic May bank receipt,500.00\n",
      docId = randomUUID();
    const upload = new FormData();
    upload.set("id", docId);
    upload.set(
      "file",
      new File([csv], "synthetic-may-statement.csv", { type: "text/csv" }),
    );
    const doc = await post("/documents", upload);
    const options = {
        delimiter: ",",
        headerRow: 0,
        dateFormat: "yyyy-mm-dd",
        decimal: ".",
        thousands: "",
      },
      mapping = {
        date: "date",
        description: "description",
        amount: "amount",
        externalId: "id",
        sign: "deposits_positive",
        accountId: fixtureAccountId(1),
      };
    const form = new FormData();
    form.set("file", new File([csv], "synthetic-may-statement.csv"));
    form.set("phase", "preview");
    form.set("mode", "bank");
    form.set("options", JSON.stringify(options));
    form.set("mapping", JSON.stringify(mapping));
    const parsed = await post("/imports", form);
    check(parsed.fileHash, doc.content_hash);
    check(parsed.errorCount, 0);
    check(parsed.groups[0].bank_amount_cents, "50000");
    // Clear only unfinished statements created by this acceptance script, retaining their history.
    const old = await db.query(
      "SELECT id,version FROM acct_reconciliations WHERE account_id=$1 AND from_date='2026-05-01' AND status='in_progress' AND notes LIKE 'Synthetic statement HTTP acceptance%'",
      [fixtureAccountId(1)],
    );
    for (const r of old.rows)
      await command({
        type: "reconciliation.cancel",
        id: r.id,
        expected_version: r.version,
        reason: "Repeat synthetic acceptance with a fresh statement",
      });
    const id = randomUUID();
    let r = await command({
      type: "reconciliation.create",
      id,
      account_id: fixtureAccountId(1),
      from: "2026-05-01",
      to: "2026-05-31",
      opening_cents: "1228000",
      ending_cents: "1278000",
      declared_count: 1,
      declared_debits_cents: "50000",
      declared_credits_cents: "0",
      document_id: doc.id,
      predecessor_id: null,
      notes: "Synthetic statement HTTP acceptance",
    });
    const imports = {
      type: "statement.import",
      id,
      expected_version: r.version,
      document_id: doc.id,
      file_hash: parsed.fileHash,
      mapping_hash: parsed.mappingHash,
      mapping: { options, columns: mapping },
      restore_removed: false,
      items: parsed.groups.map(
        (
          g: {
            external_id: string;
            fingerprint: string;
            entry_date: string;
            memo: string;
            bank_amount_cents: string;
            raw: object[];
          },
          i: number,
        ) => ({
          external_id: g.external_id,
          fingerprint: g.fingerprint,
          entry_date: g.entry_date,
          description: g.memo,
          amount_cents: g.bank_amount_cents,
          raw: g.raw[0],
          source_row: i + 2,
        }),
      ),
    };
    r = await command(imports);
    check(r.added, 1);
    r = await command({ ...imports, expected_version: r.version });
    check(r.skipped, 1);
    const sources = await fetch(
      `${base}/api/accounting?view=statement-sources&statement=${id}`,
    );
    check(sources.status, 200);
    check((await sources.json()).files[0].rows, 1);
    console.log(
      `Statement multipart parsing, original-file integrity, persistence, replay and source read: ${checks} assertions passed. Synthetic statement ${id}.`,
    );
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
