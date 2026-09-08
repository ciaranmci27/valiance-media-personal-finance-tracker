import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function main() {
  const require = createRequire(import.meta.url);
  await access(new URL("../.next-accounting-build/BUILD_ID", import.meta.url));
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(3109, "127.0.0.1", () => probe.close(() => resolve()));
  });
  const secret = "synthetic-production-boundary-secret-not-a-live-key";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACCOUNTING_BUILD_CHECK: "true",
    NEXT_PUBLIC_ACCOUNTING_ENABLED: "true",
    NEXT_PUBLIC_DEMO_MODE: "false",
    DEMO_MODE: "false",
    APP_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:15449",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-production-key",
    ACCOUNTING_FEED_WORKER_ENABLED: "false",
    ACCOUNTING_TAX_WORKER_ENABLED: "false",
    ACCOUNTING_WORKER_SECRET: secret,
    ACCOUNTING_TAX_WORKER_SECRET: secret,
    SUPABASE_SERVICE_ROLE_KEY: "",
  };
  delete env.ACCOUNTING_TEST_DATABASE_URL;
  const child = spawn(
    process.execPath,
    [
      require.resolve("next/dist/bin/next"),
      "start",
      "--port",
      "3109",
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    startupError: Error | null = null,
    checks = 0;
  child.stdout.on("data", (data) => {
    output = (output + data).slice(-12000);
  });
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-12000);
  });
  child.on("error", (error) => {
    startupError = error;
  });
  const base = "http://127.0.0.1:3109";
  const request = (path: string, init?: RequestInit) =>
    fetch(base + path, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (startupError || child.exitCode !== null)
        throw startupError ?? new Error(output);
      try {
        ready = (await request("/login")).status === 200;
      } catch {
        /* Wait for our server to bind. */
      }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, "Production check server did not become ready.");
    checks++;
    const page = await request("/accounting");
    assert.equal(page.status, 307);
    assert.match(page.headers.get("location") ?? "", /\/login/);
    checks += 2;
    for (const path of [
      "/api/accounting?export=true",
      "/api/accounting/documents",
      "/api/accounting/feeds",
      "/api/accounting/history",
      "/api/accounting/tax",
      "/api/accounting/reports/10000000-0000-4000-8000-000000000001?format=pdf",
      "/api/accounting/packages/10000000-0000-4000-8000-000000000001?format=zip",
      "/api/accounting/jobs/feeds/unexpected",
      "/api/accounting/jobs/tax/unexpected",
    ]) {
      const result = await request(path);
      assert.equal(result.status, 401, path);
      assert.equal(result.headers.get("location"), null, path);
      assert.match(result.headers.get("cache-control") ?? "", /no-store/, path);
      assert.match((await result.json()).error, /Sign in/);
      checks += 4;
    }
    const post = (path: string, token?: string) =>
      request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: "{}",
      });
    assert.equal((await post("/api/accounting")).status, 401);
    checks++;
    assert.equal((await post("/api/accounting/jobs/feeds")).status, 401);
    checks++;
    const feed = await post("/api/accounting/jobs/feeds", secret);
    assert.equal(feed.status, 503);
    assert.match((await feed.json()).error, /worker is disabled/);
    checks += 2;
    const tax = await post("/api/accounting/jobs/tax", secret);
    assert.equal(tax.status, 401);
    assert.match((await tax.json()).error, /worker disabled/);
    checks += 2;
    for (const path of [
      "/api/webhooks/accounting/invoices",
      "/api/webhooks/accounting/invoices/sync",
    ]) {
      const result = await post(path);
      assert.equal(result.status, 404, path);
      assert.equal(result.headers.get("location"), null);
      checks += 2;
    }
    console.log(
      `Production authentication: ${checks} checks passed (owner APIs, exact worker routes, bearer validation and disabled integrations). No live data or external delivery used.`,
    );
  } finally {
    child.kill();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
