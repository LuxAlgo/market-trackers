/**
 * Value normalizers shared by the candidate and contribution row parsers.
 * Every parser here is strict on its own terms: blank or garbage input
 * degrades to `null` only where the target field is nullable, and a
 * required field's blank/garbage input is left to the caller to reject
 * (these helpers report failure by returning `null` or, for
 * {@link parseFecAmount}, by throwing — never by fabricating a placeholder
 * value like `0` or today's date).
 */

/** MM/DD/YYYY (weball's `CVG_END_DT`) → YYYY-MM-DD; blank or garbage → null. */
export function parseFecSlashDate(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = match[3] as string;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** MMDDYYYY (pas2's `TRANSACTION_DT`) → YYYY-MM-DD; blank or garbage → null. */
export function parseFecCompactDate(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d{8}$/.test(trimmed)) return null;
  const month = Number(trimmed.slice(0, 2));
  const day = Number(trimmed.slice(2, 4));
  const year = trimmed.slice(4, 8);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Strict numeric parse for a *nullable* field (the candidate summary
 * totals): blank or non-numeric → `null`. Applies equally to a genuinely
 * blank value and to garbage like `"N/A"` — both mean "the FEC didn't give
 * us a usable number here," not "zero."
 */
export function parseFecNullableNumber(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Strict numeric parse for a *required* field (`TRANSACTION_AMT`): throws
 * on blank or non-numeric input rather than returning `null`, since
 * `FecContribution.amountUsd` is not nullable — a bad amount fails the
 * whole row instead of shipping a fabricated one. The sign is preserved
 * exactly as filed: a refund's negative amount stays negative.
 */
export function parseFecAmount(raw: string | undefined, field: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) throw new Error(`${field}: missing`);
  const value = Number(trimmed);
  if (!Number.isFinite(value)) throw new Error(`${field}: unparseable value '${raw}'`);
  return value;
}

/**
 * The office a candidate sought, from the first character of their FEC
 * candidate id — H(ouse), S(enate), or P(resident). Any other first
 * character (or an empty id) is not a recognized office and returns
 * `null`; callers must treat that as a parse failure for the whole row
 * rather than guessing.
 */
export function officeFromCandidateId(candidateId: string): "H" | "S" | "P" | null {
  const letter = candidateId.charAt(0);
  return letter === "H" || letter === "S" || letter === "P" ? letter : null;
}
