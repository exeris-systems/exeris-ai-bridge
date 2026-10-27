import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";

import { resolveInside } from "../../../fs/sandbox.js";
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
 * that sets `outputPath` in `exeris-codegen.json` generates elsewhere, so
 * typescriptL1Root() reads that key first.
 */
export const TYPESCRIPT_L1_ROOT = join("src", "app", "generated");

const MAX_CODEGEN_CONFIG_BYTES = 256 * 1024;

export type FileStatus = "added" | "changed" | "unchanged";

export interface FileDiff {
  /** Path relative to the output root, with `/` separators. */
  readonly path: string;
  readonly status: FileStatus;
  /** Unified diff against the L1 file; empty for an unchanged file. */
  readonly diff: string;
}

export interface DiffReport {
  /** Every produced file, sorted by path. */
  readonly files: readonly FileDiff[];
  /** Files present in the L1 tree that the run no longer produces, sorted. */
  readonly removed: readonly string[];
}

export interface ProducedFiles {
  /** Relative `/`-separated path -> content. Empty when `limit` is set. */
  readonly files: ReadonlyMap<string, string>;
  readonly totalBytes: number;
  /** Set when the produced files exceed the size cap; nothing is read in that case. */
  readonly limit: PreviewLimit | null;
}

/** The Java L1 root for a project. */
export function javaL1Root(projectRoot: string): string {
  return join(projectRoot, JAVA_L1_ROOT);
}

/**
 * The TypeScript L1 root for a project: `outputPath` from its
 * `exeris-codegen.json` when that names a path inside the project, else the
 * generator's default.
 */
export function typescriptL1Root(projectRoot: string): string {
  const configured = readConfiguredOutputPath(projectRoot);
  if (configured !== null) {
    try {
      return resolveInside(projectRoot, join(projectRoot, configured));
    } catch {
      // A configured root that does not exist yet, or leaves the project, has no L1 tree to compare.
    }
  }
  return join(projectRoot, TYPESCRIPT_L1_ROOT);
}

function readConfiguredOutputPath(projectRoot: string): string | null {
  try {
    const path = resolveInside(projectRoot, join(projectRoot, "exeris-codegen.json"));
    if (lstatSync(path).size > MAX_CODEGEN_CONFIG_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { outputPath?: unknown };
    return typeof parsed.outputPath === "string" && parsed.outputPath.length > 0 ? parsed.outputPath : null;
  } catch {
    return null;
  }
}

/**
 * Read every regular file under `dir`. The total size is summed from file
 * metadata first and checked against the cap, so an oversized run is refused
 * before its content is read into memory. Symlinks are skipped: a generator is
 * not trusted to place a link that points at something else.
 */
export function collectProduced(dir: string, maxBytes: number = DEFAULT_MAX_FILES_BYTES): ProducedFiles {
  const entries = listFiles(dir);
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const limit = checkFilesSize(totalBytes, maxBytes);
  if (limit !== null) return { files: new Map(), totalBytes, limit };
  const files = new Map<string, string>();
  for (const entry of entries) {
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
  const existing = new Map<string, string>();
  const confined = confinedL1Root(projectRoot, l1Root);
  for (const entry of confined === null ? [] : listFiles(confined)) existing.set(entry.relative, entry.absolute);

  const files: FileDiff[] = [];
  for (const [path, content] of [...produced].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const l1Path = existing.get(path);
    if (l1Path === undefined) {
      files.push({ path, status: "added", diff: patch("/dev/null", `b/${path}`, "", content) });
      continue;
    }
    const before = readFileSync(l1Path, "utf8");
    if (before === content) {
      files.push({ path, status: "unchanged", diff: "" });
    } else {
      files.push({ path, status: "changed", diff: patch(`a/${path}`, `b/${path}`, before, content) });
    }
  }
  const removed = [...existing.keys()].filter((p) => !produced.has(p)).sort();
  return { files, removed };
}

function confinedL1Root(projectRoot: string, l1Root: string): string | null {
  try {
    return resolveInside(projectRoot, l1Root);
  } catch {
    return null;
  }
}

function patch(oldName: string, newName: string, before: string, after: string): string {
  return createTwoFilesPatch(oldName, newName, before, after, undefined, undefined, { context: 3 });
}

interface ListedFile {
  readonly relative: string;
  readonly absolute: string;
  readonly size: number;
}

/** Regular files under `root`, depth-first. A missing root is an empty tree. */
function listFiles(root: string): ListedFile[] {
  const out: ListedFile[] = [];
  const walk = (dir: string, prefix: string): void => {
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
        walk(absolute, relative);
      } else if (entry.isFile()) {
        out.push({ relative, absolute, size: lstatSync(absolute).size });
      }
    }
  };
  walk(root, "");
  return out;
}
