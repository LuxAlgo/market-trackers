import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRecipientIndex,
  recipientTickerIndex,
  recipientTickerMapSchema,
  resolveEntityTickers,
  resolveWithIndex,
  type RecipientTickerMap,
} from "./recipients.js";
import { normalizeEntityName } from "./normalize.js";

const testMap: RecipientTickerMap = {
  version: 1,
  entries: [
    { tickers: ["LMT"], names: ["LOCKHEED MARTIN", "SIKORSKY AIRCRAFT"], uei: ["UEILMT0000001"] },
    { tickers: ["AAA"], names: ["ACME AEROSPACE"], uei: [] },
    { tickers: ["BBB"], names: ["ACME AEROSPACE SYSTEMS"], uei: [] },
    { tickers: ["CCC"], names: ["ZEPHYRCO"], uei: [] },
  ],
};

describe("resolveWithIndex", () => {
  const index = buildRecipientIndex(testMap);

  it("matches an exact UEI before anything else", () => {
    expect(resolveWithIndex(index, { name: "TOTALLY UNRELATED", uei: "ueilmt0000001" })).toEqual([
      "LMT",
    ]);
  });

  it("matches an exact normalized name", () => {
    expect(resolveWithIndex(index, { name: "Lockheed Martin Corporation" })).toEqual(["LMT"]);
    expect(resolveWithIndex(index, { name: "SIKORSKY AIRCRAFT CORP", uei: null })).toEqual(["LMT"]);
  });

  it("prefix-matches only at a word boundary", () => {
    expect(resolveWithIndex(index, { name: "LOCKHEED MARTIN AERONAUTICS COMPANY" })).toEqual([
      "LMT",
    ]);
    expect(resolveWithIndex(index, { name: "LOCKHEED MARTINI BAR LLC" })).toEqual([]);
  });

  it("single-token names are exact-match only, never prefixes", () => {
    // Exact (post-suffix-strip) still resolves…
    expect(resolveWithIndex(index, { name: "Zephyrco, Inc." })).toEqual(["CCC"]);
    // …but a one-word brand never claims longer unrelated names.
    expect(resolveWithIndex(index, { name: "ZEPHYRCO INDUSTRIAL HOLDINGS LLC" })).toEqual([]);
  });

  it("returns [] when a prefix matches more than one entry (ambiguity)", () => {
    // "ACME AEROSPACE SYSTEMS INTERNATIONAL" prefixes both the AAA and BBB entries.
    expect(resolveWithIndex(index, { name: "ACME AEROSPACE SYSTEMS INTERNATIONAL INC" })).toEqual(
      [],
    );
    // The exact forms still resolve unambiguously.
    expect(resolveWithIndex(index, { name: "ACME AEROSPACE, INC." })).toEqual(["AAA"]);
    expect(resolveWithIndex(index, { name: "ACME AEROSPACE SYSTEMS, INC." })).toEqual(["BBB"]);
  });

  it("returns [] for unknown, empty, and null inputs", () => {
    expect(resolveWithIndex(index, { name: "CASCADIA FIELD SERVICES LLC" })).toEqual([]);
    expect(resolveWithIndex(index, { name: "   " })).toEqual([]);
    expect(resolveWithIndex(index, { name: null, uei: null })).toEqual([]);
    expect(resolveWithIndex(index, {})).toEqual([]);
  });

  it("an unknown UEI falls through to name matching", () => {
    expect(resolveWithIndex(index, { name: "LOCKHEED MARTIN", uei: "UEIUNKNOWN001" })).toEqual([
      "LMT",
    ]);
  });
});

describe("buildRecipientIndex", () => {
  it("rejects the same name claimed by two entries", () => {
    expect(() =>
      buildRecipientIndex({
        version: 1,
        entries: [
          { tickers: ["AAA"], names: ["ACME"], uei: [] },
          { tickers: ["BBB"], names: ["ACME"], uei: [] },
        ],
      }),
    ).toThrow(/duplicate name/);
  });

  it("rejects the same UEI claimed by two entries", () => {
    expect(() =>
      buildRecipientIndex({
        version: 1,
        entries: [
          { tickers: ["AAA"], names: ["ACME"], uei: ["UEIDUP0000001"] },
          { tickers: ["BBB"], names: ["ZENITH"], uei: ["UEIDUP0000001"] },
        ],
      }),
    ).toThrow(/duplicate UEI/);
  });
});

describe("the shipped recipient-tickers map", () => {
  it("validates, indexes, and stays conservatively sized", () => {
    const index = recipientTickerIndex();
    expect(index.byName.size).toBeGreaterThanOrEqual(40);
  });

  it("stores every name pre-normalized (normalizeEntityName fixed point)", () => {
    const map = recipientTickerMapSchema.parse(
      JSON.parse(
        readFileSync(new URL("../../data/recipient-tickers.json", import.meta.url), "utf8"),
      ),
    );
    expect(map.version).toBe(1);
    expect(map.entries.length).toBeGreaterThanOrEqual(40);
    for (const entry of map.entries) {
      for (const name of entry.names) {
        expect(normalizeEntityName(name)).toBe(name);
      }
    }
  });

  it("resolves the well-known primes and leaves the rest alone", () => {
    expect(resolveEntityTickers({ name: "LOCKHEED MARTIN CORPORATION" })).toEqual(["LMT"]);
    expect(resolveEntityTickers({ name: "Booz Allen & Hamilton, Inc." })).toEqual(["BAH"]);
    expect(resolveEntityTickers({ name: "PRATT & WHITNEY MILITARY ENGINES" })).toEqual(["RTX"]);
    expect(resolveEntityTickers({ name: "Oracle America, Inc." })).toEqual(["ORCL"]);
    expect(resolveEntityTickers({ name: "AT&T Services, Inc." })).toEqual(["T"]);
    expect(resolveEntityTickers({ name: "AMAZON.COM SERVICES LLC" })).toEqual(["AMZN"]);
    // No bare-surname or lookalike leakage.
    expect(resolveEntityTickers({ name: "HARRIS COUNTY TOLL ROAD AUTHORITY" })).toEqual([]);
    expect(resolveEntityTickers({ name: "GE HEALTHCARE TECHNOLOGIES INC" })).toEqual([]);
    // Single-token brand names never prefix-claim longer unrelated entities.
    expect(resolveEntityTickers({ name: "APPLE VALLEY SCHOOL DISTRICT" })).toEqual([]);
    expect(resolveEntityTickers({ name: "EXXON NEWFOUNDLAND DRILLING PARTNERS" })).toEqual([]);
    // The curated multi-word subsidiary form is how brands extend instead.
    expect(resolveEntityTickers({ name: "Oracle America, Inc." })).toEqual(["ORCL"]);
  });

  it("resolves pharma/tech names only through their scoped forms (collision guards)", () => {
    expect(resolveEntityTickers({ name: "Eli Lilly and Company" })).toEqual(["LLY"]);
    expect(resolveEntityTickers({ name: "NOVARTIS PHARMACEUTICALS CORPORATION" })).toEqual(["NVS"]);
    expect(resolveEntityTickers({ name: "MERCK SHARP & DOHME LLC" })).toEqual(["MRK"]);
    expect(resolveEntityTickers({ name: "Merck & Co., Inc." })).toEqual(["MRK"]);
    expect(resolveEntityTickers({ name: "QUALCOMM Incorporated" })).toEqual(["QCOM"]);
    expect(resolveEntityTickers({ name: "REGENERON PHARMACEUTICALS, INC." })).toEqual(["REGN"]);
    expect(resolveEntityTickers({ name: "HEWLETT PACKARD ENTERPRISE COMPANY" })).toEqual(["HPE"]);
    // Deliberate misses: lookalikes that must never leak onto the US ticker.
    // The German Merck KGaA is unrelated to NYSE:MRK; the map ships only the
    // scoped "MERCK SHARP AND DOHME" / "MERCK AND" forms, never bare "MERCK".
    expect(resolveEntityTickers({ name: "MERCK KGAA" })).toEqual([]);
    // No bare "HP"/"HEWLETT PACKARD" either — it would prefix-collide with
    // Hewlett Packard Enterprise, a different listed company since the split.
    expect(resolveEntityTickers({ name: "HP INC" })).toEqual([]);
    expect(resolveEntityTickers({ name: "HEWLETT PACKARD" })).toEqual([]);
  });
});
