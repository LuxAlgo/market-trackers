import { serveHttp, serveStdio } from "@luxalgo/docket-mcp";
import type { GlobalFlags } from "../context.js";

export interface ServeFlags extends GlobalFlags {
  http?: boolean;
  port?: string;
}

/**
 * Serves the local store over MCP. Default transport is stdio (what MCP
 * clients spawn); --http starts the stateless streamable-HTTP server
 * instead. Runs until killed.
 */
export async function serveCommand(flags: ServeFlags): Promise<number> {
  if (flags.http) {
    const { port } = await serveHttp({
      db: flags.db,
      port: flags.port ? Number(flags.port) : undefined,
    });
    // stderr, because stdout may be piped.
    process.stderr.write(
      `docket-mcp listening on :${port}/mcp (store: ${flags.db ?? process.env.DOCKET_DB ?? "docket.db"})\n`,
    );
  } else {
    await serveStdio({ db: flags.db });
  }
  // Keep the process alive; transports own the lifecycle from here.
  await new Promise(() => {});
  return 0;
}
