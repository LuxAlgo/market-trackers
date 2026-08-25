/*
  The Docket MCP tool surface — the public record of US markets for AI
  agents. All read-only, keyless, and served from a local (or hosted) Docket
  store. Every payload carries primary-source citation URLs: agents can (and
  should) show the receipt. Amounts that are disclosed as ranges stay ranges.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  INSIDER_TRANSACTION_CODES,
  committeeRoster,
  freshnessReport,
  insiderSummary,
  memberProfile,
  queryClinicalTrials,
  queryCongressMembers,
  queryCongressTrades,
  queryCotReports,
  queryFdaApprovals,
  queryGovContracts,
  queryGovGrants,
  queryInsiderTransactions,
  queryLobbying,
  queryPatents,
  queryShortVolume,
  queryThirteenfHolders,
  queryThirteenfManager,
  searchEntities,
  type DocketStore,
} from "@luxalgo/docket-core";

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe("Date as YYYY-MM-DD");

const LIMIT = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe("Max rows (default 50, max 500)");

/** Rows keep full provenance; surface the citation prominently for agents. */
function withCitation<T extends { provenance: { sourceUrl: string } }>(rows: T[]) {
  return rows.map((row) => ({ ...row, citation: row.provenance.sourceUrl }));
}

export function registerDocketTools(server: McpServer, store: DocketStore): void {
  server.registerTool(
    "docket_congress_trades",
    {
      title: "Congressional trades",
      description:
        "Transactions from congressional Periodic Transaction Reports (Senate + House), filterable by ticker, member, chamber, side, and date range. Amounts are disclosed as ranges and stay ranges — use amountRange.min/max, never invent a midpoint. Every row carries `citation`, a deep link to the primary filing; quote it when answering. Dates: transactedAt is when the trade happened, filedAt when it was disclosed (the gap is itself informative).",
      inputSchema: {
        ticker: z.string().optional().describe("Stock ticker, e.g. 'NVDA'"),
        member: z.string().optional().describe("Member name (substring match), e.g. 'pelosi'"),
        chamber: z.enum(["senate", "house"]).optional(),
        since: DATE.optional().describe("Earliest transaction date"),
        until: DATE.optional().describe("Latest transaction date"),
        side: z.enum(["buy", "sell", "exchange"]).optional(),
        limit: LIMIT,
      },
    },
    async ({ ticker, member, chamber, since, until, side, limit }) => {
      const rows = await queryCongressTrades(store, {
        ticker,
        member,
        chamber,
        since,
        until,
        side,
        limit,
      });
      return json({
        count: rows.length,
        data_notes: "Amounts are disclosed ranges; max is null for open-ended top ranges.",
        rows: withCitation(rows),
      });
    },
  );

  server.registerTool(
    "docket_congress_members",
    {
      title: "Congress members with trade activity",
      description:
        "Members of Congress that appear in the trades dataset, with trade counts and last-transaction dates. Use to resolve a fuzzy name ('whitehouse') before calling docket_congress_trades, or to see who trades most. bioguideId is the canonical member identifier (null when unresolved).",
      inputSchema: {
        q: z.string().optional().describe("Name filter (substring); omit to list by trade count"),
        limit: LIMIT,
      },
    },
    async ({ q, limit }) => {
      const members = await queryCongressMembers(store, q, limit);
      return json({ count: members.length, members });
    },
  );

  server.registerTool(
    "docket_insider_trades",
    {
      title: "Insider transactions (SEC Forms 3/4/5)",
      description:
        "Insider transactions parsed from SEC Forms 3/4/5 primary XML on EDGAR. Filter by ticker, insider name, raw SEC transaction codes (P=open-market purchase, S=open-market sale, M=option exercise, G=gift, …; the response ships a legend), value floor, and date range. Every row cites the actual EDGAR filing. Form 3 initial-holding rows have null code/transactedAt.",
      inputSchema: {
        ticker: z.string().optional(),
        insider_name: z.string().optional().describe("Insider name (substring match)"),
        codes: z
          .array(z.string())
          .optional()
          .describe("Raw SEC transaction codes to include, e.g. ['P','S']"),
        since: DATE.optional().describe("Earliest transaction date"),
        until: DATE.optional().describe("Latest transaction date"),
        min_value: z.number().optional().describe("Minimum |shares × pricePerShare| in USD"),
        derivative: z
          .boolean()
          .optional()
          .describe("true = derivative table rows only, false = non-derivative only"),
        limit: LIMIT,
      },
    },
    async ({ ticker, insider_name, codes, since, until, min_value, derivative, limit }) => {
      const rows = await queryInsiderTransactions(store, {
        ticker,
        insiderName: insider_name,
        codes,
        since,
        until,
        minValue: min_value,
        isDerivative: derivative,
        limit,
      });
      const usedCodes = [
        ...new Set(rows.map((r) => r.code).filter((c): c is string => c !== null)),
      ];
      return json({
        count: rows.length,
        code_legend: Object.fromEntries(
          usedCodes.map((c) => [c, INSIDER_TRANSACTION_CODES[c] ?? "See SEC form instructions"]),
        ),
        rows: withCitation(rows),
      });
    },
  );

  server.registerTool(
    "docket_insider_summary",
    {
      title: "Insider activity summary for a ticker",
      description:
        "Aggregates insider activity for one ticker over a window: counts and share totals per raw transaction code, open-market buys vs sells (codes P and S) with net shares, and the insiders with the largest transaction value. Pure arithmetic over the filings — no scores, no signals. For row-level detail call docket_insider_trades.",
      inputSchema: {
        ticker: z.string().min(1),
        window_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("Lookback window in days (default 90)"),
      },
    },
    async ({ ticker, window_days }) => {
      const since = new Date(Date.now() - (window_days ?? 90) * 864e5).toISOString().slice(0, 10);
      const summary = await insiderSummary(store, ticker, since);
      return json({
        ...summary,
        code_legend: Object.fromEntries(
          summary.codeBreakdown.map((c) => [
            c.code,
            INSIDER_TRANSACTION_CODES[c.code] ?? "See SEC form instructions",
          ]),
        ),
        data_notes:
          "openMarket counts only non-derivative P (purchase) and S (sale) rows; codeBreakdown carries everything else (grants, exercises, gifts, …).",
      });
    },
  );

  server.registerTool(
    "docket_13f_holders",
    {
      title: "13F holders of a security",
      description:
        "Institutional holders of a ticker or CUSIP from quarterly 13F-HR filings: shares and value per manager for the requested period (default: latest on record), with share changes vs the prior period where a prior filing exists. Put/call positions are reported separately from long positions. valueUsd is normalized to whole dollars across filing eras. Each holder row cites the manager's actual filing.",
      inputSchema: {
        ticker: z.string().optional(),
        cusip: z.string().optional().describe("9-character CUSIP (alternative to ticker)"),
        period_end: DATE.optional().describe("Quarter end, e.g. 2026-06-30 (default: latest)"),
        limit: LIMIT,
      },
    },
    async ({ ticker, cusip, period_end, limit }) => {
      if (!ticker && !cusip) return toolError("Provide ticker or cusip");
      const result = await queryThirteenfHolders(store, { ticker, cusip }, period_end, limit);
      return json({
        period_end: result.periodEnd,
        prior_period_end: result.priorPeriodEnd,
        count: result.holders.length,
        data_notes:
          "13F holdings are quarterly and filed up to 45 days after quarter end — always stale relative to today. sharesChange is null for managers with no prior-period filing on record.",
        holders: result.holders.map((h) => ({ ...h, citation: h.sourceUrl })),
      });
    },
  );

  server.registerTool(
    "docket_13f_manager",
    {
      title: "A 13F manager's holdings",
      description:
        "One institutional manager's 13F holdings for a period (default: their latest filing on record), largest positions first. Identify the manager by CIK, or by name query ('berkshire') which resolves to the best-matching manager in the store. Tickers resolve from CUSIPs where the mapping is known; unresolved holdings keep ticker null but always carry the CUSIP and issuer name.",
      inputSchema: {
        manager_cik: z.string().optional().describe("SEC CIK of the manager (10 digits)"),
        q: z.string().optional().describe("Manager name query (alternative to manager_cik)"),
        period_end: DATE.optional(),
        limit: LIMIT,
      },
    },
    async ({ manager_cik, q, period_end, limit }) => {
      if (!manager_cik && !q) return toolError("Provide manager_cik or q");
      const result = await queryThirteenfManager(
        store,
        { managerCik: manager_cik, q },
        period_end,
        limit,
      );
      if (!result.managerCik) return toolError(`No 13F manager found for '${q ?? manager_cik}'`);
      return json({
        manager_cik: result.managerCik,
        manager_name: result.managerName,
        period_end: result.periodEnd,
        count: result.holdings.length,
        holdings: withCitation(result.holdings),
      });
    },
  );

  server.registerTool(
    "docket_gov_contracts",
    {
      title: "Government contract awards",
      description:
        "Federal contract awards from USAspending, filterable by recipient ticker (via a curated public-company subsidiary map), recipient name, awarding agency, date, and amount floor. recipient.tickers is empty when the recipient hasn't been mapped to a public company — absence of a ticker is not absence of the award. Each row cites its USAspending record.",
      inputSchema: {
        ticker: z.string().optional(),
        recipient: z.string().optional().describe("Recipient name (substring match)"),
        agency: z.string().optional().describe("Awarding agency (substring match)"),
        since: DATE.optional().describe("Earliest action date"),
        min_amount: z.number().optional().describe("Minimum obligated USD"),
        limit: LIMIT,
      },
    },
    async ({ ticker, recipient, agency, since, min_amount, limit }) => {
      const rows = await queryGovContracts(store, {
        ticker,
        recipient,
        agency,
        since,
        minAmount: min_amount,
        limit,
      });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_lobbying",
    {
      title: "Lobbying filings",
      description:
        "Lobbying disclosure filings from the Senate LDA, filterable by client ticker (curated mapping), client name, registrant (the lobbying firm), and year. amountUsd is the reported income/expense for the period (null when none reported); issues are the LDA's general issue codes. Each row cites the actual LDA filing.",
      inputSchema: {
        ticker: z.string().optional(),
        client: z.string().optional().describe("Client name (substring match)"),
        registrant: z.string().optional().describe("Lobbying firm name (substring match)"),
        since_year: z.number().int().optional().describe("Earliest filing year"),
        limit: LIMIT,
      },
    },
    async ({ ticker, client, registrant, since_year, limit }) => {
      const rows = await queryLobbying(store, {
        ticker,
        client,
        registrant,
        sinceYear: since_year,
        limit,
      });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_short_volume",
    {
      title: "Daily short-sale volume",
      description:
        "FINRA Reg SHO daily short-sale volume for a ticker as a day-by-day series: shortVolume, shortExemptVolume, totalVolume, and shortRatio (plain shortVolume/totalVolume — descriptive arithmetic, not a signal; null when total volume is 0). This is off-exchange/TRF-reported volume, not short interest. Each row cites the FINRA daily file it came from.",
      inputSchema: {
        ticker: z.string().min(1),
        from: DATE,
        to: DATE,
      },
    },
    async ({ ticker, from, to }) => {
      const rows = await queryShortVolume(store, ticker, from, to);
      return json({
        ticker: ticker.toUpperCase(),
        from,
        to,
        count: rows.length,
        data_notes:
          "Reg SHO daily volume is not short interest; it reflects reported daily short-sale volume by market.",
        rows: withCitation(rows),
      });
    },
  );

  server.registerTool(
    "docket_gov_grants",
    {
      title: "Government grant awards",
      description:
        "Federal GRANT awards from USAspending (the non-contract award universe: research grants, subsidies, program funding), filterable exactly like docket_gov_contracts — recipient ticker (curated public-company subsidiary map), recipient name, awarding agency, date, and amount floor. recipient.tickers is empty when unmapped; absence of a ticker is not absence of the award. Each row cites its USAspending record.",
      inputSchema: {
        ticker: z.string().optional(),
        recipient: z.string().optional().describe("Recipient name (substring match)"),
        agency: z.string().optional().describe("Awarding agency (substring match)"),
        since: DATE.optional().describe("Earliest action date"),
        min_amount: z.number().optional().describe("Minimum obligated USD"),
        limit: LIMIT,
      },
    },
    async ({ ticker, recipient, agency, since, min_amount, limit }) => {
      const rows = await queryGovGrants(store, {
        ticker,
        recipient,
        agency,
        since,
        minAmount: min_amount,
        limit,
      });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_member_profile",
    {
      title: "Member of Congress — full profile",
      description:
        "One member, fully joined: identity (bioguide/party/state), every committee and subcommittee seat they hold, and their disclosed trading — totals, buys vs sells, most-traded tickers, and their most recent trades with per-filing citations. This is the receipts view for questions like 'what does the Armed Services chair trade?' — the tool reports the facts side by side and leaves interpretation to you. Committee data comes from the public-domain congress-legislators dataset; trades from official disclosures.",
      inputSchema: {
        q: z.string().min(1).describe("Member name (substring) — e.g. 'whitehouse'"),
      },
    },
    async ({ q }) => {
      const profile = await memberProfile(store, q);
      if (!profile.member) return toolError(`No member found matching '${q}'`);
      return json({
        ...profile,
        trades: { ...profile.trades, recent: withCitation(profile.trades.recent) },
        data_notes:
          "Facts joined from public records: committee seats + disclosed trades. Amounts are ranges; no scores or inferences are computed.",
      });
    },
  );

  server.registerTool(
    "docket_committees",
    {
      title: "Committee roster with trade activity",
      description:
        "Resolve a congressional committee by name or thomas id ('armed services', 'SSAS', 'energy and commerce') and get its full roster: every member with their leadership title, subcommittee seats, disclosed-trade count, and last trade date. Pair with docket_congress_trades (filter by the member names returned here) to pull the underlying filings. Facts only — the join between oversight and trading is presented, never scored.",
      inputSchema: {
        q: z.string().min(1).describe("Committee name or thomas id (substring match)"),
      },
    },
    async ({ q }) => {
      const roster = await committeeRoster(store, q);
      if (!roster.committee) return toolError(`No committee found matching '${q}'`);
      return json(roster);
    },
  );

  server.registerTool(
    "docket_patents",
    {
      title: "Granted patents",
      description:
        "US patents granted (USPTO data via PatentsView), filterable by assignee ticker (curated mapping), assignee name, grant-date range, and CPC class. Useful for questions like 'what did this company patent recently?'. assignee.tickers is empty when the assignee isn't mapped to a public company. Each row cites its primary record.",
      inputSchema: {
        ticker: z.string().optional(),
        assignee: z.string().optional().describe("Assignee organization (substring match)"),
        since: DATE.optional().describe("Earliest grant date"),
        until: DATE.optional().describe("Latest grant date"),
        cpc_class: z.string().optional().describe("CPC class prefix, e.g. 'G06'"),
        limit: LIMIT,
      },
    },
    async ({ ticker, assignee, since, until, cpc_class, limit }) => {
      const rows = await queryPatents(store, {
        ticker,
        assignee,
        since,
        until,
        cpcClass: cpc_class,
        limit,
      });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_clinical_trials",
    {
      title: "Clinical trial registrations",
      description:
        "Study registrations from ClinicalTrials.gov, filterable by sponsor ticker (curated mapping), sponsor name, registry status (e.g. RECRUITING, COMPLETED, TERMINATED), phase (e.g. PHASE3), condition, and last-update date. All fields are sponsor-declared registry facts verbatim — including primaryCompletionDate, which is a declared plan, not a decision calendar. Each row cites its ClinicalTrials.gov record.",
      inputSchema: {
        ticker: z.string().optional(),
        sponsor: z.string().optional().describe("Lead sponsor name (substring match)"),
        status: z.string().optional().describe("Registry status, e.g. 'RECRUITING'"),
        phase: z.string().optional().describe("Registry phase, e.g. 'PHASE3'"),
        condition: z.string().optional().describe("Condition (substring match)"),
        since: DATE.optional().describe("Earliest last-update date"),
        limit: LIMIT,
      },
    },
    async ({ ticker, sponsor, status, phase, condition, since, limit }) => {
      const rows = await queryClinicalTrials(store, {
        ticker,
        sponsor,
        status,
        phase,
        condition,
        since,
        limit,
      });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_fda_approvals",
    {
      title: "FDA drug application events",
      description:
        "Drug-application submission events from openFDA's Drugs@FDA — original approvals and supplements with raw FDA status codes (AP approved, TA tentative approval, …), filterable by sponsor ticker (curated mapping), sponsor name, status code, and date. These are recorded regulatory events, not predictions of pending decisions. Each row cites its openFDA record.",
      inputSchema: {
        ticker: z.string().optional(),
        sponsor: z.string().optional().describe("Sponsor name (substring match)"),
        status: z.string().optional().describe("Raw FDA status code, e.g. 'AP'"),
        since: DATE.optional().describe("Earliest status date"),
        limit: LIMIT,
      },
    },
    async ({ ticker, sponsor, status, since, limit }) => {
      const rows = await queryFdaApprovals(store, { ticker, sponsor, status, since, limit });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_cot",
    {
      title: "CFTC Commitments of Traders",
      description:
        "Weekly Commitments of Traders positioning (legacy futures-only) per contract market: open interest and commercial / non-commercial / non-reportable long+short positions, verbatim from the CFTC. Filter by market name ('crude oil', 'e-mini s&p') or contract code, over a date range — rows come back newest first, so a range query yields the series. Published numbers only; net positioning arithmetic is left to the caller.",
      inputSchema: {
        market: z.string().optional().describe("Market name (substring match), e.g. 'crude oil'"),
        contract_code: z.string().optional().describe("CFTC contract market code"),
        from: DATE.optional().describe("Earliest report date"),
        to: DATE.optional().describe("Latest report date"),
        limit: LIMIT,
      },
    },
    async ({ market, contract_code, from, to, limit }) => {
      const rows = await queryCotReports(store, {
        market,
        contractCode: contract_code,
        from,
        to,
        limit,
      });
      return json({ count: rows.length, rows: withCitation(rows) });
    },
  );

  server.registerTool(
    "docket_search",
    {
      title: "Search entities across all datasets",
      description:
        "Cross-dataset entity search: one query over tickers/companies, members of Congress, 13F managers, and insiders, with per-dataset row counts for each hit. The natural first call when you have a name and don't yet know which dataset holds it — results tell you which docket_* tool to call next.",
      inputSchema: {
        q: z.string().min(1).describe("Ticker, company, member, manager, or insider name"),
        limit: LIMIT,
      },
    },
    async ({ q, limit }) => {
      const results = await searchEntities(store, q, limit ?? 10);
      return json({ count: results.length, results });
    },
  );

  server.registerTool(
    "docket_freshness",
    {
      title: "Data freshness & pipeline health",
      description:
        "Per-dataset freshness (row counts, last-ingested timestamps, staleness against each dataset's expected cadence) and per-source pipeline health (last sync outcome, last canary status, watermarks). CHECK THIS before answering time-sensitive questions: quoting stale congress data without knowing it is stale is the failure mode this tool exists to prevent. A dataset with rowCount 0 means this store hasn't synced that source — say so instead of answering from nothing.",
      inputSchema: {},
    },
    async () => {
      const report = await freshnessReport(store);
      return json(report);
    },
  );
}
