import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";

import { isInsideRealRoot, resolveInside } from "../../../fs/sandbox.js";
import { checkFilesSize, DEFAULT_MAX_FILES_BYTES, type PreviewLimit } from "./runner.js";

// Compares what a generator run produced with the project's L1 tree — the
// committed generated sources — so an agent sees what a build WOULD change.
// Everything here only reads; the produced files live in the scratch directory
// and the L1 tree is the project's, read through the sandbox.

/** Where the Java generator's output is committed (L1), relative to the project root. */
export const JAVA_L1_ROOT = join("src", "main", "generated", "java");

/**
 * Default output root of `exeris-gen generate` (`outputPath` in
 * `exeris-codegen-ts/src/config.ts`), relative to the project root. A project
 * that sets `outputPath` in its codegen config generates elsewhere, so
 * typescriptL1Root() reads that key first.
 */
export const TYPESCRIPT_L1_ROOT = join("src", "app", "generated");

/**
 * The config file names `exeris-gen` looks for, in its own order
 * (`CONFIG_FILE_NAMES` in `exeris-codegen-ts/src/config.ts`).
 */
export const TYPESCRIPT_CONFIG_FILE_NAMES: readonly string[] = [
  "exeris-codegen.json",
  "exeris-codegen.config.json",
  ".exerisrc.json",
];

const MAX_CODEGEN_CONFIG_BYTES = 256 * 1024;

/** Most files listed under one tree; a tree with more is reported as a `files` limit. */
export const MAX_LISTED_ENTRIES = 5_000;
/** Deepest directory nesting listed under one tree. */
export const MAX_LIST_DEPTH = 32;

/** Diff budget per file: the patch is computed on the main thread, so it is bounded. */
const DIFF_TIMEOUT_MS = 2_000;
const DIFF_MAX_EDIT_LENGTH = 20_000;

export type FileStatus = "added" | "changed" | "unchanged";

export interface FileDiff {
  /** Path relative to the output root, with `/` separators. */
  readonly path: string;
  readonly status: FileStatus;
  /** Unified diff against the L1 file; empty for an unchanged file or when the diff was omitted. */
  readonly diff: string;
  /** Set when the file changed but computing its diff exceeded the diff budget. */
  readonly diffOmitted?: "too_large";
}

export interface DiffReport {
  /** Every produced file, sorted by path. */
  readonly files: readonly FileDiff[];
  /** Files present in the L1 tree that the run no longer produces, sorted. */
  readonly removed: readonly string[];
  /** Set when the L1 tree is larger than the listing caps; `removed` is then incomplete. */
  readonly limit: PreviewLimit | null;
}

export interface ProducedFiles {
  /** Relative `/`-separated path -> content. Empty when `limit` is set. */
  readonly files: ReadonlyMap<string, string>;
  readonly totalBytes: number;
  /** Set when the produced files exceed a size or listing cap; nothing is read in that case. */
  readonly limit: PreviewLimit | null;
}

/** The Java L1 root for a project. */
export function javaL1Root(projectRoot: string): string {
  return join(projectRoot, JAVA_L1_ROOT);
}

/**
 * The TypeScript L1 root for a project: `outputPath` from the first codegen
 * config file found, else the generator's default.
 *
 * The lookup mirrors the generator's own: each config file name in order, in
 * `startDir` and then each parent directory — but never above `projectRoot`,
 * since a file outside the project is not the project's configuration. A
 * configured root that does not exist yet, or leaves the project, has no L1
 * tree to compare and falls back to the default.
 */
export function typescriptL1Root(projectRoot: string, startDir: string = projectRoot): string {
  const configured = readConfiguredOutputPath(projectRoot, startDir);
  if (configured !== null) {
    try {
      return resolveInside(projectRoot, join(projectRoot, configured));
    } catch {
      // Falls through to the default.
    }
  }
  return join(projectRoot, TYPESCRIPT_L1_ROOT);
}

function readConfiguredOutputPath(projectRoot: string, startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (!isInsideRealRoot(resolve(projectRoot), dir)) return null;
    for (const name of TYPESCRIPT_CONFIG_FILE_NAMES) {
      const outputPath = outputPathFrom(projectRoot, join(dir, name));
      if (outputPath !== undefined) return outputPath;
    }
    if (dir === resolve(projectRoot)) return null;
    dir = dirname(dir);
  }
}

/** `undefined` when the file is absent or unreadable (keep looking); `null` when it exists but sets no outputPath. */
function outputPathFrom(projectRoot: string, file: string): string | null | undefined {
  try {
    const path = resolveInside(projectRoot, file);
    if (lstatSync(path).size > MAX_CODEGEN_CONFIG_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { outputPath?: unknown };
    return typeof parsed.outputPath === "string" && parsed.outputPath.length > 0 ? parsed.outputPath : null;
  } catch {
    return undefined;
  }
}

/**
 * Read every regular file under `dir`. The total size is summed from file
 * metadata first and checked against the cap, so an oversized run is refused
 * before its content is read into memory. Symlinks are skipped: a generator is
 * not trusted to place a link that points at something else.
 */
export function collectProduced(dir: string, maxBytes: number = DEFAULT_MAX_FILES_BYTES): ProducedFiles {
  const listing = listFiles(dir);
  if (listing.limit !== null) return { files: new Map(), totalBytes: 0, limit: listing.limit };
  const totalBytes = listing.files.reduce((sum, e) => sum + e.size, 0);
  const limit = checkFilesSize(totalBytes, maxBytes);
  if (limit !== null) return { files: new Map(), totalBytes, limit };
  const files = new Map<string, string>();
  for (const entry of listing.files) {
    files.set(entry.relative, readFileSync(entry.absolute, "utf8"));
  }
  return { files, totalBytes, limit: null };
}

/**
 * Diff each produced file against the same relative path under `l1Root`.
 *
 * `l1Root` is read only if it resolves inside `projectRoot`; a link that leaves
 * the project makes the L1 tree read as empty rather than read what it points at.
 */
export function diffAgainstL1(
  produced: ReadonlyMap<string, string>,
  projectRoot: string,
  l1Root: string,
): DiffReport {
  const confined = confinedL1Root(projectRoot, l1Root);
  const listing = confined === null ? { files: [], limit: null } : listFiles(confined);
  const existing = new Map<string, string>();
  for (const entry of listing.files) existing.set(entry.relative, entry.absolute);

  const files: FileDiff[] = [];
  for (const [path, content] of [...produced].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    files.push(diffOne(path, content, existing.get(path)));
  }
  const removed = [...existing.keys()].filter((p) => !produced.has(p)).sort((a, b) => a.localeCompare(b, "en"));
  return { files, removed, limit: listing.limit };
}

function diffOne(path: string, content: string, l1Path: string | undefined): FileDiff {
  if (l1Path === undefined) {
    return { path, status: "added", ...patchOrOmitted("/dev/null", `b/${path}`, "", content) };
  }
  const before = readFileSync(l1Path, "utf8");
  if (before === content) return { path, status: "unchanged", diff: "" };
  return { path, status: "changed", ...patchOrOmitted(`a/${path}`, `b/${path}`, before, content) };
}

function confinedL1Root(projectRoot: string, l1Root: string): string | null {
  try {
    return resolveInside(projectRoot, l1Root);
  } catch {
    return null;
  }
}

/** The unified diff, or an empty diff marked `too_large` when jsdiff gave up within its budget. */
function patchOrOmitted(
  oldName: string,
  newName: string,
  before: string,
  after: string,
): { diff: string; diffOmitted?: "too_large" } {
  const patch = createTwoFilesPatch(oldName, newName, before, after, undefined, undefined, {
    context: 3,
    timeout: DIFF_TIMEOUT_MS,
    maxEditLength: DIFF_MAX_EDIT_LENGTH,
  });
  return patch === undefined ? { diff: "", diffOmitted: "too_large" } : { diff: patch };
}

export interface ListedFile {
  readonly relative: string;
  readonly absolute: string;
  readonly size: number;
}

export interface Listing {
  readonly files: ListedFile[];
  readonly limit: PreviewLimit | null;
}

/**
 * Regular files under `root`, depth-first. A missing root is an empty tree. A
 * tree beyond the entry or depth cap stops the walk and reports a `files` limit.
 */
export function listFiles(root: string): Listing {
  const out: ListedFile[] = [];
  let limit: PreviewLimit | null = null;
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (limit !== null) return;
    if (depth > MAX_LIST_DEPTH) {
      limit = listingLimit(MAX_LIST_DEPTH, "levels", "directory nesting");
      return;
    }
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative, depth + 1);
      } else if (entry.isFile()) {
        if (out.length >= MAX_LISTED_ENTRIES) {
          limit = listingLimit(MAX_LISTED_ENTRIES, "entries", "file count");
          return;
        }
        out.push({ relative, absolute, size: lstatSync(absolute).size });
      }
      if (limit !== null) return;
    }
  };
  walk(root, "", 0);
  return { files: out, limit };
}

function listingLimit(value: number, unit: "entries" | "levels", what: string): PreviewLimit {
  return {
    name: "files",
    value,
    unit,
    message: `The tree exceeds the ${value}-${unit === "entries" ? "entry" : "level"} cap on ${what}.`,
  };
}
