// Pure parser for `exeris-docs/adr-index.md`. Reads the canonical pipe-table
// under the `## Index` heading and returns one entry per row. Stops at the
// next heading (e.g. `## Cross-repo stubs`) — the second table in that file
// has a different shape and is intentionally not surfaced through docs:*.

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
const NEXT_HEADING = /^#{1,6}\s+/;

export function parseAdrIndex(markdown: string): AdrEntry[] {
  const lines = markdown.split(/\r?\n/);

  const headingIdx = lines.findIndex((line) => INDEX_HEADING.test(line));
  if (headingIdx < 0) {
    throw new Error("adr-index.md is missing the '## Index' heading");
  }

  let i = headingIdx + 1;
  while (i < lines.length && !TABLE_ROW.test(lines[i] ?? "")) {
    i += 1;
  }
  if (i >= lines.length) {
    throw new Error("adr-index.md '## Index' section contains no table");
  }

  // Skip header row.
  i += 1;
  // Skip separator row (defensive — also tolerate index files without one).
  if (i < lines.length && SEPARATOR_ROW.test(lines[i] ?? "")) {
    i += 1;
  }

  const entries: AdrEntry[] = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (NEXT_HEADING.test(line)) break;
    if (line.trim() === "") continue;
    if (!TABLE_ROW.test(line)) break;

    const cells = splitRow(line);
    if (cells.length < 7) continue;

    const numberPadded = cells[0];
    const numberInt = Number.parseInt(numberPadded, 10);
    if (!Number.isFinite(numberInt)) continue;

    const statusRaw = cells[5];
    const linkCell = cells[6];

    entries.push({
      number: numberInt,
      numberPadded,
      title: cells[1],
      owningRepo: cells[2],
      scope: cells[3],
      visibility: cells[4],
      status: {
        state: statusRaw.split(/\s+/)[0] ?? "",
        raw: statusRaw,
      },
      link: parseLink(linkCell),
    });
  }

  return entries;
}

function splitRow(line: string): string[] {
  // Strip outer pipes, split on remaining ones. Pipe-escaping (`\|`) is not
  // used in the real adr-index.md; if a future row ever needs it, this is
  // where to extend the splitter.
  const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function parseLink(cell: string): AdrLink | null {
  // Locate the FIRST markdown link `[display](target)` via indexOf rather
  // than a regex — guarantees O(n) traversal and side-steps Sonar's S5852
  // false-positive on `[^\]]+...[^)]+` (negated classes don't actually
  // backtrack catastrophically, but the static analyser flags them).
  // Cells like the cross-repo-stub table contain multiple links — that
  // table is filtered out at the heading boundary, but we stay defensive.
  const openBracket = cell.indexOf("[");
  if (openBracket < 0) return null;
  const closeBracket = cell.indexOf("]", openBracket + 1);
  if (closeBracket < 0) return null;
  if (cell.charAt(closeBracket + 1) !== "(") return null;
  const closeParen = cell.indexOf(")", closeBracket + 2);
  if (closeParen < 0) return null;

  return {
    display: decodeMaybe(cell.slice(openBracket + 1, closeBracket).trim()),
    target: decodeMaybe(cell.slice(closeBracket + 2, closeParen).trim()),
  };
}

function decodeMaybe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
