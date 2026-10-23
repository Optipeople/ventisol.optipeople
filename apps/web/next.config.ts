import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Same as vola: keep rendered pages in the browser's client cache for a
    // short while, so the back button and moving between views do not
    // re-render on the server. Today's data is cached 30 s server-side too.
    staleTimes: { dynamic: 30, static: 180 },
  },
};

export default nextConfig;
