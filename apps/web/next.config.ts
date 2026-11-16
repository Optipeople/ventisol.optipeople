import { existsSync, writeFileSync } from "node:fs";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// A second dev server (fixture mode beside a real one) needs its own build
// folder: Next allows one `next dev` per folder. Unset everywhere else.
const extraDistDir = process.env.VENTISOL_DIST_DIR?.replace(/[\\/]+$/, "") || undefined;

/**
 * The tsconfig a server with its own build folder uses. Next adds
 * "<distDir>/types/**\/*.ts" to the include list of its tsconfig whenever the
 * entry is missing (an exact string match, see writeConfigurationDefaults in
 * next/dist/lib/typescript), so pointing a second server at tsconfig.json
 * would add lines there for every folder name. It gets its own file instead,
 * tsconfig.<folder>.json next to tsconfig.json, which extends it and is
 * ignored by git (.gitignore: /tsconfig.next-*.json). It is written here,
 * before Next reads it; the build folder itself cannot hold it, because
 * `next dev` empties that folder on start.
 */
function extraTsconfig(distDir: string | undefined): string | undefined {
  if (!distDir) return undefined;
  if (!/^\.next-[\w-]+$/.test(distDir)) {
    throw new Error(`VENTISOL_DIST_DIR must look like .next-<name>, got "${distDir}".`);
  }
  const file = `tsconfig${distDir}.json`;
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`);
  }
  return file;
}

// Enforced on every response: no framing, no <base> hijack, forms only post
// back here, no plugins, images and fetch/XHR/WebSocket only to this site.
// img-src: the pdf.js viewer draws into canvases (no image URLs), the UI
// uses inline SVG and data: URLs. connect-src: the chat stream, the PDF
// bytes and the pdf.js worker (a module worker from this origin, which gets
// these same headers) all talk to this site only. In development the HMR
// WebSocket needs ws:. worker-src is left to the report-only default-src.
// Note: the Vercel toolbar on preview deployments (vercel.live) is blocked.
const enforcedCsp = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "img-src 'self' blob: data:",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
].join("; ");

// The rest of the policy from the Next CSP guide ("Without Nonces"), sent as
// report-only for now: the browser logs what it would block and blocks
// nothing. Once the console stays clean on every page in production, move
// these lines into the enforced policy above. Dropping 'unsafe-inline' from
// script-src needs nonces set in proxy.ts (see the same guide).
const reportOnlyCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
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
  distDir: extraDistDir ?? ".next",
  // tsconfig.json stays as committed when a second server runs (see above).
  typescript: { tsconfigPath: extraTsconfig(extraDistDir) ?? "tsconfig.json" },
  // The design system ships TypeScript source, with no build step.
  transpilePackages: ["@optipeople/ui"],
  // PGlite (fixture mode only) finds its .wasm and data files next to its
  // own code, so it must be loaded from node_modules, not bundled. `pg` is
  // on Next's built-in list already.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pdfjs-dist"],
  // pdfjs only reads text here; its optional native canvas is never loaded.
  outputFileTracingExcludes: { "*": ["node_modules/@napi-rs/**"] },
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
