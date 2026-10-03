/**
 * Serves the finance MCP route over real HTTP on the seeded test fixture, so
 * clients other than the TypeScript SDK (Hermes's Python client, MCP
 * Inspector) can be pointed at it. Prints the URL and a full-scope key.
 *
 * Run: npx tsx --tsconfig tsconfig.api-test.json scripts/serve-mcp-fixture.ts [port]
 */
import { createServer } from "node:http";
import { NextRequest } from "next/server";
import { seedApiFixture } from "./api-test-fixture";

async function main() {
  const port = Number(process.argv[2] ?? 3999);
  const { fullKey, booksOnly } = await seedApiFixture({ maxRows: 1000 });
  const route = await import("../src/app/api/mcp/route");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
    const request = new NextRequest(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response =
      req.url !== "/api/mcp"
        ? new Response("Not found", { status: 404 })
        : req.method === "POST"
          ? await route.POST(request)
          : req.method === "DELETE"
            ? await route.DELETE()
            : await route.GET();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(port, () => {
    console.log(`MCP_URL=http://localhost:${port}/api/mcp`);
    console.log(`FULL_KEY=${fullKey}`);
    console.log(`BOOKS_KEY=${booksOnly}`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
