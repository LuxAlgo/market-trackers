import type { DatasetDefinition, DatasetId } from "../schema/datasets.js";
import type { CongressTrade } from "../schema/congress-trade.js";
import type { InsiderTransaction } from "../schema/insider-transaction.js";
import type { ThirteenfHolding } from "../schema/thirteenf-holding.js";
import type { GovContractAward } from "../schema/gov-contract-award.js";
import type { LobbyingFiling } from "../schema/lobbying-filing.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";
import type { CommitteeAssignment } from "../schema/committee-assignment.js";
import type { Patent } from "../schema/patent.js";
import type { ClinicalTrial } from "../schema/clinical-trial.js";
import type { FdaApproval } from "../schema/fda-approval.js";
import type { CotReport } from "../schema/cot-report.js";
import type { WikiPageview } from "../schema/wiki-pageview.js";
import type { Bill } from "../schema/bill.js";
import type { FecCandidate } from "../schema/fec-candidate.js";
import type { FecContribution } from "../schema/fec-contribution.js";
import type { CongressHearing } from "../schema/congress-hearing.js";
import type { FedCommunication } from "../schema/fed-communication.js";

/**
 * RSS 2.0 feeds over the newest rows of each dataset — the zero-server
 * alerting layer. Every item links the primary-source document, so a feed
 * reader (or anything watching the data repo) gets receipts, not summaries.
 * Titles are strictly factual restatements of the row.
 */

export const MAX_ITEMS = 100;

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

type Titler = (record: never) => string;

const TITLERS: Record<DatasetId, Titler> = {
  "congress-trades": ((r: CongressTrade) =>
    `${r.member.name} (${r.chamber}) ${r.side}: ${r.ticker ?? r.assetDescription} — ${r.amountRange.text}`) as Titler,
  "insider-transactions": ((r: InsiderTransaction) =>
    `${r.insider.name} (${r.ticker ?? r.issuerName}) ${r.code ?? "holding"}${
      r.shares !== null ? `: ${r.shares} shares` : ""
    }${r.pricePerShare !== null ? ` @ $${r.pricePerShare}` : ""}`) as Titler,
  "thirteenf-holdings": ((r: ThirteenfHolding) =>
    `${r.managerName}: ${r.shares} ${r.ticker ?? r.issuerName} (${r.periodEnd}${
      r.putCall ? `, ${r.putCall}` : ""
    })`) as Titler,
  "gov-contracts": ((r: GovContractAward) =>
    `${r.recipient.name}${r.amountUsd !== null ? ` — $${r.amountUsd}` : ""} from ${r.agency} (${r.actionDate})`) as Titler,
  "gov-grants": ((r: GovContractAward) =>
    `${r.recipient.name}${r.amountUsd !== null ? ` — $${r.amountUsd}` : ""} grant from ${r.agency} (${r.actionDate})`) as Titler,
  "lobbying-filings": ((r: LobbyingFiling) =>
    `${r.client.name} via ${r.registrant.name} (${r.filingYear} ${r.filingPeriod})${
      r.amountUsd !== null ? ` — $${r.amountUsd}` : ""
    }`) as Titler,
  "short-volume": ((r: ShortVolumeDay) =>
    `${r.ticker} ${r.date}: ${r.shortVolume}/${r.totalVolume} short${
      r.shortRatio !== null ? ` (${(r.shortRatio * 100).toFixed(1)}%)` : ""
    }`) as Titler,
  "committee-assignments": ((r: CommitteeAssignment) =>
    `${r.memberName} — ${r.committee.name}${r.subcommittee ? ` / ${r.subcommittee.name}` : ""}${
      r.title ? ` (${r.title})` : ""
    }`) as Titler,
  patents: ((r: Patent) =>
    `${r.assignee.name ?? "Unassigned"}: ${r.title} (${r.patentId}, ${r.grantDate})`) as Titler,
  "clinical-trials": ((r: ClinicalTrial) =>
    `${r.sponsor.name} — ${r.overallStatus}${r.phase ? ` ${r.phase}` : ""}: ${r.title}`) as Titler,
  "fda-approvals": ((r: FdaApproval) =>
    `${r.sponsor.name} ${r.applicationNumber} ${r.submissionType} ${r.submissionNumber}${
      r.submissionStatus ? `: ${r.submissionStatus}` : ""
    } (${r.statusDate})`) as Titler,
  "cot-reports": ((r: CotReport) => `${r.marketName} — COT ${r.reportDate}`) as Titler,
  "wiki-pageviews": ((r: WikiPageview) =>
    `${r.article} (${r.tickers.join(", ") || r.project}): ${r.views} views on ${r.day}`) as Titler,
  bills: ((r: Bill) =>
    `${r.billType.toUpperCase()} ${r.billNumber} (${r.congress}th)${
      r.latestActionDate ? ` — action ${r.latestActionDate}` : ""
    }: ${r.title.length > 140 ? `${r.title.slice(0, 137)}...` : r.title}`) as Titler,
  "fec-candidates": ((r: FecCandidate) =>
    `${r.name} (${r.party ?? "?"}, ${r.office}${r.state ? `-${r.state}` : ""}) ${r.cycle}${
      r.totalReceipts !== null ? `: $${r.totalReceipts} receipts` : ""
    }`) as Titler,
  "fec-contributions": ((r: FecContribution) =>
    `${r.committeeName ?? r.committeeId} → ${r.candidateName ?? r.candidateId}: $${r.amountUsd}${
      r.date ? ` (${r.date})` : ""
    }`) as Titler,
  "congress-hearings": ((r: CongressHearing) =>
    `${r.chamber ?? r.docClass ?? "joint"} hearing ${r.heldDate}${
      r.committees[0] ? ` — ${r.committees[0].name}` : ""
    }: ${r.title.length > 140 ? `${r.title.slice(0, 137)}...` : r.title}`) as Titler,
  "fed-communications": ((r: FedCommunication) =>
    `${r.type} ${r.date}${r.speaker ? ` — ${r.speaker}` : ""}: ${
      r.title.length > 140 ? `${r.title.slice(0, 137)}...` : r.title
    }`) as Titler,
};

export interface FeedRow {
  id: string;
  provenance: { sourceUrl: string; retrievedAt: string };
}

/** Newest-first by retrievedAt — the one ordering both `buildRssFeed` and `BoundedFeedSelection` use. */
function itemOrder(a: FeedRow, b: FeedRow): number {
  return a.provenance.retrievedAt < b.provenance.retrievedAt ? 1 : -1;
}

/**
 * Renders already-selected, already-ordered items — no sorting here. Split
 * out from `buildRssFeed` so a caller that assembled its own bounded
 * selection (`BoundedFeedSelection` below) can render it without a second
 * sort pass: re-sorting a subset with this comparator does not reliably
 * reproduce the tie order a full-array sort produced, since the comparator
 * treats equal timestamps as "first argument wins" rather than "equal" —
 * consistent per single sort call, not across two sorts of different-sized
 * arrays.
 */
export function renderFeedXml<T extends FeedRow>(
  dataset: DatasetDefinition<T>,
  items: readonly T[],
  generatedAt: string,
  titleSuffix?: string,
): string {
  const titler = TITLERS[dataset.id] as unknown as (record: T) => string;
  const itemsXml = items
    .map((row) =>
      [
        "    <item>",
        `      <title>${esc(titler(row))}</title>`,
        `      <link>${esc(row.provenance.sourceUrl)}</link>`,
        `      <guid isPermaLink="false">${esc(`${dataset.id}:${row.id}`)}</guid>`,
        `      <pubDate>${rfc822(row.provenance.retrievedAt)}</pubDate>`,
        "    </item>",
      ].join("\n"),
    )
    .join("\n");

  const titleParts = [`LuxAlgo Market Trackers — ${esc(dataset.title)}`];
  if (titleSuffix) titleParts.push(esc(titleSuffix));

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0">`,
    `  <channel>`,
    `    <title>${titleParts.join(" — ")}</title>`,
    `    <link>https://github.com/LuxAlgo/market-trackers</link>`,
    `    <description>${esc(dataset.description)} Every item links its primary-source document.</description>`,
    `    <lastBuildDate>${rfc822(generatedAt)}</lastBuildDate>`,
    itemsXml,
    `  </channel>`,
    `</rss>`,
    ``,
  ].join("\n");
}

/**
 * `titleSuffix`, when given, scopes the feed to one entity within the
 * dataset (a ticker, or — for congress-trades — a member): the channel
 * title gains a trailing "— {titleSuffix}" and everything else (item shape,
 * titler, link, guid, pubDate, description) renders exactly as it does for
 * the whole-dataset feed. See `export/entity-feeds.ts`, the only caller that
 * passes it today.
 */
export function buildRssFeed<T extends FeedRow>(
  dataset: DatasetDefinition<T>,
  rows: T[],
  generatedAt: string,
  titleSuffix?: string,
): string {
  const items = [...rows].sort(itemOrder).slice(0, MAX_ITEMS);
  return renderFeedXml(dataset, items, generatedAt, titleSuffix);
}

/**
 * Incremental counterpart to `buildRssFeed`'s item selection, for a caller
 * streaming rows it can't materialize in full (a day's worth of a
 * backfilled store). Each `push` binary-searches the capped buffer with the
 * exact comparator a one-shot `sort+slice` uses, so the final buffer order
 * matches `[...allRows].sort(itemOrder).slice(0, cap)` exactly, tie for
 * tie — insertion order and a single full sort make the same sequence of
 * pairwise comparisons, just spread over time instead of done at once.
 * Render the result with `renderFeedXml`, not `buildRssFeed` (see above).
 */
export class BoundedFeedSelection<T extends FeedRow> {
  private readonly buf: T[] = [];

  constructor(private readonly cap: number = MAX_ITEMS) {}

  push(row: T): void {
    let lo = 0;
    let hi = this.buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (itemOrder(row, this.buf[mid] as T) < 0) hi = mid;
      else lo = mid + 1;
    }
    this.buf.splice(lo, 0, row);
    if (this.buf.length > this.cap) this.buf.pop();
  }

  items(): readonly T[] {
    return this.buf;
  }
}
