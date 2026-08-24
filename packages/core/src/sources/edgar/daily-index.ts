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
        dateFiled: dateFiled.trim(),
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
