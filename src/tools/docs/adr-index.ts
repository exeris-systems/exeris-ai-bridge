// Pure parser for `exeris-docs/adr-index.md`. Reads the canonical pipe-table
// under the `## Index` heading and returns one entry per row. Stops at the
// next H2 heading (e.g. `## Cross-repo stubs`) — sub-headings (`### …`) and
// non-row lines (HTML comments, reference-link definitions, blank lines) are
// skipped, never used as a stop signal. The second table in the file has a
// different shape and is intentionally not surfaced through docs:*.

export interface AdrStatus {
  /** First whitespace-delimited token of the status cell. */
  readonly state: string;
  /** Full original cell content, preserving dates and notes. */
  readonly raw: string;
}

export interface AdrLink {
  /** URL-decoded display text from `[display](target)`. */
  readonly display: string;
  /** URL-decoded link target, as-written (may be relative or absolute). */
  readonly target: string;
  /**
   * Public GitHub URL pointing at the ADR on `main`. `null` for
   * enterprise-private ADRs (their repos are private; the URL would 404)
   * and for targets we cannot map to a sibling repo.
   */
  readonly github: string | null;
}

export interface AdrEntry {
  /** Integer ADR number (e.g. 1, 7, 34) — leading zeros stripped. */
  readonly number: number;
  /** Padded form as written in the index (e.g. "001", "007", "034"). */
  readonly numberPadded: string;
  readonly title: string;
  readonly owningRepo: string;
  readonly scope: string;
  /** Free-form so future visibility taxonomies don't break the parser. */
  readonly visibility: string;
  readonly status: AdrStatus;
  /** `null` for reserved entries whose link cell carries italic notes. */
  readonly link: AdrLink | null;
}

const INDEX_HEADING = /^##\s+Index\s*$/;
const TABLE_ROW = /^\|(.*)\|\s*$/;
const SEPARATOR_ROW = /^\|\s*-/;
// Only H2 ends the index table — sub-headings like `### Notes` mid-block must
// not silently truncate the registry.
const NEXT_H2_HEADING = /^##\s+/;
const PADDED_NUMBER = /^\d+$/;

const ECOSYSTEM_ORG = "exeris-systems";
const DEFAULT_BRANCH = "main";
const OWN_REPO = "exeris-docs";

interface ColumnIndex {
  readonly number: number;
  readonly title: number;
  readonly owningRepo: number;
  readonly scope: number;
  readonly visibility: number;
  readonly status: number;
  readonly link: number;
}

interface ParsedHeader {
  readonly columns: ColumnIndex;
  /**
   * Cell count of the header row. Used to validate row width: a row with
   * a different count signals either a pipe character leaked into a cell
   * (over-wide, no escape support) or a truncated row (under-wide). This
   * is computed from the header rather than hardcoded so a legitimate
   * future column addition (e.g. 'Notes') works without a code change.
   */
  readonly expectedCellCount: number;
}

export function parseAdrIndex(markdown: string): AdrEntry[] {
  const lines = markdown.split(/\r?\n/);
  const { columns, expectedCellCount, firstRowIndex } = findTableHeader(lines);

  const entries: AdrEntry[] = [];
  for (let i = firstRowIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Only H2 terminates the table. H3+ and non-row lines are skipped, never
    // used as a stop signal — protects against in-table maintainer annotations
    // (HTML comments, ref-link definitions, sub-headings) silently truncating.
    if (NEXT_H2_HEADING.test(line)) break;
    if (!TABLE_ROW.test(line)) continue;

    const entry = parseRow(line, columns, expectedCellCount);
    if (entry) entries.push(entry);
  }
  return entries;
}

function findTableHeader(
  lines: string[],
): { columns: ColumnIndex; expectedCellCount: number; firstRowIndex: number } {
  const headingIdx = lines.findIndex((line) => INDEX_HEADING.test(line));
  if (headingIdx < 0) {
    throw new Error("adr-index.md is missing the '## Index' heading");
  }

  let i = headingIdx + 1;
  // Same H2 boundary discipline as the row-loop — refuse to walk past the
  // next H2 looking for a table, otherwise an empty '## Index' section would
  // silently pick up a later section's table.
  while (i < lines.length && !TABLE_ROW.test(lines[i] ?? "")) {
    if (NEXT_H2_HEADING.test(lines[i] ?? "")) {
      throw new Error("adr-index.md '## Index' section contains no table before the next H2");
    }
    i += 1;
  }
  if (i >= lines.length) {
    throw new Error("adr-index.md '## Index' section contains no table");
  }

  // First TABLE_ROW under the heading is the header row — parse it to
  // discover column positions by name (defends against a future column
  // reorder corrupting the entries silently).
  const { columns, expectedCellCount } = parseHeaderColumns(lines[i] ?? "");
  i += 1;

  // Skip separator row if present (defensive — also tolerate index files
  // without one).
  if (i < lines.length && SEPARATOR_ROW.test(lines[i] ?? "")) {
    i += 1;
  }
  return { columns, expectedCellCount, firstRowIndex: i };
}

function parseHeaderColumns(headerLine: string): ParsedHeader {
  const cells = splitRow(headerLine);
  const lowered = cells.map((c) => c.toLowerCase());
  const find = (label: string, ...aliases: string[]): number => {
    for (const name of [label, ...aliases]) {
      const idx = lowered.indexOf(name);
      if (idx >= 0) return idx;
    }
    throw new Error(`adr-index.md header is missing the '${label}' column`);
  };
  return {
    columns: {
      number: find("#", "number", "adr"),
      title: find("title"),
      owningRepo: find("owning repo", "owning_repo", "repo"),
      scope: find("scope"),
      visibility: find("visibility"),
      status: find("status"),
      link: find("link"),
    },
    expectedCellCount: cells.length,
  };
}

function parseRow(line: string, columns: ColumnIndex, expectedCellCount: number): AdrEntry | null {
  const cells = splitRow(line);
  // Row must have the same cell count as the header. A mismatch signals
  // either a pipe character leaked into a cell (over-wide) or a truncated
  // row (under-wide) — refuse rather than emit confidently-wrong data.
  if (cells.length !== expectedCellCount) return null;

  const numberPadded = cells[columns.number];
  // Validate before parseInt — `parseInt('034 (legacy)', 10)` returns 34
  // and would otherwise emit an entry where number and numberPadded
  // disagree silently.
  if (!PADDED_NUMBER.test(numberPadded)) return null;
  const numberInt = Number.parseInt(numberPadded, 10);

  const statusRaw = cells[columns.status];
  const visibility = cells[columns.visibility];
  return {
    number: numberInt,
    numberPadded,
    title: cells[columns.title],
    owningRepo: cells[columns.owningRepo],
    scope: cells[columns.scope],
    visibility,
    status: {
      state: statusRaw.split(/\s+/)[0] ?? "",
      raw: statusRaw,
    },
    link: parseLink(cells[columns.link], visibility),
  };
}

function splitRow(line: string): string[] {
  // Strip outer pipes, split on remaining ones. Pipe-escaping (`\|`) is not
  // used in the real adr-index.md; if a future row ever needs it, this is
  // where to extend the splitter.
  const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function parseLink(cell: string, visibility: string): AdrLink | null {
  // Scan the cell for the FIRST well-formed `[display](target)` pair.
  // Bailing on a single `[note]` (no matching `(...)`) would miss a real
  // link further along in cells like `[note] see [ADR-042](adr/X.md)`.
  let cursor = 0;
  while (cursor < cell.length) {
    const openBracket = cell.indexOf("[", cursor);
    if (openBracket < 0) return null;
    const closeBracket = cell.indexOf("]", openBracket + 1);
    if (closeBracket < 0) return null;
    if (cell.charAt(closeBracket + 1) !== "(") {
      cursor = closeBracket + 1;
      continue;
    }
    const closeParen = cell.indexOf(")", closeBracket + 2);
    if (closeParen < 0) return null;

    // Trim AFTER decode — otherwise `[label](%20)` decodes to ' ' AFTER the
    // pre-trim emptiness check passes, smuggling a whitespace target past the
    // null contract. The double trim is cheap; the second one is the
    // load-bearing guard.
    const target = decodeMaybe(cell.slice(closeBracket + 2, closeParen).trim()).trim();
    // `[label]()`, `[label]( )`, `[label](%20)` all reduce to empty here.
    // The AdrLink contract is "null when no link" — honour it at the parser
    // layer rather than emit AdrLink with target='' that downstream would
    // have to special-case.
    if (target.length === 0) return null;
    return {
      display: decodeMaybe(cell.slice(openBracket + 1, closeBracket).trim()).trim(),
      target,
      github: deriveGithubUrl(target, visibility),
    };
  }
  return null;
}

/**
 * Map a registry-relative link target to a public GitHub URL.
 *
 * Inputs are filesystem paths as they appear in `adr-index.md`, anchored
 * at the index file's directory (= the `exeris-docs` checkout). Examples:
 *   - `adr/ADR-001-...md`                  → exeris-docs/blob/main/adr/...
 *   - `../exeris-kernel/docs/adr/ADR-007-...md` → exeris-kernel/blob/main/docs/adr/...
 *
 * Returns `null` for enterprise-private ADRs (private repos return 404
 * anyway) and for any target shape we can't safely map (absolute paths,
 * targets that climb above the ecosystem root, malformed strings).
 */
export function deriveGithubUrl(target: string, visibility: string): string | null {
  if (visibility === "enterprise-private") return null;
  if (target.length === 0) return null;
  if (target.startsWith("/")) return null;

  let repo: string;
  let path: string;
  if (target.startsWith("../")) {
    const rest = target.slice(3);
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 0) return null;
    repo = rest.slice(0, slashIdx);
    path = rest.slice(slashIdx + 1);
    // Defend against a second `../` segment that would climb above the ecosystem.
    if (repo.length === 0 || repo === "..") return null;
  } else {
    repo = OWN_REPO;
    path = target.startsWith("./") ? target.slice(2) : target;
  }

  if (path.length === 0) return null;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${ECOSYSTEM_ORG}/${repo}/blob/${DEFAULT_BRANCH}/${encodedPath}`;
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
