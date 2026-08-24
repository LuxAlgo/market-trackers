import { describe, expect, it } from "vitest";
import {
  CookieJar,
  EfdClientError,
  SenateEfdClient,
  SENATE_EFD_BASE,
  SENATE_EFD_SEARCH_DATA,
  SENATE_EFD_SEARCH_HOME,
  efdDateToIso,
  parseSearchRow,
  searchRowShape,
  senatePtrViewUrl,
  toEfdDate,
} from "./client.js";
import { readFixture, readFixtureJson } from "../../test-helpers.js";

const CSRF = "fixture-csrf-token-0123456789abcdef";
const PTR_DOC_ID = "3f9b1c2e-8a4d-4e5f-9b6a-7c8d9e0f1a2b";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * Offline stand-in for efdsearch.senate.gov: enforces the cookie handshake
 * the real site requires (csrftoken from the home GET, session cookie from
 * the agreement 302) so the client's jar and redirect handling are proven,
 * not assumed.
 */
function mockEfdServer(): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, headers, body });
    const cookies = headers.get("cookie") ?? "";

    if (url === SENATE_EFD_SEARCH_HOME && method === "GET") {
      const h = new Headers({ "content-type": "text/html" });
      h.append("set-cookie", `csrftoken=${CSRF}; Path=/; SameSite=Lax`);
      return new Response(readFixture("senate-efd", "search-home.html"), {
        status: 200,
        headers: h,
      });
    }
    if (url === SENATE_EFD_SEARCH_HOME && method === "POST") {
      const form = new URLSearchParams(body);
      const agreed =
        form.get("prohibition_agreement") === "1" &&
        form.get("csrfmiddlewaretoken") === CSRF &&
        cookies.includes(`csrftoken=${CSRF}`) &&
        (headers.get("referer") ?? "") === SENATE_EFD_SEARCH_HOME;
      if (!agreed) return new Response("agreement rejected", { status: 400 });
      const h = new Headers({ location: "/search/" });
      h.append("set-cookie", "sessionid=fixture-session-id; Path=/; HttpOnly");
      return new Response(null, { status: 302, headers: h });
    }
    if (url === `${SENATE_EFD_BASE}/search/` && method === "GET") {
      return new Response("<html>search</html>", { status: 200 });
    }
    if (url === SENATE_EFD_SEARCH_DATA && method === "POST") {
      if (!cookies.includes("sessionid=fixture-session-id")) {
        return new Response("no session", { status: 400 });
      }
      if ((headers.get("x-csrftoken") ?? "") !== CSRF) {
        return new Response("csrf mismatch", { status: 400 });
      }
      return new Response(readFixture("senate-efd", "search-data-page.json"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === senatePtrViewUrl(PTR_DOC_ID) && method === "GET") {
      return new Response(readFixture("senate-efd", "case-ptr-clean-multirow", "input.html"), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function makeClient(fetchImpl: typeof fetch): SenateEfdClient {
  return new SenateEfdClient({
    userAgent: "docket-test/0.0",
    fetchImpl,
    sleep: async () => {},
  });
}

describe("CookieJar", () => {
  it("stores every Set-Cookie header, strips attributes, and builds the Cookie header", () => {
    const jar = new CookieJar();
    const headers = new Headers();
    headers.append("set-cookie", "csrftoken=abc123; Path=/; SameSite=Lax");
    headers.append("set-cookie", "sessionid=xyz789; HttpOnly; Secure");
    jar.storeFrom(new Response(null, { headers }));
    expect(jar.get("csrftoken")).toBe("abc123");
    expect(jar.get("sessionid")).toBe("xyz789");
    expect(jar.header()).toBe("csrftoken=abc123; sessionid=xyz789");
  });

  it("overwrites on re-set and deletes on empty value", () => {
    const jar = new CookieJar();
    const first = new Headers();
    first.append("set-cookie", "csrftoken=old");
    jar.storeFrom(new Response(null, { headers: first }));
    const second = new Headers();
    second.append("set-cookie", "csrftoken=new");
    second.append("set-cookie", "stale=; Max-Age=0");
    jar.storeFrom(new Response(null, { headers: second }));
    expect(jar.get("csrftoken")).toBe("new");
    expect(jar.get("stale")).toBeNull();
  });

  it("is empty until something is stored", () => {
    expect(new CookieJar().header()).toBeNull();
  });
});

describe("eFD date conversion", () => {
  it("round-trips ISO and eFD forms", () => {
    expect(toEfdDate("2026-08-05")).toBe("08/05/2026");
    expect(efdDateToIso("08/05/2026")).toBe("2026-08-05");
    expect(efdDateToIso("8/5/2026 10:32:11")).toBe("2026-08-05");
    expect(efdDateToIso("not a date")).toBeNull();
    expect(efdDateToIso("13/40/2026")).toBeNull();
    expect(() => toEfdDate("08/05/2026")).toThrow(EfdClientError);
  });
});

describe("search grid row parsing", () => {
  const raw = readFixtureJson<{ data: string[][] }>("senate-efd", "search-data-page.json").data;

  it("extracts docId, view type, and normalized filed date", () => {
    const ptr = parseSearchRow(raw[0] as string[]);
    expect(ptr).toEqual({
      firstName: "Sheldon",
      lastName: "Whitehouse",
      office: "Whitehouse, Sheldon (Senator)",
      docId: PTR_DOC_ID,
      docType: "ptr",
      reportTitle: "Periodic Transaction Report for 08/12/2026",
      filedAt: "2026-08-12",
      url: senatePtrViewUrl(PTR_DOC_ID),
    });
    const paper = parseSearchRow(raw[2] as string[]);
    expect(paper?.docType).toBe("paper");
    expect(paper?.url).toContain("/search/view/paper/");
  });

  it("returns null for rows without a recognizable report link", () => {
    expect(parseSearchRow(["A", "B", "C", "no link here", "08/12/2026"])).toBeNull();
  });

  it("fingerprints the row shape", () => {
    expect(searchRowShape(raw)).toBe("columns=5;link=3;date=4");
    expect(searchRowShape([])).toBeNull();
  });
});

describe("SenateEfdClient", () => {
  it("accepts the agreement (csrf + referer), carries cookies, and pages the grid", async () => {
    const { fetchImpl, requests } = mockEfdServer();
    const client = makeClient(fetchImpl);
    const page = await client.searchPtrs({ filedAfter: "2026-08-12", start: 0, length: 100 });

    expect(page.recordsTotal).toBe(3);
    expect(page.rows.map((r) => r.docType)).toEqual(["ptr", "ptr", "paper"]);
    expect(page.rows.map((r) => r.filedAt)).toEqual(["2026-08-12", "2026-08-13", "2026-08-14"]);

    // The exact polite handshake: home GET → agreement POST → 302 follow → data POST.
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${SENATE_EFD_SEARCH_HOME}`,
      `POST ${SENATE_EFD_SEARCH_HOME}`,
      `GET ${SENATE_EFD_BASE}/search/`,
      `POST ${SENATE_EFD_SEARCH_DATA}`,
    ]);
    for (const request of requests) {
      expect(request.headers.get("user-agent")).toBe("docket-test/0.0");
    }
    const search = requests[3] as RecordedRequest;
    const form = new URLSearchParams(search.body);
    expect(form.get("report_types")).toBe("[11]");
    expect(form.get("submitted_start_date")).toBe("08/12/2026 00:00:00");
    expect(form.get("start")).toBe("0");
    expect(form.get("length")).toBe("100");
  });

  it("accepts the agreement only once per client", async () => {
    const { fetchImpl, requests } = mockEfdServer();
    const client = makeClient(fetchImpl);
    await client.searchPtrs({ filedAfter: "2026-08-12", start: 0, length: 100 });
    await client.searchPtrs({ filedAfter: "2026-08-12", start: 0, length: 100 });
    const homeGets = requests.filter((r) => r.url === SENATE_EFD_SEARCH_HOME && r.method === "GET");
    expect(homeGets).toHaveLength(1);
  });

  it("fetches a PTR page with the session attached", async () => {
    const { fetchImpl, requests } = mockEfdServer();
    const client = makeClient(fetchImpl);
    const html = await client.fetchPtrHtml(PTR_DOC_ID);
    expect(html).toContain("Periodic Transaction Report");
    const last = requests[requests.length - 1] as RecordedRequest;
    expect(last.url).toBe(senatePtrViewUrl(PTR_DOC_ID));
    expect(last.headers.get("cookie")).toContain("sessionid=fixture-session-id");
  });

  it("throws a typed error when the grid response shape is unrecognizable", async () => {
    const { fetchImpl } = mockEfdServer();
    const shapeShifted = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === SENATE_EFD_SEARCH_DATA) {
        return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
      }
      return fetchImpl(input, init);
    }) as typeof fetch;
    const client = makeClient(shapeShifted);
    await expect(
      client.searchPtrs({ filedAfter: "2026-08-12", start: 0, length: 100 }),
    ).rejects.toThrow(EfdClientError);
  });
});
