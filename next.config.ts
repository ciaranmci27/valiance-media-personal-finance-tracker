import { resolve } from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  turbopack: {
    root: resolve(__dirname, ".."),
  },
};

export default nextConfig;
