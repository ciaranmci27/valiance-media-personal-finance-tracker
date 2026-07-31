import { resolve } from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // LAN/Tailscale hosts allowed to hit the dev server (e.g., phones on the same network)
  allowedDevOrigins: ['192.168.127.227', '100.79.77.23', '**.ts.net'],

  turbopack: {
    root: resolve(__dirname, ".."),
  },
};

export default nextConfig;
