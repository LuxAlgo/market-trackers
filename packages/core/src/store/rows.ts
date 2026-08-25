import type { DatasetId } from "../schema/datasets.js";
import type { Provenance } from "../schema/provenance.js";
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
      bill_references: toJson(r.billReferences),
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
      billReferences: fromJson<string[]>(row.bill_references),
      provenance: provFromRow(row),
    } as LobbyingFiling;
  },
};

export const wikiPageviewMapper: RowMapper<WikiPageview> = {
  toRow(r) {
    return {
      id: r.id,
      project: r.project,
      article: r.article,
      day: r.day,
      views: r.views,
      tickers: toJson(r.tickers),
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      project: str(row.project),
      article: str(row.article),
      day: str(row.day),
      views: Number(row.views),
      tickers: fromJson<string[]>(row.tickers),
      provenance: provFromRow(row),
    } as WikiPageview;
  },
};

export const billMapper: RowMapper<Bill> = {
  toRow(r) {
    return {
      id: r.id,
      congress: r.congress,
      bill_type: r.billType,
      bill_number: r.billNumber,
      title: r.title,
      introduced_date: r.introducedDate,
      latest_action_date: r.latestActionDate,
      latest_action_text: r.latestActionText,
      sponsor_bioguide_id: r.sponsorBioguideId,
      sponsor_name: r.sponsorName,
      policy_area: r.policyArea,
      cosponsor_count: r.cosponsorCount,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      congress: Number(row.congress),
      billType: str(row.bill_type),
      billNumber: Number(row.bill_number),
      title: str(row.title),
      introducedDate: str(row.introduced_date),
      latestActionDate: nullableStr(row.latest_action_date),
      latestActionText: nullableStr(row.latest_action_text),
      sponsorBioguideId: nullableStr(row.sponsor_bioguide_id),
      sponsorName: nullableStr(row.sponsor_name),
      policyArea: nullableStr(row.policy_area),
      cosponsorCount: Number(row.cosponsor_count),
      provenance: provFromRow(row),
    } as Bill;
  },
};

export const fecCandidateMapper: RowMapper<FecCandidate> = {
  toRow(r) {
    return {
      id: r.id,
      candidate_id: r.candidateId,
      cycle: r.cycle,
      name: r.name,
      party: r.party,
      office: r.office,
      state: r.state,
      district: r.district,
      incumbent_challenger: r.incumbentChallenger,
      total_receipts: r.totalReceipts,
      total_disbursements: r.totalDisbursements,
      cash_on_hand: r.cashOnHand,
      coverage_end_date: r.coverageEndDate,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      candidateId: str(row.candidate_id),
      cycle: Number(row.cycle),
      name: str(row.name),
      party: nullableStr(row.party),
      office: row.office,
      state: nullableStr(row.state),
      district: nullableStr(row.district),
      incumbentChallenger: nullableStr(row.incumbent_challenger),
      totalReceipts: toNullableNumber(row.total_receipts),
      totalDisbursements: toNullableNumber(row.total_disbursements),
      cashOnHand: toNullableNumber(row.cash_on_hand),
      coverageEndDate: nullableStr(row.coverage_end_date),
      provenance: provFromRow(row),
    } as FecCandidate;
  },
};

export const fecContributionMapper: RowMapper<FecContribution> = {
  toRow(r) {
    return {
      id: r.id,
      committee_id: r.committeeId,
      committee_name: r.committeeName,
      candidate_id: r.candidateId,
      candidate_name: r.candidateName,
      amount_usd: r.amountUsd,
      date: r.date,
      transaction_type: r.transactionType,
      cycle: r.cycle,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      committeeId: str(row.committee_id),
      committeeName: nullableStr(row.committee_name),
      candidateId: str(row.candidate_id),
      candidateName: nullableStr(row.candidate_name),
      amountUsd: Number(row.amount_usd),
      date: nullableStr(row.date),
      transactionType: str(row.transaction_type),
      cycle: Number(row.cycle),
      provenance: provFromRow(row),
    } as FecContribution;
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

export const committeeAssignmentMapper: RowMapper<CommitteeAssignment> = {
  toRow(r) {
    return {
      id: r.id,
      bioguide_id: r.bioguideId,
      member_name: r.memberName,
      chamber: r.chamber,
      committee_thomas_id: r.committee.thomasId,
      committee_name: r.committee.name,
      committee_type: r.committee.type,
      subcommittee_thomas_id: r.subcommittee?.thomasId ?? null,
      subcommittee_name: r.subcommittee?.name ?? null,
      rank: r.rank,
      title: r.title,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      bioguideId: str(row.bioguide_id),
      memberName: str(row.member_name),
      chamber: row.chamber,
      committee: {
        thomasId: str(row.committee_thomas_id),
        name: str(row.committee_name),
        type: row.committee_type,
      },
      subcommittee:
        row.subcommittee_thomas_id === null || row.subcommittee_thomas_id === undefined
          ? null
          : { thomasId: str(row.subcommittee_thomas_id), name: str(row.subcommittee_name) },
      rank: toNullableNumber(row.rank),
      title: nullableStr(row.title),
      provenance: provFromRow(row),
    } as CommitteeAssignment;
  },
};

export const patentMapper: RowMapper<Patent> = {
  toRow(r) {
    return {
      id: r.id,
      patent_id: r.patentId,
      title: r.title,
      grant_date: r.grantDate,
      assignee_name: r.assignee.name,
      assignee_tickers: toJson(r.assignee.tickers),
      assignee_count: r.assigneeCount,
      kind: r.kind,
      cpc_class: r.cpcClass,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      patentId: str(row.patent_id),
      title: str(row.title),
      grantDate: str(row.grant_date),
      assignee: {
        name: nullableStr(row.assignee_name),
        tickers: fromJson<string[]>(row.assignee_tickers),
      },
      assigneeCount: Number(row.assignee_count),
      kind: nullableStr(row.kind),
      cpcClass: nullableStr(row.cpc_class),
      provenance: provFromRow(row),
    } as Patent;
  },
};

export const clinicalTrialMapper: RowMapper<ClinicalTrial> = {
  toRow(r) {
    return {
      id: r.id,
      nct_id: r.nctId,
      title: r.title,
      sponsor_name: r.sponsor.name,
      sponsor_tickers: toJson(r.sponsor.tickers),
      phase: r.phase,
      overall_status: r.overallStatus,
      study_type: r.studyType,
      conditions: toJson(r.conditions),
      start_date: r.startDate,
      primary_completion_date: r.primaryCompletionDate,
      last_updated: r.lastUpdated,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      nctId: str(row.nct_id),
      title: str(row.title),
      sponsor: {
        name: str(row.sponsor_name),
        tickers: fromJson<string[]>(row.sponsor_tickers),
      },
      phase: nullableStr(row.phase),
      overallStatus: str(row.overall_status),
      studyType: nullableStr(row.study_type),
      conditions: fromJson<string[]>(row.conditions),
      startDate: nullableStr(row.start_date),
      primaryCompletionDate: nullableStr(row.primary_completion_date),
      lastUpdated: str(row.last_updated),
      provenance: provFromRow(row),
    } as ClinicalTrial;
  },
};

export const fdaApprovalMapper: RowMapper<FdaApproval> = {
  toRow(r) {
    return {
      id: r.id,
      application_number: r.applicationNumber,
      sponsor_name: r.sponsor.name,
      sponsor_tickers: toJson(r.sponsor.tickers),
      brand_name: r.brandName,
      submission_type: r.submissionType,
      submission_number: r.submissionNumber,
      submission_status: r.submissionStatus,
      status_date: r.statusDate,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      applicationNumber: str(row.application_number),
      sponsor: {
        name: str(row.sponsor_name),
        tickers: fromJson<string[]>(row.sponsor_tickers),
      },
      brandName: nullableStr(row.brand_name),
      submissionType: str(row.submission_type),
      submissionNumber: str(row.submission_number),
      submissionStatus: nullableStr(row.submission_status),
      statusDate: str(row.status_date),
      provenance: provFromRow(row),
    } as FdaApproval;
  },
};

export const cotReportMapper: RowMapper<CotReport> = {
  toRow(r) {
    return {
      id: r.id,
      report_date: r.reportDate,
      contract_code: r.contractCode,
      market_name: r.marketName,
      open_interest: r.openInterest,
      commercial_long: r.commercialLong,
      commercial_short: r.commercialShort,
      non_commercial_long: r.nonCommercialLong,
      non_commercial_short: r.nonCommercialShort,
      non_reportable_long: r.nonReportableLong,
      non_reportable_short: r.nonReportableShort,
      ...provToRow(r.provenance),
    };
  },
  fromRow(row) {
    return {
      id: str(row.id),
      reportDate: str(row.report_date),
      contractCode: str(row.contract_code),
      marketName: str(row.market_name),
      openInterest: Number(row.open_interest),
      commercialLong: Number(row.commercial_long),
      commercialShort: Number(row.commercial_short),
      nonCommercialLong: Number(row.non_commercial_long),
      nonCommercialShort: Number(row.non_commercial_short),
      nonReportableLong: Number(row.non_reportable_long),
      nonReportableShort: Number(row.non_reportable_short),
      provenance: provFromRow(row),
    } as CotReport;
  },
};

export const ROW_MAPPERS: Record<DatasetId, RowMapper<never>> = {
  "congress-trades": congressTradeMapper as RowMapper<never>,
  "insider-transactions": insiderTransactionMapper as RowMapper<never>,
  "thirteenf-holdings": thirteenfHoldingMapper as RowMapper<never>,
  "gov-contracts": govContractAwardMapper as RowMapper<never>,
  // Grants share the federal-award shape and therefore the mapper.
  "gov-grants": govContractAwardMapper as RowMapper<never>,
  "lobbying-filings": lobbyingFilingMapper as RowMapper<never>,
  "short-volume": shortVolumeDayMapper as RowMapper<never>,
  "committee-assignments": committeeAssignmentMapper as RowMapper<never>,
  patents: patentMapper as RowMapper<never>,
  "clinical-trials": clinicalTrialMapper as RowMapper<never>,
  "fda-approvals": fdaApprovalMapper as RowMapper<never>,
  "cot-reports": cotReportMapper as RowMapper<never>,
  "wiki-pageviews": wikiPageviewMapper as RowMapper<never>,
  bills: billMapper as RowMapper<never>,
  "fec-candidates": fecCandidateMapper as RowMapper<never>,
  "fec-contributions": fecContributionMapper as RowMapper<never>,
};

export function mapperFor<T>(id: DatasetId): RowMapper<T> {
  return ROW_MAPPERS[id] as unknown as RowMapper<T>;
}
