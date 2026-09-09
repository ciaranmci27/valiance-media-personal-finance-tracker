import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { verifyInputBank } from "./verify-input-bank";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../..", import.meta.url));
const scripts = new URL(".", import.meta.url);
const integration = new Set([
  "verify-accounting-concurrency.ts",
  "verify-accounting-http.ts",
  "verify-accounting-production.ts",
]);

async function main() {
  await verifyInputBank();
  const includeIntegration = process.argv.includes("--integration");
  const files = (await readdir(scripts))
    .filter(
      (file) =>
        /^verify-accounting(?:-[a-z-]+)?\.ts$/.test(file) &&
        file !== "verify-accounting-all.ts" &&
        !integration.has(file),
    )
    .sort();
  files.push("verify-tax.ts");
  const results: {
    file: string;
    passed: boolean;
    seconds: number;
    output: string;
  }[] = [];

  async function run(file: string) {
    const started = Date.now();
    process.stdout.write(`Starting ${file}\n`);
    const child = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--tsconfig",
        "admin/tsconfig.json",
        `admin/scripts/${file}`,
      ],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const passed = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(
        () => {
          output += "\nVerification exceeded its time limit.\n";
          child.kill();
        },
        integration.has(file) ? 600_000 : 180_000,
      );
      child.on("error", (error) => {
        clearTimeout(timeout);
        output += error.message;
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });
    });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push({ file, passed, seconds, output });
    process.stdout.write(
      `${passed ? "PASS" : "FAIL"} ${file} (${seconds}s)\n${output.trim()}\n`,
    );
  }

  // Each ordinary suite creates its own in-memory database. Bound parallelism to
  // keep a developer's running apps responsive. Fixture-cluster tests run alone.
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < files.length) await run(files[next++]);
    }),
  );
  if (includeIntegration) for (const file of integration) await run(file);
  const failed = results.filter((result) => !result.passed);
  const report = process.env.ACCOUNTING_VERIFICATION_REPORT;
  if (report)
    await writeFile(
      report,
      JSON.stringify(
        {
          completed_at: new Date().toISOString(),
          integration: includeIntegration,
          passed: results.length - failed.length,
          failed: failed.length,
          results,
        },
        null,
        2,
      ),
    );
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} suites passed.\n`,
  );
  if (!includeIntegration)
    process.stdout.write(
      "Fixture PostgreSQL and HTTP checks require --integration with explicit isolated endpoints.\n",
    );
  if (failed.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
