/*
  Hosted (Streamable HTTP) entry: `node dist/http.js` on any Node 20+ host
  (PORT env, /mcp endpoint, /health probe). Deploy-agnostic on purpose.
*/
import { serveHttp } from "./server.js";

const { port } = await serveHttp();
console.error(`docket-mcp listening on :${port}/mcp`);
