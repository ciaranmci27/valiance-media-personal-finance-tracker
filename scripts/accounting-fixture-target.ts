/** Explicit disposable endpoints only. The owner's parallel-run fixtures are protected. */
export function fixtureDatabaseUrl() {
  const value = process.env.ACCOUNTING_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      "Set ACCOUNTING_TEST_DATABASE_URL to a new disposable fixture database.",
    );
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/accounting_test" ||
    !url.port ||
    url.port === "5447"
  )
    throw new Error(
      "Use an explicit loopback accounting_test database on a port other than protected port 5447.",
    );
  return value;
}
export function fixtureAppUrl() {
  const value = process.env.ACCOUNTING_TEST_APP_URL;
  if (!value)
    throw new Error("Set ACCOUNTING_TEST_APP_URL to an isolated fixture app.");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.port === "3108" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an explicit loopback app URL on a port other than protected port 3108.",
    );
  return url.origin;
}
