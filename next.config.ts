import { resolve } from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep the isolated accounting fixture server separate from the owner's dev build.
  ...(process.env.ACCOUNTING_TEST_DATABASE_URL ? {
    distDir: '.next-accounting-test',
    typescript: { tsconfigPath: 'tsconfig.accounting-test.json' },
  } : {}),
  ...(process.env.ACCOUNTING_BUILD_CHECK === 'true' ? {
    distDir: '.next-accounting-build',
    typescript: { tsconfigPath: 'tsconfig.accounting-build.json' },
  } : {}),

  // LAN/Tailscale hosts allowed to hit the dev server (e.g., phones on the same network)
  allowedDevOrigins: ['192.168.127.227', '100.79.77.23', '**.ts.net'],

  turbopack: {
    root: resolve(__dirname, ".."),
  },
};

export default nextConfig;
