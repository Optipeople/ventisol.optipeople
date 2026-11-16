import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Enforced on every response. Only the parts that cannot break rendering:
// no framing, no <base> hijack, forms only post back here, no plugins.
const enforcedCsp = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// The fuller policy from the Next CSP guide ("Without Nonces"), sent as
// report-only for now: the browser logs what it would block and blocks
// nothing. Once the console stays clean on every page in production, move
// these lines into the enforced policy above. Dropping 'unsafe-inline' from
// script-src needs nonces set in proxy.ts (see the same guide).
const reportOnlyCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  enforcedCsp,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: enforcedCsp },
  { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
  // For browsers older than frame-ancestors.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Report URLs carry order numbers: they stay on this site.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // The site uses none of these browser features.
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "browsing-topics=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The design system ships TypeScript source, with no build step.
  transpilePackages: ["@optipeople/ui"],
  // PGlite (fixture mode only) finds its .wasm and data files next to its
  // own code, so it must be loaded from node_modules, not bundled. `pg` is
  // on Next's built-in list already.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  experimental: {
    // Same as vola: keep rendered pages in the browser's client cache for a
    // short while, so the back button and moving between views do not
    // re-render on the server. Today's data is cached 30 s server-side too.
    staleTimes: { dynamic: 30, static: 180 },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
