import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { fixtureAppUrl, fixtureDatabaseUrl } from "./accounting-fixture-target";
import { fixtureOwner } from "../src/lib/accounting/fixtures";
import {
  parsePatriot,
  type PatriotMapping,
  type PatriotPreview,
} from "../src/lib/accounting/patriot-import";
import { patriotItems } from "../src/lib/accounting/server/patriot-payload";

async function main() {
  const base = fixtureAppUrl();
  const db = new Client({ connectionString: fixtureDatabaseUrl() });
  const concurrent = new Client({ connectionString: fixtureDatabaseUrl() });
  await db.connect();
  await concurrent.connect();
  try {
    assert.deepEqual(
      (await db.query("SELECT label FROM public.accounting_test_marker")).rows,
      [{ label: "synthetic-local-accounting" }],
    );
    for (const c of [db, concurrent]) {
      await c.query("SET ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
        fixtureOwner,
      ]);
      await c.query("SET statement_timeout='10s'");
    }
    const defaults = (
      await db.query(
        'SELECT accounting.patriot_import(\'{"mode":"defaults"}\') r',
      )
    ).rows[0].r;
    const company = defaults.company_id ?? "TEST123";
    const command = async (command: object) =>
      (
        await db.query("SELECT accounting.operate($1::jsonb) r", [
          JSON.stringify({ key: randomUUID(), command }),
        ])
      ).rows[0].r;
    const mapping: PatriotMapping = defaults.mapping ?? {
      wages: randomUUID(),
      employer_tax: randomUUID(),
      net_pay: randomUUID(),
      tax_payable: randomUUID(),
      officers: [],
    };
    if (!defaults.mapping)
      for (const key of [
        "wages",
        "employer_tax",
        "net_pay",
        "tax_payable",
      ] as const)
        await command({
          type: "account.create",
          id: mapping[key],
          name: `HTTP import ${key}`,
          account_type:
            key === "wages" || key === "employer_tax" ? "expense" : "liability",
          subtype:
            key === "wages" || key === "employer_tax"
              ? "payroll_expense"
              : "payroll_liability",
        });
    const csv = `Company Name: Example Company\nCompany ID: ${company}\nEmployee: Synthetic HTTP Employee\nGroup By: Check\n\nPay Date,Pay Period,Source,Paycheck #,Gross Pay,Net Pay,Federal Income Tax,Employer Medicare Tax\n4/28/2022,4/1/2022 - 4/28/2022,Paycheck,HTTP-1,$500.00,$450.00,$50.00,$7.25\n`;
    const body = (mode: string, text = csv) => {
      const form = new FormData();
      form.set("mode", mode);
      form.set("file", new File([text], "test.csv", { type: "text/csv" }));
      form.set("mapping", JSON.stringify(mapping));
      return form;
    };
    const post = (form: FormData, origin = base) =>
      fetch(`${base}/api/accounting/payroll-import`, {
        method: "POST",
        headers: { Origin: origin },
        body: form,
      });
    assert.equal(
      (await post(body("inspect"), "https://untrusted.example")).status,
      403,
    );
    assert.equal((await post(body("inspect", "invalid CSV"))).status, 409);
    const inspection = await post(body("inspect"));
    assert.equal(inspection.status, 200);
    assert.equal((await inspection.json()).payroll_count, 1);
    const previewResponse = await post(body("preview"));
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as PatriotPreview;
    const document = randomUUID();
    const upload = new FormData();
    upload.set("id", document);
    upload.set(
      "file",
      new File([csv], "synthetic-payroll-http.csv", { type: "text/csv" }),
    );
    const uploaded = await fetch(`${base}/api/accounting/documents`, {
      method: "POST",
      headers: { Origin: base },
      body: upload,
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const selected = { [preview.results[0].key]: "new" };
    const confirm = () => {
      const form = new FormData();
      form.set("mode", "commit");
      form.set("document_id", document);
      form.set("mapping", JSON.stringify(mapping));
      form.set("choices", JSON.stringify(selected));
      return form;
    };
    assert.equal((await post(confirm())).status, 200);
    const repeat = await post(confirm());
    assert.equal(repeat.status, 200);
    assert.equal(
      ((await repeat.json()) as PatriotPreview).results[0].state,
      "duplicate",
    );
    const forged = confirm();
    forged.set("choices", JSON.stringify({ unknown: "new" }));
    assert.equal((await post(forged)).status, 409);
    // Submit the same second payroll from two connections. The second must wait for the first commit.
    const source = parsePatriot(
      csv
        .replaceAll("4/28/2022", "5/28/2022")
        .replaceAll("4/1/2022", "5/1/2022"),
    );
    const items = patriotItems(source, mapping).map((i) => ({
      ...i,
      choice: "new",
    }));
    const hash = (
      await db.query(
        "SELECT accounting.documents(jsonb_build_object('id',$1::text)) r",
        [document],
      )
    ).rows[0].r.documents[0].content_hash;
    const request = {
      mode: "commit",
      company_id: company,
      company_name: source.company_name,
      items,
      mapping,
      document_id: document,
      content_hash: hash,
    };
    await db.query("BEGIN");
    const first = (
      await db.query("SELECT accounting.patriot_import($1::jsonb) r", [
        JSON.stringify(request),
      ])
    ).rows[0].r;
    let settled = false;
    const second = concurrent
      .query("SELECT accounting.patriot_import($1::jsonb) r", [
        JSON.stringify(request),
      ])
      .then((value) => {
        settled = true;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false);
    await db.query("COMMIT");
    const repeated = (await second).rows[0].r;
    assert.equal(repeated[0].run_id, first[0].run_id);
    assert.equal(repeated[0].state, "duplicate");
    console.log(
      "Patriot HTTP and PostgreSQL concurrency checks passed: upload, preview, confirm, duplicate retry, origin rejection, malformed files, invalid selections, and simultaneous imports.",
    );
  } finally {
    await db.query("ROLLBACK");
    await db.end();
    await concurrent.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
