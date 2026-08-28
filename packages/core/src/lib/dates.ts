/** Date helpers. Everything is UTC; dates are plain YYYY-MM-DD strings. */

export function isoNow(): string {
  return new Date().toISOString();
}

export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayUtc(): string {
  return toDateString(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

/** Inclusive list of YYYY-MM-DD strings from `from` to `to`. */
export function eachDayInclusive(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** "2026-08-24" → "20260824" */
export function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

/** "20260824" → "2026-08-24" (returns null if not an 8-digit date) */
export function expandCompactDate(compact: string): string | null {
  if (!/^\d{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/** Calendar quarter (1–4) a date falls in. */
export function quarterOf(date: string): number {
  const month = Number(date.slice(5, 7));
  return Math.floor((month - 1) / 3) + 1;
}

export function hoursSince(iso: string, now: Date = new Date()): number {
  return (now.getTime() - new Date(iso).getTime()) / 36e5;
}
