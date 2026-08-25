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

/**
 * RSS 2.0 feeds over the newest rows of each dataset — the zero-server
 * alerting layer. Every item links the primary-source document, so a feed
 * reader (or anything watching the data repo) gets receipts, not summaries.
 * Titles are strictly factual restatements of the row.
 */

const MAX_ITEMS = 100;

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
};

export interface FeedRow {
  id: string;
  provenance: { sourceUrl: string; retrievedAt: string };
}

export function buildRssFeed<T extends FeedRow>(
  dataset: DatasetDefinition<T>,
  rows: T[],
  generatedAt: string,
): string {
  const titler = TITLERS[dataset.id] as unknown as (record: T) => string;
  const items = [...rows]
    .sort((a, b) => (a.provenance.retrievedAt < b.provenance.retrievedAt ? 1 : -1))
    .slice(0, MAX_ITEMS)
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

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0">`,
    `  <channel>`,
    `    <title>Docket — ${esc(dataset.title)}</title>`,
    `    <link>https://github.com/LuxAlgo/docket</link>`,
    `    <description>${esc(dataset.description)} Every item links its primary-source document.</description>`,
    `    <lastBuildDate>${rfc822(generatedAt)}</lastBuildDate>`,
    items,
    `  </channel>`,
    `</rss>`,
    ``,
  ].join("\n");
}
