import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    // PGlite starts and migrates per file: under a full parallel run that
    // takes longer than the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
