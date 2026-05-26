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
const NEXT_HEADING = /^#{1,6}\s+/;

const ECOSYSTEM_ORG = "exeris-systems";
const DEFAULT_BRANCH = "main";
const OWN_REPO = "exeris-docs";

export function parseAdrIndex(markdown: string): AdrEntry[] {
  const lines = markdown.split(/\r?\n/);
  let i = findFirstRowIndex(lines);

  const entries: AdrEntry[] = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (NEXT_HEADING.test(line)) break;
    if (line.trim() === "") continue;
    if (!TABLE_ROW.test(line)) break;

    const entry = parseRow(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

function findFirstRowIndex(lines: string[]): number {
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
  return i;
}

function parseRow(line: string): AdrEntry | null {
  const cells = splitRow(line);
  if (cells.length < 7) return null;

  const numberPadded = cells[0];
  const numberInt = Number.parseInt(numberPadded, 10);
  if (!Number.isFinite(numberInt)) return null;

  const statusRaw = cells[5];
  const visibility = cells[4];
  return {
    number: numberInt,
    numberPadded,
    title: cells[1],
    owningRepo: cells[2],
    scope: cells[3],
    visibility,
    status: {
      state: statusRaw.split(/\s+/)[0] ?? "",
      raw: statusRaw,
    },
    link: parseLink(cells[6], visibility),
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

  const target = decodeMaybe(cell.slice(closeBracket + 2, closeParen).trim());
  return {
    display: decodeMaybe(cell.slice(openBracket + 1, closeBracket).trim()),
    target,
    github: deriveGithubUrl(target, visibility),
  };
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
