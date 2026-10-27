import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isInsideRealRoot } from "../../../fs/sandbox.js";
import { trackDirectory, untrackDirectory } from "./cleanup.js";

// The one directory the bridge writes (ADR-025, `build:*` preview amendment).
//
// This is the inverse of resolveInside(): that function proves a path is INSIDE
// a root before the bridge reads it; this one proves the scratch directory is
// OUTSIDE every root the bridge is pinned to before the bridge lets a child
// write there. The generator is handed this directory as its working area, so a
// scratch directory that resolved into the user's project would turn a preview
// into a write.

/** Thrown when no scratch directory can be created outside the protected roots. */
export class WorkdirRefusedError extends Error {
  constructor(message: string) {
    // No absolute paths in the message — it can reach an agent verbatim.
    super(message);
    this.name = "WorkdirRefusedError";
  }
}

export interface WorkdirOptions {
  /** Roots the scratch directory must not resolve into: the project root and the ecosystem root. */
  readonly protectedRoots: readonly (string | null)[];
  /** Parent of the scratch directory. Defaults to the OS temporary directory. */
  readonly tmpRoot?: string;
}

const WORKDIR_PREFIX = "exeris-preview-";

/**
 * Subdirectory of the scratch directory the generator writes its files to. Only
 * this subdirectory is listed and diffed; anything else a generator process
 * leaves in the scratch directory (a crash log, a dump) is never reported as a
 * produced file.
 */
export const OUTPUT_SUBDIR = "out";

/** Create the generator's output subdirectory inside a scratch directory and return it. */
export function createOutputDir(workdir: string): string {
  const out = join(workdir, OUTPUT_SUBDIR);
  mkdirSync(out, { recursive: true });
  return out;
}

/**
 * Create the scratch directory and return its realpath.
 *
 * The parent is checked BEFORE anything is created, and the created directory
 * is checked again after realpath — a symlinked or relocated temporary
 * directory is judged by where it lands, not by what it is called. A directory
 * created and then found to be inside a protected root is removed before the
 * refusal is thrown. The native realpath is used so a case-insensitive
 * filesystem compares the on-disk spelling.
 */
export function createWorkdir(options: WorkdirOptions): string {
  const roots = resolveRoots(options.protectedRoots);
  const parent = realpathSync.native(options.tmpRoot ?? tmpdir());
  if (insideAny(roots, parent)) {
    throw new WorkdirRefusedError(
      "Refusing to create the preview directory: the temporary directory is inside the project or ecosystem root.",
    );
  }
  const created = mkdtempSync(join(parent, WORKDIR_PREFIX));
  let real: string;
  try {
    real = realpathSync.native(created);
  } catch (err) {
    removeWorkdir(created);
    throw err;
  }
  if (insideAny(roots, real)) {
    removeWorkdir(created);
    throw new WorkdirRefusedError(
      "Refusing to use the preview directory: it resolved inside the project or ecosystem root.",
    );
  }
  trackDirectory(real);
  return real;
}

/** Remove a scratch directory and everything under it. Never throws: cleanup must not mask the run's own outcome. */
export function removeWorkdir(dir: string): void {
  untrackDirectory(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A directory that cannot be removed is left to the OS temporary-directory reaper.
  }
}

/**
 * Run `fn` with a fresh scratch directory and remove it afterwards on EVERY
 * path — return, throw, timeout and size cap alike. `fn` decides what a limit
 * breach means; this guarantees only that nothing outlives the call.
 */
export async function withWorkdir<T>(
  options: WorkdirOptions,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = createWorkdir(options);
  try {
    return await fn(dir);
  } finally {
    removeWorkdir(dir);
  }
}

function resolveRoots(roots: readonly (string | null)[]): string[] {
  const resolved: string[] = [];
  for (const root of roots) {
    if (root === null) continue;
    try {
      resolved.push(realpathSync.native(root));
    } catch {
      // A root that does not exist cannot contain the scratch directory.
    }
  }
  return resolved;
}

function insideAny(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isInsideRealRoot(root, candidate));
}
