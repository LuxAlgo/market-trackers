/**
 * Parser for EDGAR daily "master" index files — the firehose of everything
 * filed on a given day. Format: preamble, a dashed separator, then
 * pipe-delimited rows of `CIK|Company Name|Form Type|Date Filed|Filename`.
 */

export interface DailyIndexEntry {
  cik: string;
  companyName: string;
  formType: string;
  dateFiled: string;
  /** Path under /Archives/, e.g. "edgar/data/320193/0000320193-26-000001.txt". */
  path: string;
}

export interface DailyIndexParseResult {
  entries: DailyIndexEntry[];
  /** First lines of the file — fingerprinted by canaries to catch format drift. */
  headerLines: string[];
}

/**
 * Old-era indexes (roughly pre-2011) write Date Filed as bare YYYYMMDD;
 * modern ones use YYYY-MM-DD. Everything downstream — filedAt on rows, the
 * schema's date regex, era comparisons — expects the dashed form, so the
 * index parser is the one place the era difference is erased.
 */
function normalizeIndexDate(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  return trimmed;
}

export function parseMasterIndex(text: string): DailyIndexParseResult {
  const lines = text.split(/\r?\n/);
  const entries: DailyIndexEntry[] = [];
  const headerLines: string[] = [];
  let inHeader = true;

  for (const line of lines) {
    const fields = line.split("|");
    const isDataRow = fields.length === 5 && /^\d+$/.test(fields[0]?.trim() ?? "");
    if (isDataRow) {
      inHeader = false;
      const [cik, companyName, formType, dateFiled, path] = fields as [
        string,
        string,
        string,
        string,
        string,
      ];
      entries.push({
        cik: cik.trim(),
        companyName: companyName.trim(),
        formType: formType.trim(),
        dateFiled: normalizeIndexDate(dateFiled),
        path: path.trim(),
      });
    } else if (inHeader && line.trim().length > 0) {
      headerLines.push(line.trim());
    }
  }

  return { entries, headerLines };
}

const OWNERSHIP_FORMS = new Set(["3", "4", "5", "3/A", "4/A", "5/A"]);
const THIRTEENF_FORMS = new Set(["13F-HR", "13F-HR/A"]);

export function isOwnershipForm(formType: string): boolean {
  return OWNERSHIP_FORMS.has(formType);
}

export function isThirteenfForm(formType: string): boolean {
  return THIRTEENF_FORMS.has(formType);
}
