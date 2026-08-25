/**
 * @luxalgo/docket-core — the public record of US markets, as a library.
 *
 * Ingestors (primary sources only), zod schemas, storage (SQLite default /
 * Postgres optional), entity resolution, dump export, and the canary
 * machinery. Every stored row carries provenance with a working
 * primary-source URL.
 */

export * from "./schema/index.js";
export * from "./store/index.js";
export * from "./config.js";

export * from "./lib/logger.js";
export * from "./lib/dates.js";
export * from "./lib/rate-limiter.js";
export * from "./lib/http.js";
export * from "./lib/amount-ranges.js";

export * from "./sources/types.js";
export * from "./sources/registry.js";
export * from "./sources/scaffold.js";
export {
  EdgarClient,
  dailyIndexUrl,
  filingTxtUrl,
  filingIndexUrl,
  accessionFromPath,
  COMPANY_TICKERS_URL,
  EDGAR_BASE,
  EDGAR_DATA_BASE,
} from "./sources/edgar/client.js";
export * from "./sources/edgar/daily-index.js";
export * from "./sources/edgar/full-submission.js";
export * from "./sources/edgar/form-ownership.js";
export * from "./sources/edgar/thirteenf.js";
export { edgarSource } from "./sources/edgar/source.js";
export * from "./sources/finra-shortvol/parser.js";
export { finraSource, shortVolumeFileUrl } from "./sources/finra-shortvol/source.js";
export * from "./sources/senate-efd/source.js";
export {
  SenateEfdClient,
  CookieJar,
  EfdClientError,
  EFD_PTR_REPORT_TYPES,
  efdDateToIso,
  toEfdDate,
  parseSearchRow,
  searchRowShape,
  senatePtrViewUrl,
  senatePaperViewUrl,
  type EfdSearchRow,
  type EfdSearchPage,
  type EfdSearchParams,
  type SenateEfdClientOptions,
} from "./sources/senate-efd/client.js";
export * from "./sources/senate-efd/ptr-html.js";
export * from "./sources/senate-efd/scan-extract.js";
export * from "./sources/house-clerk/source.js";
export {
  fetchYearIndex,
  extractYearIndexXml,
  parseYearIndexXml,
  normalizeIndexDate,
  HouseClerkIndexError,
  type HouseIndexFiling,
  type YearIndexFetchResult,
  type YearIndexParseResult,
} from "./sources/house-clerk/client.js";
export * from "./sources/house-clerk/parse-ptr-items.js";
export * from "./sources/house-clerk/pdf-text.js";
export * from "./sources/usaspending/source.js";
export * from "./sources/lda/source.js";
export * from "./sources/congress-legislators/source.js";
export * from "./sources/patentsview/source.js";
export * from "./sources/clinicaltrials/source.js";
export * from "./sources/openfda/source.js";
export * from "./sources/cftc/source.js";

export * from "./resolve/normalize.js";
export * from "./resolve/recipients.js";
export * from "./resolve/cik-ticker.js";
export * from "./resolve/cusip.js";
export * from "./resolve/members.js";

export * from "./sync/engine.js";
export * from "./backfill/engine.js";
export * from "./canary/runner.js";
export * from "./export/writer.js";
export * from "./export/feeds.js";
export * from "./export/import.js";

export * from "./analytics/prices.js";
export * from "./analytics/event-returns.js";
export * from "./analytics/adapters.js";
