import { describe, expect, it } from "vitest";
import { ALL_DATASETS } from "../schema/datasets.js";
import { tableSpecByName } from "./table-specs.js";
import { createIndexSql, createTableSql } from "./migrate.js";
import { mapperFor } from "./rows.js";
import {
  makeBill,
  makeClinicalTrial,
  makeCommitteeAssignment,
  makeCongressTrade,
  makeCotReport,
  makeFdaApproval,
  makeFecCandidate,
  makeFecContribution,
  makeGovContractAward,
  makeInsiderTransaction,
  makeLobbyingFiling,
  makePatent,
  makeShortVolumeDay,
  makeThirteenfHolding,
  makeWikiPageview,
} from "../test-helpers.js";
import type { DatasetId } from "../schema/datasets.js";

/**
 * The drift police: zod schema (source of truth) → row mapper → table spec →
 * generated DDL must all describe the same columns, for both dialects. If a
 * field is added anywhere without the rest following, this fails.
 */

const SAMPLES: Record<DatasetId, () => unknown> = {
  "congress-trades": makeCongressTrade,
  "insider-transactions": makeInsiderTransaction,
  "thirteenf-holdings": makeThirteenfHolding,
  "gov-contracts": makeGovContractAward,
  "gov-grants": makeGovContractAward,
  "lobbying-filings": makeLobbyingFiling,
  "short-volume": makeShortVolumeDay,
  "committee-assignments": makeCommitteeAssignment,
  patents: makePatent,
  "clinical-trials": makeClinicalTrial,
  "fda-approvals": makeFdaApproval,
  "cot-reports": makeCotReport,
  "wiki-pageviews": makeWikiPageview,
  bills: makeBill,
  "fec-candidates": makeFecCandidate,
  "fec-contributions": makeFecContribution,
};

describe("schema ↔ mapper ↔ table-spec parity", () => {
  for (const dataset of ALL_DATASETS) {
    it(`${dataset.id}: mapper row keys exactly match table columns`, () => {
      const record = dataset.schema.parse(SAMPLES[dataset.id]());
      const row = mapperFor(dataset.id).toRow(record as never);
      const spec = tableSpecByName(dataset.table);
      const specColumns = new Set(spec.columns.map((c) => c.name));
      const rowColumns = new Set(Object.keys(row));
      expect([...rowColumns].sort()).toEqual([...specColumns].sort());
    });

    it(`${dataset.id}: round-trips through the mapper unchanged`, () => {
      const record = dataset.schema.parse(SAMPLES[dataset.id]());
      const mapper = mapperFor(dataset.id);
      const roundTripped = dataset.schema.parse(mapper.fromRow(mapper.toRow(record as never)));
      expect(roundTripped).toEqual(record);
    });

    it(`${dataset.id}: generated DDL names every column in both dialects`, () => {
      const spec = tableSpecByName(dataset.table);
      for (const dialect of ["sqlite", "postgres"] as const) {
        const ddl = createTableSql(spec, dialect);
        for (const column of spec.columns) {
          expect(ddl).toContain(`"${column.name}"`);
        }
        expect(ddl).toContain("PRIMARY KEY");
      }
      // Index DDL references only real columns.
      for (const statement of createIndexSql(spec)) {
        expect(statement).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
      }
    });
  }
});
