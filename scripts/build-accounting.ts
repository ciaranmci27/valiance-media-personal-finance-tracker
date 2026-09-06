import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ACCOUNTING_BUILD_CHECK: "true",
  NEXT_PUBLIC_ACCOUNTING_ENABLED: "true",
  NEXT_PUBLIC_DEMO_MODE: "false",
  APP_ENV: "production",
};
delete env.ACCOUNTING_TEST_DATABASE_URL;
const child = spawn(
  process.execPath,
  [require.resolve("next/dist/bin/next"), "build"],
  { cwd: new URL("..", import.meta.url), env, stdio: "inherit" },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
