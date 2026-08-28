import { z } from "zod";
import { createPoliteFetch, HttpError, type PoliteFetch } from "../../lib/http.js";
import { RateLimiter } from "../../lib/rate-limiter.js";
import type { Logger } from "../../lib/logger.js";
import { silentLogger } from "../../lib/logger.js";

/**
 * Polite client for the Senate eFD search system (efdsearch.senate.gov).
 *
 * eFD requires no key, but search only answers sessions that have accepted
 * the ethics-act prohibition agreement: GET the search home (collects the
 * `csrftoken` cookie), POST the agreement (earns the session cookie), then
 * POST the DataTables-style JSON grid for filings. Cookies live in a small
 * in-memory jar; redirects are followed manually so Set-Cookie headers on
 * 3xx hops are never lost.
 *
 * Politeness: shared RateLimiter at ≤2 requests per rolling second and a
 * declared market-trackers User-Agent on every request.
 */

export const SENATE_EFD_BASE = "https://efdsearch.senate.gov";
export const SENATE_EFD_SEARCH_HOME = `${SENATE_EFD_BASE}/search/home/`;
/** Historically the JSON grid endpoint; confirm live before relying on it. */
export const SENATE_EFD_SEARCH_DATA = `${SENATE_EFD_BASE}/search/report/data/`;

/** Report-type filter value for Periodic Transaction Reports on the eFD grid. */
export const EFD_PTR_REPORT_TYPES = "[11]";

export class EfdClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EfdClientError";
  }
}

/** "2026-08-05" → "08/05/2026" (the date format eFD forms expect). */
export function toEfdDate(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new EfdClientError(`not a YYYY-MM-DD date: '${iso}'`);
  return `${match[2]}/${match[3]}/${match[1]}`;
}

/** "08/05/2026" (optionally with a trailing time) → "2026-08-05"; null when unrecognizable. */
export function efdDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function setCookieLines(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie();
  const single = headers.get("set-cookie");
  // Fallback split: cookie boundaries are ", name=" — naive on Expires dates,
  // but only exercised on runtimes without getSetCookie().
  return single ? single.split(/,\s*(?=[^;,\s=]+=)/) : [];
}

/** Minimal in-memory cookie jar: name→value, latest write wins. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Records every Set-Cookie header on the response. */
  storeFrom(response: Response): void {
    for (const line of setCookieLines(response.headers)) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | null {
    return this.cookies.get(name) ?? null;
  }

  /** Value for a Cookie request header; null when the jar is empty. */
  header(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

const searchResponseSchema = z.object({
  data: z.array(z.array(z.string())),
  recordsTotal: z.number().int().nonnegative(),
});

export interface EfdSearchRow {
  firstName: string;
  lastName: string;
  office: string;
  /** Filing UUID from the report link. */
  docId: string;
  /** Web-table PTR vs scanned paper filing. */
  docType: "ptr" | "paper";
  /** Link text verbatim (e.g. "Periodic Transaction Report for 08/12/2026"). */
  reportTitle: string;
  /** Filed date, normalized to YYYY-MM-DD. */
  filedAt: string;
  /** Absolute view URL — the provenance deep link. */
  url: string;
}

export interface EfdSearchPage {
  rows: EfdSearchRow[];
  recordsTotal: number;
  /** Raw grid rows as returned, for structural fingerprinting. */
  raw: string[][];
}

export interface EfdSearchParams {
  /** Inclusive filed-date lower bound (YYYY-MM-DD). */
  filedAfter: string;
  /** Optional inclusive filed-date upper bound (YYYY-MM-DD). */
  filedBefore?: string;
  start: number;
  length: number;
}

const VIEW_HREF_PATTERN =
  /\/search\/view\/(ptr|paper)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

export function senatePtrViewUrl(docId: string): string {
  return `${SENATE_EFD_BASE}/search/view/ptr/${docId}/`;
}

export function senatePaperViewUrl(docId: string): string {
  return `${SENATE_EFD_BASE}/search/view/paper/${docId}/`;
}

/**
 * Deterministic description of the search grid's row shape (column count +
 * which columns carry the report link and the filed date). Canary input:
 * a moved or added column must change this string. Null when no rows.
 */
export function searchRowShape(raw: string[][]): string | null {
  const first = raw[0];
  if (!first) return null;
  const linkIndex = first.findIndex((cell) => VIEW_HREF_PATTERN.test(cell));
  const dateIndex = first.findIndex((cell) => /^\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(cell));
  return `columns=${first.length};link=${linkIndex};date=${dateIndex}`;
}

export interface SenateEfdClientOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export class SenateEfdClient {
  private readonly politeFetch: PoliteFetch;
  private readonly logger: Logger;
  readonly jar = new CookieJar();
  private agreed = false;

  constructor(options: SenateEfdClientOptions) {
    this.logger = (options.logger ?? silentLogger).child("efd");
    this.politeFetch = createPoliteFetch({
      userAgent: options.userAgent,
      limiter: new RateLimiter({ limit: 2, windowMs: 1_000 }),
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      logger: this.logger,
    });
  }

  private cookieHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const cookie = this.jar.header();
    return cookie ? { cookie, ...extra } : { ...extra };
  }

  /** Follows 3xx hops manually so every hop's cookies land in the jar. */
  private async fetchWithJar(
    url: string,
    init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    let currentUrl = url;
    let current: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } =
      init;
    for (let hop = 0; hop < 5; hop++) {
      const response = await this.politeFetch(currentUrl, {
        method: current.method ?? "GET",
        headers: this.cookieHeaders(current.headers),
        body: current.body,
        redirect: "manual",
      });
      this.jar.storeFrom(response);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.arrayBuffer().catch(() => undefined);
        if (!location) throw new EfdClientError(`redirect without location from ${currentUrl}`);
        currentUrl = new URL(location, currentUrl).toString();
        current = {}; // 3xx re-requests as a plain GET
        continue;
      }
      return response;
    }
    throw new EfdClientError(`too many redirects starting from ${url}`);
  }

  /**
   * GET the search home (collect `csrftoken`), then POST the prohibition
   * agreement to earn the session cookie. Idempotent per client instance.
   */
  async acceptAgreement(): Promise<void> {
    if (this.agreed) return;

    const home = await this.fetchWithJar(SENATE_EFD_SEARCH_HOME);
    const homeHtml = await home.text();
    if (!home.ok) throw new HttpError(SENATE_EFD_SEARCH_HOME, home.status);

    // Django wants the form token (mirrored in the page) and the cookie to agree.
    const formToken = homeHtml.match(
      /name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/,
    )?.[1];
    const csrf = formToken ?? this.jar.get("csrftoken");
    if (!csrf) {
      throw new EfdClientError("search home set no csrftoken cookie and embeds no form token");
    }

    const response = await this.fetchWithJar(SENATE_EFD_SEARCH_HOME, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: SENATE_EFD_SEARCH_HOME,
      },
      body: new URLSearchParams({
        prohibition_agreement: "1",
        csrfmiddlewaretoken: csrf,
      }).toString(),
    });
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new HttpError(SENATE_EFD_SEARCH_HOME, response.status);
    this.agreed = true;
    this.logger.debug("eFD agreement accepted");
  }

  /**
   * One page of the PTR search grid, filed-date filtered and ordered by
   * filed date ascending. Callers page via `start`/`length` against
   * `recordsTotal`.
   */
  async searchPtrs(params: EfdSearchParams): Promise<EfdSearchPage> {
    await this.acceptAgreement();
    const csrf = this.jar.get("csrftoken");

    const form = new URLSearchParams({
      start: String(params.start),
      length: String(params.length),
      report_types: EFD_PTR_REPORT_TYPES,
      filer_types: "[]",
      submitted_start_date: `${toEfdDate(params.filedAfter)} 00:00:00`,
      submitted_end_date: params.filedBefore ? `${toEfdDate(params.filedBefore)} 23:59:59` : "",
      candidate_state: "",
      senator_state: "",
      office_id: "",
      first_name: "",
      last_name: "",
      // DataTables ordering: column 4 is the filed date on the PTR grid.
      "order[0][column]": "4",
      "order[0][dir]": "asc",
    });

    const response = await this.fetchWithJar(SENATE_EFD_SEARCH_DATA, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        referer: `${SENATE_EFD_BASE}/search/`,
        ...(csrf ? { "x-csrftoken": csrf } : {}),
      },
      body: form.toString(),
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HttpError(SENATE_EFD_SEARCH_DATA, response.status);
    }
    const parsed = searchResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new EfdClientError(`search response shape not recognized: ${parsed.error.message}`);
    }

    const rows: EfdSearchRow[] = [];
    for (const raw of parsed.data.data) {
      const row = parseSearchRow(raw);
      if (row) rows.push(row);
      else this.logger.warn("skipping unrecognizable search grid row", { raw });
    }
    return { rows, recordsTotal: parsed.data.recordsTotal, raw: parsed.data.data };
  }

  /** Fetches a web-table PTR page's HTML. */
  async fetchPtrHtml(docId: string): Promise<string> {
    await this.acceptAgreement();
    const url = senatePtrViewUrl(docId);
    const response = await this.fetchWithJar(url, {
      headers: { referer: `${SENATE_EFD_BASE}/search/` },
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new HttpError(url, response.status);
    }
    return response.text();
  }
}

/**
 * One grid row → typed search row. Grid rows are
 * `[firstName, lastName, office, reportLinkHtml, filedDate]`; returns null
 * when the row doesn't carry a recognizable PTR/paper link or filed date.
 */
export function parseSearchRow(raw: string[]): EfdSearchRow | null {
  const linkCell = raw.find((cell) => VIEW_HREF_PATTERN.test(cell));
  if (!linkCell) return null;
  const href = linkCell.match(VIEW_HREF_PATTERN);
  if (!href) return null;
  const docType = (href[1] as string).toLowerCase() as "ptr" | "paper";
  const docId = (href[2] as string).toLowerCase();

  const dateCell = raw.find((cell) => /^\s*\d{1,2}\/\d{1,2}\/\d{4}/.test(cell));
  const filedAt = dateCell ? efdDateToIso(dateCell) : null;
  if (!filedAt) return null;

  const reportTitle = linkCell
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    firstName: (raw[0] ?? "").trim(),
    lastName: (raw[1] ?? "").trim(),
    office: (raw[2] ?? "").trim(),
    docId,
    docType,
    reportTitle,
    filedAt,
    url: docType === "ptr" ? senatePtrViewUrl(docId) : senatePaperViewUrl(docId),
  };
}
