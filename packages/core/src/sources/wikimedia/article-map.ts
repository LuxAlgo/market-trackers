import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The curated article↔ticker allowlist (`data/wiki-articles.json`):
 * large-cap US-listed companies whose Wikipedia article unambiguously
 * identifies the company. This is a hand-curated map, never a fuzzy
 * name match — every entry names the exact canonical URL-form article
 * title (spaces as underscores, no whitespace) and the ticker(s) it maps
 * to. A short, deliberately common name (e.g. "Apple", "Amazon", "Ford")
 * is never used bare when it collides with another Wikipedia topic; the
 * disambiguated form is used instead ("Apple_Inc.", "Amazon_(company)",
 * "Ford_Motor_Company").
 *
 * Every field is validated at load time; a map that fails any of these
 * invariants refuses to load rather than silently walking nonsense.
 */

/** Real US equity tickers start with a letter; dotted/hyphenated share classes (e.g. "BRK.B") are valid. */
const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]*$/;

export const wikiArticleEntrySchema = z.object({
  /** Wikimedia project, e.g. "en.wikipedia". */
  project: z.string().min(1),
  /** Canonical URL-form article title (underscores for spaces); never bare-ambiguous. */
  article: z
    .string()
    .min(1)
    .refine((v) => !/\s/.test(v), { message: "article title must not contain whitespace" }),
  tickers: z
    .array(z.string().regex(TICKER_PATTERN, "ticker must be uppercase (e.g. 'NVDA', 'BRK.B')"))
    .min(1),
});

export const wikiArticleMapSchema = z
  .object({
    version: z.number().int().positive(),
    entries: z.array(wikiArticleEntrySchema),
  })
  .superRefine((map, ctx) => {
    const seen = new Set<string>();
    map.entries.forEach((entry, index) => {
      const key = `${entry.project}:${entry.article}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate (project, article) entry: '${key}'`,
          path: ["entries", index],
        });
      }
      seen.add(key);
    });
  });

export type WikiArticleEntry = z.infer<typeof wikiArticleEntrySchema>;
export type WikiArticleMap = z.infer<typeof wikiArticleMapSchema>;

/** Parses and validates an arbitrary candidate map — the testable core. */
export function parseWikiArticleMap(raw: unknown): WikiArticleMap {
  return wikiArticleMapSchema.parse(raw);
}

let cached: WikiArticleMap | null = null;

/**
 * The shipped map, loaded and validated once per process. The JSON lives at
 * the package root (`data/`), one level above both `src/` and `dist/`, so
 * the relative URL resolves identically from source and compiled output
 * (mirrors `resolve/recipients.ts`'s loading of `data/recipient-tickers.json`).
 */
export function wikiArticleMap(): WikiArticleMap {
  if (cached === null) {
    const raw = readFileSync(new URL("../../../data/wiki-articles.json", import.meta.url), "utf8");
    cached = parseWikiArticleMap(JSON.parse(raw));
  }
  return cached;
}
