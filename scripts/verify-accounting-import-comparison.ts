import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
import {
  fixtureAccounts,
  fixtureAccountId,
} from "../src/lib/accounting/fixtures";
import {
  importComparisonFilterSchema,
  type ImportComparison,
} from "../src/lib/accounting/imports/comparison";

async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const rejects = async (fn: () => Promise<unknown>, pattern: RegExp) => {
    await assert.rejects(fn, pattern);
    checks++;
  };
  const hash = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const command = async (value: object, key = randomUUID()) =>
    (
      await db.query<{ r: { id: string; version: number; revision: string } }>(
        "SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r",
        [key, JSON.stringify(value)],
      )
    ).rows[0].r;
  const preview = async (filter: object) =>
    (
      await db.query<{ r: ImportComparison }>(
        "SELECT accounting.import_compare(($1::jsonb->>'earlier')::uuid,($1::jsonb->>'later')::uuid,$1::jsonb) r",
        [JSON.stringify(filter)],
      )
    ).rows[0].r;
  try {
    await command({
      type: "chart.seed",
      id: randomUUID(),
      accounts: fixtureAccounts.map((a) => ({
        ...a,
        cash_kind: a.id === fixtureAccountId(1) ? "bank" : "none",
      })),
    });
    async function batch(
      scope: string,
      rows: {
        id: string;
        amount?: string;
        date?: string;
        memo?: string;
        raw?: string;
        kind?: string;
      }[],
      options: { stage?: boolean; mapping?: string; mode?: string } = {},
    ) {
      const id = randomUUID();
      const groups = rows.map((r, ordinal) => ({
        id: randomUUID(),
        ordinal,
        external_id: r.id,
        identity_kind: r.kind ?? "provider_id",
        fingerprint: hash([
          r.id,
          r.amount ?? "100",
          r.date ?? "2026-01-10",
          r.memo ?? "Synthetic export",
        ]),
        source_hash: hash(r),
        entry_date: r.date ?? "2026-01-10",
        memo: r.memo ?? "Synthetic export",
        lines: [],
        bank_account_id: fixtureAccountId(1),
        bank_amount_cents: r.amount ?? "100",
        raw: [{ id: r.id, note: r.raw ?? "" }],
      }));
      let saved = await command({
        type: "import.create",
        id,
        source_system: "csv",
        source_scope: scope,
        file_hash: hash([id, rows]),
        mapping_hash: hash(options.mapping ?? "same"),
        file_name: `Synthetic ${id}.csv`,
        mode: options.mode ?? "bank",
        basis: "cash",
        expected_groups: groups.length,
        from: "2026-01-01",
        to: "2026-02-28",
      });
      if (options.stage !== false)
        for (let start = 0; start < groups.length; start += 50)
          saved = await command({
            type: "import.stage",
            id,
            expected_version: saved.version,
            groups: groups.slice(start, start + 50),
          });
      return { id, groups, version: saved.version };
    }
    const old = await batch("test-comparison", [
      { id: "same" },
      { id: "amount", amount: "100" },
      { id: "date" },
      { id: "memo" },
      { id: "source" },
      { id: "missing" },
      { id: "fingerprint-old", kind: "fingerprint_multiplicity" },
      { id: "huge", amount: "9007199254740993" },
    ]);
    const next = await batch(
      "test-comparison",
      [
        { id: "same" },
        { id: "amount", amount: "200" },
        { id: "date", date: "2026-02-01" },
        { id: "memo", memo: "New merchant description" },
        { id: "source", raw: "Extra source column" },
        { id: "new" },
        { id: "fingerprint-new", kind: "fingerprint_multiplicity" },
        { id: "huge", amount: "9007199254740993" },
      ],
      { mapping: "updated" },
    );
    const filter = {
      earlier: old.id,
      later: next.id,
      from: "2026-01-01",
      to: "2026-01-31",
      change: "all",
      offset: 0,
    };
    let p = await preview(filter);
    check(p.counts, {
      changed: 3,
      source_only: 1,
      missing: 2,
      new: 2,
      unchanged: 2,
    });
    check(p.total, 10);
    check(p.filtered_total, 10);
    check(p.uncertain_identity_count, 2);
    check(p.mapping_changed, true);
    check(p.basis_changed, false);
    check(
      p.rows.find((r) => r.external_id === "date")?.later?.entry_date,
      "2026-02-01",
    );
    check(
      p.rows.find((r) => r.external_id === "huge")?.later?.bank_amount_cents,
      "9007199254740993",
    );
    check(p.rows.find((r) => r.external_id === "missing")?.later, null);
    for (const kind of [
      "changed",
      "new",
      "missing",
      "source_only",
      "unchanged",
    ]) {
      const v = await preview({ ...filter, change: kind });
      check(v.filtered_total, p.counts[kind as keyof typeof p.counts]);
      check(
        v.rows.every((r) => r.change === kind),
        true,
      );
    }
    check(
      (await preview({ ...filter, change: "differences" })).filtered_total,
      8,
    );
    check(
      (await preview({ ...filter, from: "2026-02-01", to: "2026-02-28" }))
        .counts,
      { changed: 1 },
    );
    check(
      (await preview({ ...filter, from: "2026-01-20", to: "2026-01-31" }))
        .total,
      0,
    );
    const other = await batch("other-scope", [{ id: "same" }]),
      partial = await batch("test-comparison", [{ id: "same" }], {
        stage: false,
      });
    for (const change of [
      { later: old.id },
      { later: other.id },
      { from: "2025-12-31" },
      { to: "2026-03-01" },
      { offset: -1 },
      { change: "invalid" },
    ])
      await rejects(
        () => preview({ ...filter, ...change }),
        /ACCT_IMPORT_COMPARISON_SCOPE/,
      );
    await rejects(
      () => preview({ ...filter, later: partial.id }),
      /ACCT_IMPORT_COMPARISON_STAGING/,
    );
    // Duplicate source IDs now fail at staging through the target table's unique key.
    await rejects(() => batch("test-comparison", [{id:"repeat",amount:"100"},{id:"repeat",amount:"200"}]), /duplicate key/);
    const manyOld = await batch(
        "page-scope",
        Array.from({ length: 101 }, (_, i) => ({
          id: `id-${String(i).padStart(3, "0")}`,
        })),
      ),
      manyNew = await batch(
        "page-scope",
        Array.from({ length: 101 }, (_, i) => ({
          id: `id-${String(i).padStart(3, "0")}`,
          amount: "200",
        })),
      );
    const full = [];
    for (const offset of [0, 50, 100]) {
      const page = await preview({
        ...filter,
        earlier: manyOld.id,
        later: manyNew.id,
        offset,
      });
      check(page.total, 101);
      full.push(...page.rows.map((r) => r.key));
    }
    check(new Set(full).size, 101);
    check(full.length, 101);
    await db.exec("SET ROLE anon");
    await rejects(() => preview(filter), /permission denied/);
    console.log(`Import comparison: ${checks} checks passed.`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
