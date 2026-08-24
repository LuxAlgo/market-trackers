import type { DatasetId } from "../schema/datasets.js";
import type { Provenance } from "../schema/provenance.js";
import type { CongressTrade } from "../schema/congress-trade.js";
import type { InsiderTransaction } from "../schema/insider-transaction.js";
import type { ThirteenfHolding } from "../schema/thirteenf-holding.js";
import type { GovContractAward } from "../schema/gov-contract-award.js";
import type { LobbyingFiling } from "../schema/lobbying-filing.js";
import type { ShortVolumeDay } from "../schema/short-volume-day.js";

/**
 * Explicit record↔row mappers per dataset. Deliberately boring: flattening
 * is where silent data corruption sneaks in, so it is written out in full and
 * covered by round-trip tests instead of being clever.
 */

export type Row = Record<string, unknown>;

function provToRow(p: Provenance): Row {
  return {
    source: p.source,
    source_url: p.sourceUrl,
    retrieved_at: p.retrievedAt,
    parser: p.parser,
    confidence: p.confidence,
    needs_review: p.needsReview,
  };
}

function provFromRow(row: Row): Provenance {
  return {
    source: row.source,
    sourceUrl: row.source_url,
    retrievedAt: row.retrieved_at,
    parser: row.parser,
    confidence: Number(row.confidence),
    needsReview: toBool(row.needs_review),
  } as Provenance;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1;
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: unknown): string {
  return String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export interface RowMapper<T> {
  toRow(record: T): Row;
  fromRow(row: Row): T;
}

export const congressTradeMapper: RowMapper<CongressTrade> = {
  toRow(r) {
    return {
      id: r.id,
      chamber: r.chamber,
      doc_id: r.docId,
      row_index: r.rowIndex,
      member_name: r.member.name,
      bioguide_id: r.member.bioguideId,
      party: r.member.party,
      state: r.member.state,
      filed_at: r.filedAt,
      transacted_at: r.transactedAt,
      ticker: r.ticker,
      asset_description: r.assetDescription,
      asset_type: r.assetType,
      side: r.side,
      amount_min: r.amountRange.min,
      amount_max: r.amountRange.max,
      amount_text: r.amountRange.text,
      owner: r.owner,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      chamber: row.chamber,
      docId: str(row.doc_id),
      rowIndex: Number(row.row_index),
      member: {
        name: str(row.member_name),
        bioguideId: nullableStr(row.bioguide_id),
        party: nullableStr(row.party),
        state: nullableStr(row.state),
      },
      filedAt: str(row.filed_at),
      transactedAt: str(row.transacted_at),
      ticker: nullableStr(row.ticker),
      assetDescription: str(row.asset_description),
      assetType: row.asset_type,
      side: row.side,
      amountRange: {
        min: Number(row.amount_min),
        max: toNullableNumber(row.amount_max),
        text: str(row.amount_text),
      },
      owner: row.owner ?? null,
      provenance: provFromRow(row),
    } as CongressTrade;
  },
};

export const insiderTransactionMapper: RowMapper<InsiderTransaction> = {
  toRow(r) {
    return {
      id: r.id,
      accession_number: r.accessionNumber,
      form_type: r.formType,
      ticker: r.ticker,
      issuer_cik: r.issuerCik,
      issuer_name: r.issuerName,
      insider_name: r.insider.name,
      insider_cik: r.insider.cik,
      insider_title: r.insider.title,
      is_director: r.insider.isDirector,
      is_officer: r.insider.isOfficer,
      is_ten_pct_owner: r.insider.isTenPctOwner,
      transacted_at: r.transactedAt,
      filed_at: r.filedAt,
      code: r.code,
      acquired_disposed: r.acquiredDisposed,
      security_title: r.securityTitle,
      shares: r.shares,
      price_per_share: r.pricePerShare,
      shares_owned_after: r.sharesOwnedAfter,
      ownership: r.ownership,
      is_derivative: r.isDerivative,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      accessionNumber: str(row.accession_number),
      formType: row.form_type,
      ticker: nullableStr(row.ticker),
      issuerCik: str(row.issuer_cik),
      issuerName: str(row.issuer_name),
      insider: {
        name: str(row.insider_name),
        cik: str(row.insider_cik),
        title: nullableStr(row.insider_title),
        isDirector: toBool(row.is_director),
        isOfficer: toBool(row.is_officer),
        isTenPctOwner: toBool(row.is_ten_pct_owner),
      },
      transactedAt: nullableStr(row.transacted_at),
      filedAt: str(row.filed_at),
      code: nullableStr(row.code),
      acquiredDisposed: row.acquired_disposed ?? null,
      securityTitle: str(row.security_title),
      shares: toNullableNumber(row.shares),
      pricePerShare: toNullableNumber(row.price_per_share),
      sharesOwnedAfter: toNullableNumber(row.shares_owned_after),
      ownership: row.ownership,
      isDerivative: toBool(row.is_derivative),
      provenance: provFromRow(row),
    } as InsiderTransaction;
  },
};

export const thirteenfHoldingMapper: RowMapper<ThirteenfHolding> = {
  toRow(r) {
    return {
      id: r.id,
      accession_number: r.accessionNumber,
      manager_cik: r.managerCik,
      manager_name: r.managerName,
      period_end: r.periodEnd,
      filed_at: r.filedAt,
      cusip: r.cusip,
      ticker: r.ticker,
      issuer_name: r.issuerName,
      share_type: r.shareType,
      shares: r.shares,
      value_usd: r.valueUsd,
      put_call: r.putCall,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      accessionNumber: str(row.accession_number),
      managerCik: str(row.manager_cik),
      managerName: str(row.manager_name),
      periodEnd: str(row.period_end),
      filedAt: str(row.filed_at),
      cusip: str(row.cusip),
      ticker: nullableStr(row.ticker),
      issuerName: str(row.issuer_name),
      shareType: row.share_type ?? null,
      shares: Number(row.shares),
      valueUsd: Number(row.value_usd),
      putCall: row.put_call ?? null,
      provenance: provFromRow(row),
    } as ThirteenfHolding;
  },
};

export const govContractAwardMapper: RowMapper<GovContractAward> = {
  toRow(r) {
    return {
      id: r.id,
      award_id: r.awardId,
      award_type: r.awardType,
      agency: r.agency,
      sub_agency: r.subAgency,
      recipient_name: r.recipient.name,
      recipient_uei: r.recipient.uei,
      recipient_tickers: toJson(r.recipient.tickers),
      amount_usd: r.amountUsd,
      action_date: r.actionDate,
      description: r.description,
      naics_code: r.naicsCode,
      naics_description: r.naicsDescription,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      awardId: nullableStr(row.award_id),
      awardType: nullableStr(row.award_type),
      agency: str(row.agency),
      subAgency: nullableStr(row.sub_agency),
      recipient: {
        name: str(row.recipient_name),
        uei: nullableStr(row.recipient_uei),
        tickers: fromJson<string[]>(row.recipient_tickers),
      },
      amountUsd: toNullableNumber(row.amount_usd),
      actionDate: str(row.action_date),
      description: nullableStr(row.description),
      naicsCode: nullableStr(row.naics_code),
      naicsDescription: nullableStr(row.naics_description),
      provenance: provFromRow(row),
    } as GovContractAward;
  },
};

export const lobbyingFilingMapper: RowMapper<LobbyingFiling> = {
  toRow(r) {
    return {
      id: r.id,
      filing_uuid: r.filingUuid,
      registrant_name: r.registrant.name,
      client_name: r.client.name,
      client_tickers: toJson(r.client.tickers),
      amount_usd: r.amountUsd,
      filing_year: r.filingYear,
      filing_period: r.filingPeriod,
      filing_type: r.filingType,
      issues: toJson(r.issues),
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      filingUuid: str(row.filing_uuid),
      registrant: { name: str(row.registrant_name) },
      client: {
        name: str(row.client_name),
        tickers: fromJson<string[]>(row.client_tickers),
      },
      amountUsd: toNullableNumber(row.amount_usd),
      filingYear: Number(row.filing_year),
      filingPeriod: str(row.filing_period),
      filingType: nullableStr(row.filing_type),
      issues: fromJson<string[]>(row.issues),
      provenance: provFromRow(row),
    } as LobbyingFiling;
  },
};

export const shortVolumeDayMapper: RowMapper<ShortVolumeDay> = {
  toRow(r) {
    return {
      id: r.id,
      date: r.date,
      ticker: r.ticker,
      market: r.market,
      short_volume: r.shortVolume,
      short_exempt_volume: r.shortExemptVolume,
      total_volume: r.totalVolume,
      short_ratio: r.shortRatio,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      date: str(row.date),
      ticker: str(row.ticker),
      market: str(row.market),
      shortVolume: Number(row.short_volume),
      shortExemptVolume: Number(row.short_exempt_volume),
      totalVolume: Number(row.total_volume),
      shortRatio: toNullableNumber(row.short_ratio),
      provenance: provFromRow(row),
    } as ShortVolumeDay;
  },
};

export const ROW_MAPPERS: Record<DatasetId, RowMapper<never>> = {
  "congress-trades": congressTradeMapper as RowMapper<never>,
  "insider-transactions": insiderTransactionMapper as RowMapper<never>,
  "thirteenf-holdings": thirteenfHoldingMapper as RowMapper<never>,
  "gov-contracts": govContractAwardMapper as RowMapper<never>,
  "lobbying-filings": lobbyingFilingMapper as RowMapper<never>,
  "short-volume": shortVolumeDayMapper as RowMapper<never>,
};

export function mapperFor<T>(id: DatasetId): RowMapper<T> {
  return ROW_MAPPERS[id] as unknown as RowMapper<T>;
}
