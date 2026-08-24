import { createServer, type Server as NodeHttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DocketStore, DOCKET_VERSION } from "@luxalgo/docket-core";
import { registerDocketTools } from "./tools.js";

export const SERVER_NAME = "docket";

/** A fully wired MCP server over an open store. */
export function createDocketMcpServer(store: DocketStore): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: DOCKET_VERSION });
  registerDocketTools(server, store);
  return server;
}

export interface ServeOptions {
  /** SQLite path / postgres:// url; defaults to DOCKET_DB or ./docket.db. */
  db?: string;
}

export function resolveDbUrl(options: ServeOptions = {}): string {
  return options.db ?? process.env.DOCKET_DB ?? "docket.db";
}

/** Local (stdio) serving — what `npx @luxalgo/docket-mcp` runs. */
export async function serveStdio(
  options: ServeOptions = {},
): Promise<{ close: () => Promise<void> }> {
  const store = await DocketStore.open(resolveDbUrl(options));
  const server = createDocketMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    close: async () => {
      await server.close();
      await store.close();
    },
  };
}

export interface ServeHttpOptions extends ServeOptions {
  port?: number;
}

/**
 * Hosted (Streamable HTTP) serving. Stateless: each request gets a fresh
 * server + transport pair over one shared read store, so the process can
 * scale horizontally and restart freely. No secrets, no sessions.
 */
export async function serveHttp(
  options: ServeHttpOptions = {},
): Promise<{ close: () => Promise<void>; port: number; httpServer: NodeHttpServer }> {
  const store = await DocketStore.open(resolveDbUrl(options));
  const port = options.port ?? Number(process.env.PORT ?? 3939);

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: DOCKET_VERSION }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    try {
      const server = createDocketMcpServer(store);
      const transport = new StreamableHTTPServerTransport({
        // Stateless mode: no session ids, no server-side state between calls.
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[docket-mcp] request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  return {
    port,
    httpServer,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
      await store.close();
    },
  };
}
