import { describe, expect, it } from "vitest";
import { scaffoldSource } from "./scaffold.js";
import { deriveCanaryStatus } from "./types.js";
import { TrackerStore } from "../store/store.js";
import { resolveConfig } from "../config.js";
import { silentLogger } from "../lib/logger.js";

/**
 * All six registry sources are implemented now, but the scaffold factory is
 * the contract every FUTURE source starts from (see docs/sources/*.md for the
 * later-module candidates) — its honesty guarantees stay covered here.
 */

describe("scaffoldSource", () => {
  it("syncs as an explicit no-op that says so, and canaries as skip", async () => {
    const store = await TrackerStore.open(":memory:");
    const source = scaffoldSource({
      id: "senate-efd", // any valid SourceId; the factory doesn't consult the registry
      title: "Example future source",
      datasets: ["congress-trades"],
    });

    expect(source.implemented).toBe(false);

    const result = await source.sync({
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
    });
    expect(result.implemented).toBe(false);
    expect(result.rowsUpserted).toBe(0);
    expect(result.notes[0]).toMatch(/not implemented/);

    const outcome = await source.canary({
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
    });
    expect(deriveCanaryStatus(source.implemented, outcome.checks)).toBe("skip");
    await store.close();
  });
});
