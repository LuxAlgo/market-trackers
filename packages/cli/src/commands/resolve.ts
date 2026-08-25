import { OpenFigiClient, resolveCusips } from "@luxalgo/alt-data-core";
import { openContext, printJson, type GlobalFlags } from "../context.js";

/**
 * `alt-data resolve cusips` — the CUSIP→ticker enrichment loop for 13F
 * holdings. Collects distinct unresolved CUSIPs from the store, resolves
 * them through the cached OpenFIGI mapping (keyless works; ALT_DATA_OPENFIGI_KEY
 * raises the free rate limits), and back-fills tickers onto holding rows.
 * Misses are cached so they aren't re-queried every run; `--retry-misses`
 * asks OpenFIGI again for those (e.g. after new listings become mappable).
 */

export interface ResolveFlags extends GlobalFlags {
  retryMisses?: boolean;
  limit?: string;
}

export async function resolveCommand(what: string, flags: ResolveFlags): Promise<number> {
  if (what !== "cusips") {
    throw new Error(`Unknown resolve target '${what}' (supported: cusips)`);
  }
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer`);
  }

  const ctx = await openContext(flags);
  try {
    const cusips = await ctx.store.distinctUnresolvedCusips(limit);
    const client = new OpenFigiClient({
      apiKey: ctx.config.openfigiApiKey,
      fetchImpl: ctx.fetchImpl,
      logger: ctx.logger,
    });
    const resolved = await resolveCusips(ctx.store, client, cusips, {
      retryMisses: flags.retryMisses,
    });
    const { updated } = await ctx.store.applyCusipTickers(resolved);

    const withTicker = [...resolved.values()].filter((ticker) => ticker !== null).length;
    const summary = {
      unresolvedCusips: cusips.length,
      resolved: withTicker,
      stillUnresolved: cusips.length - withTicker,
      rowsUpdated: updated,
    };
    if (flags.json) {
      printJson(summary);
    } else {
      process.stdout.write(
        `${summary.unresolvedCusips} unresolved CUSIPs → ${summary.resolved} resolved, ` +
          `${summary.stillUnresolved} still unresolved; ${summary.rowsUpdated} holding rows updated\n`,
      );
      if (summary.stillUnresolved > 0) {
        process.stdout.write(`hint: misses are cached; re-query them later with --retry-misses\n`);
      }
    }
    return 0;
  } finally {
    await ctx.close();
  }
}
