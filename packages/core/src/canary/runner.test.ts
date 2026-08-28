import { describe, expect, it } from "vitest";
import { runCanaries } from "./runner.js";
import { TrackerStore } from "../store/store.js";
import { resolveConfig } from "../config.js";
import { silentLogger } from "../lib/logger.js";
import type { SourceContext } from "../sources/types.js";
import { deriveCanaryStatus } from "../sources/types.js";

describe("deriveCanaryStatus", () => {
  it("maps severities to statuses", () => {
    expect(deriveCanaryStatus(false, [])).toBe("skip");
    expect(deriveCanaryStatus(true, [])).toBe("green");
    expect(deriveCanaryStatus(true, [{ name: "freshness", ok: false, severity: "soft" }])).toBe(
      "amber",
    );
    expect(
      deriveCanaryStatus(true, [
        { name: "freshness", ok: false, severity: "soft" },
        { name: "fetch", ok: false, severity: "hard" },
      ]),
    ).toBe("red");
  });
});

describe("runCanaries", () => {
  it("derives per-source statuses, records them, and rolls up the worst overall", async () => {
    const store = await TrackerStore.open(":memory:");
    const ctx: SourceContext = {
      store,
      config: resolveConfig({ logLevel: "silent" }, { cwd: "/nonexistent", env: {} }),
      logger: silentLogger,
      // Every probe 404s → implemented sources fail their fetch checks (red).
      fetchImpl: (async () => new Response("nope", { status: 404 })) as typeof fetch,
    };

    const report = await runCanaries(ctx, { sources: ["finra"] });
    expect(report.sources).toHaveLength(1);

    const finra = report.sources.find((r) => r.source === "finra");
    expect(finra?.status).toBe("red");

    expect(report.overall).toBe("red");
    expect((await store.latestCanaryRun("finra"))?.status).toBe("red");
    await store.close();
  });
});
