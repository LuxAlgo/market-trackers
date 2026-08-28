/**
 * Minimal leveled logger. Always writes to stderr: stdout belongs to MCP
 * stdio transports and `--json` CLI output, and must never be polluted.
 * No telemetry, no network — logs stay on the user's machine.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

export function createLogger(level: LogLevel = "info", prefix = ""): Logger {
  const threshold = level === "silent" ? Number.POSITIVE_INFINITY : LEVEL_ORDER[level];

  function write(
    kind: Exclude<LogLevel, "silent">,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    if (LEVEL_ORDER[kind] < threshold) return;
    const parts = [`[market-trackers]${prefix ? ` [${prefix}]` : ""} ${kind}: ${message}`];
    if (extra && Object.keys(extra).length > 0) parts.push(JSON.stringify(extra));
    process.stderr.write(parts.join(" ") + "\n");
  }

  return {
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
    child: (childPrefix: string) =>
      createLogger(level, prefix ? `${prefix}:${childPrefix}` : childPrefix),
  };
}

export const silentLogger = createLogger("silent");
