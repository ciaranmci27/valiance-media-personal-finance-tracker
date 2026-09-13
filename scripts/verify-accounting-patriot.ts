import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parsePatriot,
  type PatriotMapping,
  type PatriotResult,
} from "../src/lib/accounting/patriot-import";
import { patriotItems } from "../src/lib/accounting/server/patriot-payload";
import { accountingTestDb } from "./accounting-test-db";

const header =
  "Pay Date,Transaction Date,Pay Period,Source,Paycheck #,Location Name,Regular,Gross Pay,Federal Income Tax,Medicare,Social Security,Net Pay,Employer Medicare Tax,Employer Social Security,Federal Unemployment Tax";
const row = (month: number, year = 2026) =>
  `${month}/28/${year},${month}/25/${year},${month}/1/${year} - ${month}/28/${year},Paycheck,,Office,$2000.00,$2000.00,$100.00,$29.00,$124.00,$1747.00,$29.00,$124.00,$0.00`;
const csv = (rows: string[], employee = "Sample Employee") =>
  `Company Name: Example Company\nCompany ID: TEST123\nEmployee: ${employee}\nGroup By: Check\n\n${header}\n${rows.join("\n")}\n`;
async function main() {
  const year = parsePatriot(
    csv(Array.from({ length: 12 }, (_, i) => row(i + 1))),
  );
  assert.equal(year.groups.length, 12);
  assert.equal(
    parsePatriot(
      csv(
        Array.from({ length: 26 }, (_, i) =>
          row((i % 12) + 1, 2020 + Math.floor(i / 12)),
        ),
      ),
    ).groups.length,
    26,
  );
  assert.throws(
    () => parsePatriot(csv([row(1), row(1)])),
    /repeated|ambiguous/,
  );
  assert.throws(
    () => parsePatriot(csv([row(1)], "All Employees")),
    /individual employee/,
  );
  assert.throws(
    () =>
      parsePatriot(csv([row(1)]).replace("Paycheck,,", "Voided Paycheck,,")),
    /manual review/,
  );
  assert.throws(
    () => parsePatriot(csv([row(1)]).replace("$1747.00", "$1700.00")),
    /does not equal/,
  );
  assert.throws(
    () =>
      parsePatriot(csv([row(1)]).replace("$2000.00,$2000", "$2000.00,$-2000")),
    /negative/,
  );
  assert.throws(
    () =>
      parsePatriot(
        csv([row(1)])
          .replace(header, header + ",401k")
          .replace(row(1), row(1) + ",$20.00"),
      ),
    /does not support/,
  );
  assert.throws(
    () => parsePatriot(csv([row(2)]).replace("2/28/2026", "2/30/2026")),
    /invalid date/,
  );
  const names = parsePatriot(
    csv(
      [
        row(1) + ",First",
        row(1).replace("Paycheck,,", "Paycheck,second,") + ",Second",
      ],
      "All Employees",
    ).replace(header, header + ",Employee Name"),
  );
  assert.equal(names.groups[0].checks.length, 2);
  const db = await accountingTestDb(
    process.env.PATRIOT_SCHEMA === "migrations" ? "migrations" : "canonical",
  );
  const command = async (command: object) =>
    (
      await db.query<{
        r: { id: string; version: number; storage_path?: string };
      }>("SELECT accounting.operate($1::jsonb) r", [
        JSON.stringify({ key: randomUUID(), command }),
      ])
    ).rows[0].r;
  const call = async (request: object) =>
    (
      await db.query<{ r: PatriotResult[] }>(
        "SELECT accounting.patriot_import($1::jsonb) r",
        [JSON.stringify(request)],
      )
    ).rows[0].r;
  try {
    const mapping: PatriotMapping = {
      wages: randomUUID(),
      employer_tax: randomUUID(),
      net_pay: randomUUID(),
      tax_payable: randomUUID(),
      officers: ["Sample Employee"],
    };
    for (const name of [
      "wages",
      "employer_tax",
      "net_pay",
      "tax_payable",
    ] as const)
      await command({
        type: "account.create",
        id: mapping[name],
        name: `Import ${name}`,
        account_type:
          name === "wages" || name === "employer_tax" ? "expense" : "liability",
        subtype:
          name === "wages" || name === "employer_tax"
            ? "payroll_expense"
            : "payroll_liability",
      });
    const document_id = randomUUID();
    const doc = await command({
      type: "document.prepare",
      id: document_id,
      original_name: "synthetic.csv",
      mime_type: "text/csv",
      size_bytes: "200",
      content_hash: "a".repeat(64),
    });
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [doc.storage_path],
    );
    await command({
      type: "document.complete",
      id: document_id,
      expected_version: doc.version,
    });
    const items = patriotItems(year, mapping);
    const single = patriotItems(parsePatriot(csv([row(1)])), mapping);
    assert.equal(items[0].key, single[0].key);
    assert.equal(items[0].fingerprint, single[0].fingerprint);
    const base = {
      company_id: year.company_id,
      company_name: year.company_name,
      mapping,
      document_id,
      content_hash: "a".repeat(64),
      items,
    };
    const preview = await call({ ...base, mode: "preview" });
    assert.equal(preview.filter((r) => r.state === "new").length, 12);
    const choices = items.map((i) => ({ ...i, choice: "new" }));
    const imported = await call({ ...base, mode: "commit", items: choices });
    assert.equal(imported.filter((r) => r.run_id).length, 12);
    assert.equal(
      (await call({ ...base, mode: "commit", items: choices })).filter(
        (r) => r.state === "duplicate",
      ).length,
      12,
    );
    assert.equal(
      (await call({ ...base, items: single, mode: "preview" }))[0].state,
      "duplicate",
    );
    const changed = patriotItems(
      parsePatriot(
        csv([
          row(1).replaceAll("2000.00", "2100.00").replace("1747.00", "1847.00"),
        ]),
      ),
      mapping,
    );
    assert.equal(
      (await call({ ...base, items: changed, mode: "preview" }))[0].state,
      "conflict",
    );
    await assert.rejects(
      () =>
        call({
          ...base,
          mode: "commit",
          items: changed.map((i) => ({ ...i, choice: "new" })),
        }),
      /ACCT_PATRIOT_CHANGED/,
    );
    const otherCompany = { ...base, company_id: "OTHER", mode: "preview" };
    assert.ok((await call(otherCompany)).every((r) => r.state === "conflict"));
    // A Wave-style journal consolidates employee and employer taxes into one credit.
    const historicReport = parsePatriot(csv([row(3, 2025)]));
    const historicItems = patriotItems(historicReport, mapping);
    const draft = await command({
      type: "draft.save",
      id: randomUUID(),
      expected_version: 0,
      entry_date: "2025-03-28",
      memo: "Payroll from previous books",
      kind: "manual",
      lines: [
        { account_id: mapping.wages, amount_cents: "200000" },
        { account_id: mapping.employer_tax, amount_cents: "15300" },
        { account_id: mapping.net_pay, amount_cents: "-174700" },
        { account_id: mapping.tax_payable, amount_cents: "-40600" },
      ],
    });
    const journal = await command({
      type: "entry.post",
      id: draft.id,
      expected_version: draft.version,
    });
    const matches = await call({
      ...base,
      mode: "preview",
      items: historicItems,
    });
    assert.equal(matches[0].state, "match");
    assert.equal(matches[0].candidates[0].id, journal.id);
    const linked = await call({
      ...base,
      mode: "commit",
      items: historicItems.map((i) => ({ ...i, choice: journal.id })),
    });
    assert.equal(linked[0].entry_id, journal.id);
    const histDetail = (
      await db.query<{ r: { lines: unknown[] } }>(
        "SELECT accounting.entry_detail($1) r",
        [journal.id],
      )
    ).rows[0].r;
    assert.equal(histDetail.lines.length, 4);
    // If a later selection conflicts, the earlier selection is rolled back too.
    const newItem = patriotItems(parsePatriot(csv([row(5, 2024)])), mapping)[0];
    await assert.rejects(
      () =>
        call({
          ...base,
          mode: "commit",
          items: [
            { ...newItem, choice: "new" },
            { ...changed[0], choice: "new" },
          ],
        }),
      /ACCT_PATRIOT_CHANGED/,
    );
    assert.equal(
      (await call({ ...base, mode: "preview", items: [newItem] }))[0].state,
      "new",
    );
    const weekly = Array.from({ length: 52 }, (_, i) => {
      const start = new Date(Date.UTC(2023, 0, 1 + i * 7));
      const end = new Date(Date.UTC(2023, 0, 7 + i * 7));
      const fmt = (d: Date) =>
        `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
      return `${fmt(end)},${fmt(end)},${fmt(start)} - ${fmt(end)},Paycheck,,Office,$2000.00,$2000.00,$100.00,$29.00,$124.00,$1747.00,$29.00,$124.00,$0.00`;
    });
    const weeklyItems = patriotItems(parsePatriot(csv(weekly)), mapping);
    assert.equal(weeklyItems.length, 52);
    assert.equal(
      (
        await call({
          ...base,
          mode: "commit",
          items: weeklyItems.map((i) => ({ ...i, choice: "new" })),
        })
      ).filter((r) => r.run_id).length,
      52,
    );
    const shifted = {
      ...single[0],
      key: single[0].key.replace("2026-01-28", "2026-01-29"),
      body: { ...single[0].body, pay_date: "2026-01-29" },
    };
    assert.equal(
      (await call({ ...base, mode: "preview", items: [shifted] }))[0].state,
      "conflict",
    );
    await db.exec("RESET ROLE");
    await db.exec(
      "INSERT INTO accounting.periods(month,status,locked_at) VALUES('2024-05-01','locked',now())",
    );
    await db.exec("SET ROLE authenticated");
    assert.equal(
      (await call({ ...base, mode: "preview", items: [newItem] }))[0].state,
      "conflict",
    );
    await db.exec("SET ROLE anon");
    await assert.rejects(() => call({ mode: "defaults" }), /permission denied/);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(
      () =>
        call({
          ...base,
          mode: "commit",
          content_hash: "b".repeat(64),
          items: [{ ...newItem, choice: "new" }],
        }),
      /DOCUMENT_UNAVAILABLE/,
    );
    // Validate the supplied files locally without persisting their contents in fixtures.
    for (const file of process.argv.slice(2)) {
      const report = parsePatriot(await readFile(file, "utf8"));
      assert.ok(report.groups.length > 0);
      patriotItems(report, { ...mapping, officers: [] });
      console.log(
        `Local sample: ${report.groups.length} payrolls parsed and balanced.`,
      );
    }
    console.log(
      "Patriot checks passed: date ranges, ambiguous checks, deductions, overlapping exports, duplicate retries, changed payrolls, company mismatch, historical linking, atomic rollback, and evidence integrity.",
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error.message, error.where ?? "", error.internalQuery ?? "");
  process.exitCode = 1;
});
