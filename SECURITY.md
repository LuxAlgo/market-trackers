# Security policy

LuxAlgo Market Trackers runs locally, holds no credentials beyond optional free-tier API keys the user supplies,
and has no telemetry. Still, parsers consume untrusted documents from the public internet — bugs
there matter.

## Reporting

Please report vulnerabilities privately via
[GitHub's private vulnerability reporting](https://github.com/LuxAlgo/market-trackers/security/advisories/new)
rather than opening a public issue. Include the affected package (`core`/`mcp`/`cli`), a
reproduction, and the document or input that triggers it if applicable.

## Scope notes

- The MCP HTTP transport is stateless and read-only by design; it should never expose write
  operations on the store.
- Anything that could make the EDGAR client exceed SEC fair-access limits (10 req/s) is treated
  as a bug with security-adjacent priority.
