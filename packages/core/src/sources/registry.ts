import type { SourceId } from "../schema/provenance.js";
import type { DocketSource } from "./types.js";
import { edgarSource } from "./edgar/source.js";
import { senateEfdSource } from "./senate-efd/source.js";
import { houseClerkSource } from "./house-clerk/source.js";
import { usaspendingSource } from "./usaspending/source.js";
import { ldaSource } from "./lda/source.js";
import { finraSource } from "./finra-shortvol/source.js";

/**
 * Every source, implemented or scaffolded, in one place. Sync, canaries,
 * status, and the health board iterate this — a new source becomes fully
 * wired by implementing the contract in its own directory; nothing else
 * changes.
 */
export const ALL_SOURCES: DocketSource[] = [
  edgarSource,
  senateEfdSource,
  houseClerkSource,
  usaspendingSource,
  ldaSource,
  finraSource,
];

export function sourceById(id: string): DocketSource {
  const source = ALL_SOURCES.find((s) => s.id === id);
  if (!source) {
    throw new Error(
      `Unknown source '${id}'. Known sources: ${ALL_SOURCES.map((s) => s.id).join(", ")}`,
    );
  }
  return source;
}

export function isSourceId(id: string): id is SourceId {
  return ALL_SOURCES.some((s) => s.id === id);
}
