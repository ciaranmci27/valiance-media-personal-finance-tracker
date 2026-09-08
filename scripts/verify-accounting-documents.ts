import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountingTestDb } from "./accounting-test-db";
async function main() {
  const db = await accountingTestDb();
  let checks = 0;
  const check = (actual: unknown, expected: unknown) => {
    assert.deepEqual(actual, expected);
    checks++;
  };
  const cmd = async (command: object, key = randomUUID()) =>
    (
      await db.query<{
        r: { id: string; version: number; storage_path: string };
      }>("SELECT accounting.operate(jsonb_build_object('key',$1::text,'command',$2::jsonb)) r", [key, JSON.stringify(command)])
    ).rows[0].r;
  try {
    await db.exec(
      "RESET ROLE;INSERT INTO storage.buckets(id,name,public) VALUES('accounting-private','accounting-private',false) ON CONFLICT DO NOTHING;SET ROLE authenticated;",
    );
    const id = randomUUID(),
      key = randomUUID(),
      prepare = {
        type: "document.prepare",
        id,
        original_name: "fixture.csv",
        content_hash: "a".repeat(64),
        mime_type: "text/csv",
        size_bytes: "20",
      };
    const result = await cmd(prepare, key);
    check(await cmd(prepare, key), result);
    await assert.rejects(
      cmd({ type: "document.complete", id, expected_version: 1 }),
      /ACCT_DOCUMENT_UNAVAILABLE/,
    );
    checks++;
    await assert.rejects(
      db.query(
        "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private','unauthorized/path')",
      ),
      /row-level security/,
    );
    checks++;
    await db.query(
      "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
      [result.storage_path],
    );
    check(
      (await cmd({ type: "document.complete", id, expected_version: 1 }))
        .version,
      2,
    );
    await assert.rejects(
      db.query(
        "INSERT INTO storage.objects(bucket_id,name) VALUES('accounting-private',$1)",
        [result.storage_path],
      ),
      /row-level security/,
    );
    checks++;
    check((await db.query("SELECT id FROM storage.objects")).rows.length, 1);
    check(
      (await db.query("DELETE FROM storage.objects RETURNING id")).rows.length,
      0,
    );
    await db.exec("SET ROLE anon");
    check((await db.query("SELECT id FROM storage.objects")).rows.length, 0);
    await assert.rejects(
      db.query("SELECT accounting.documents()"),
      /permission denied/,
    );
    checks++;
    await db.exec("SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [
      randomUUID(),
    ]);
    check((await db.query("SELECT id FROM storage.objects")).rows.length, 0);
    await assert.rejects(
      db.query("SELECT accounting.documents()"),
      /ACCT_FORBIDDEN/,
    );
    checks++;
    console.log(
      `Accounting document permissions: ${checks} assertions passed.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
