import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createAccountingReadCache } from "../src/lib/accounting/read-cache";
import { accountingGet } from "../src/components/features/accounting/use-accounting-command";

async function main() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const server = createServer(async (req, res) => {
    if (req.url?.includes("body")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"value":');
      await delay(150);
      res.end("1}");
    } else {
      await delay(50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"value":1}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  let headers: (() => void) | undefined;
  const cache = createAccountingReadCache(async (query, signal) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/${query.view}`,
      { signal },
    );
    headers?.();
    return await response.json();
  });
  try {
    // Effect setup/cleanup/setup, including Strict Mode's immediate cleanup.
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const pending = cache.read({ view: "register" }, controller.signal);
      const rejected = assert.rejects(pending, { name: "AbortError" });
      controller.abort();
      await rejected;
    }
    assert.deepEqual(await cache.read({ view: "register" }), { value: 1 });
    cache.invalidate();
    // Navigation after headers arrive must also handle a cancelled body read.
    const controller = new AbortController();
    const receivedHeaders = new Promise<void>((resolve) => {
      headers = resolve;
    });
    const body = cache.read({ view: "body" }, controller.signal);
    const rejected = assert.rejects(body, { name: "AbortError" });
    await receivedHeaders;
    controller.abort();
    await rejected;
    headers = undefined;
    // Other accounting screens use accountingGet. Cancellation must settle the
    // reader without rejecting the fetch or a browser observer's cloned body.
    const originalFetch = globalThis.fetch;
    const bodyController = new AbortController();
    let receivingBody!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      receivingBody = resolve;
    });
    let bodyError: unknown;
    let delivered = false;
    let cleanedUp = false;
    const observed: Promise<unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      const response = await originalFetch(
        `http://127.0.0.1:${address.port}/body`,
        init,
      );
      observed.push(response.clone().json());
      receivingBody();
      return response;
    };
    try {
      void accountingGet({ view: "register" }, bodyController.signal)
        .then(() => {
          delivered = true;
        })
        .catch((error) => {
          bodyError = error;
        })
        .finally(() => {
          cleanedUp = true;
        });
      await bodyStarted;
      // Let the reader begin response.json() before simulating navigation.
      await delay(0);
      bodyController.abort();
      await delay(100);
      assert.equal((bodyError as Error)?.name, "AbortError");
      assert.equal(cleanedUp, true, "Cancelled reads must settle for cleanup");
      assert.equal(
        delivered,
        false,
        "Cancelled responses must not update abandoned screens",
      );
      assert.deepEqual(await Promise.all(observed), [{ value: 1 }]);

      // Use the production loader too, including a browser extension that
      // observes fetch in a detached task without its own rejection handler.
      globalThis.fetch = (...args) => {
        const pending = originalFetch(
          `http://127.0.0.1:${address.port}/body`,
          args[1],
        );
        void (async () => {
          const response = await pending;
          await response.clone().json();
        })();
        return pending;
      };
      const productionCache = createAccountingReadCache();
      for (let i = 0; i < 10; i++) {
        const leave = new AbortController();
        const read =
          i % 2 === 0
            ? accountingGet({ view: "evidence" }, leave.signal)
            : productionCache.read({ view: "payroll" }, leave.signal);
        const handled = assert.rejects(read, { name: "AbortError" });
        leave.abort();
        await handled;
      }
      await delay(250);
      const alreadyGone = new AbortController();
      alreadyGone.abort();
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return Response.json({});
      };
      await assert.rejects(accountingGet({}, alreadyGone.signal), {
        name: "AbortError",
      });
      assert.equal(
        fetched,
        false,
        "Pre-cancelled reads must not start a request",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Real failures must still reach active screens.
    try {
      globalThis.fetch = async () =>
        Response.json({ error: "Synthetic server failure" }, { status: 500 });
      await assert.rejects(
        accountingGet({ view: "register" }),
        /Synthetic server failure/,
      );
      globalThis.fetch = async () => {
        throw new Error("Synthetic network failure");
      };
      await assert.rejects(
        accountingGet({ view: "register" }),
        /Synthetic network failure/,
      );
      globalThis.fetch = async () => new Response("invalid JSON");
      await assert.rejects(accountingGet({ view: "register" }), SyntaxError);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await delay(100);
    assert.deepEqual(
      unhandled,
      [],
      "Navigation must not leave rejected promises unhandled",
    );
    console.log(
      "Accounting cancellation: rapid navigation and streamed response cancellation passed.",
    );
  } finally {
    cache.invalidate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.removeListener("unhandledRejection", onUnhandled);
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
