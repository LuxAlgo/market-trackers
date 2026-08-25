import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(here, p);

export default defineConfig({
  resolve: {
    // Tests run against package sources, so a stale dist/ can never lie to us.
    alias: {
      "@luxalgo/alt-data-core": r("packages/core/src/index.ts"),
      "@luxalgo/alt-data-mcp": r("packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
