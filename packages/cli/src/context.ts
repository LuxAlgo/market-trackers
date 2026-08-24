import {
  createLogger,
  DocketStore,
  resolveConfig,
  type ConfigOverrides,
  type DocketConfig,
  type Logger,
  type SourceContext,
} from "@luxalgo/docket-core";

/** Flags shared by every command. */
export interface GlobalFlags {
  db?: string;
  contact?: string;
  log?: DocketConfig["logLevel"];
  json?: boolean;
}

export interface CliContext extends SourceContext {
  store: DocketStore;
  config: DocketConfig;
  logger: Logger;
  close: () => Promise<void>;
}

export async function openContext(flags: GlobalFlags): Promise<CliContext> {
  const overrides: ConfigOverrides = {};
  if (flags.db) overrides.db = flags.db;
  if (flags.contact) overrides.contactEmail = flags.contact;
  if (flags.log) overrides.logLevel = flags.log;
  // --json output owns stdout; keep human logs quiet unless asked.
  if (flags.json && !flags.log) overrides.logLevel = "warn";

  const config = resolveConfig(overrides);
  const store = await DocketStore.open(config.db);
  const logger = createLogger(config.logLevel);
  return {
    store,
    config,
    logger,
    close: () => store.close(),
  };
}

export function printJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

/** Minimal aligned table for human-facing output; no dependencies. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  process.stdout.write(line(headers) + "\n");
  process.stdout.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
  for (const row of rows) process.stdout.write(line(row) + "\n");
}
