import { copyFileSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveInside } from "../../../fs/sandbox.js";
import { listFiles } from "./diff.js";
import { checkFilesSize, DEFAULT_MAX_FILES_BYTES, type PreviewLimit } from "./runner.js";

// A generator decides what to write from the manifest its previous run left in
// the output root (`.exeris-codegen-manifest`): it keeps seed files, never
// replaces a file it does not own, prunes orphans, and the Java generator
// refuses empty metadata that would orphan a tree. A preview into an empty
// directory would not behave like a real run on the project, so the project's
// current L1 tree, manifest included, is copied into the scratch output
// directory first.

/**
 * Copy the regular files of `l1Root` into `outDir`, preserving relative paths.
 *
 * Bounded by the same entry, depth and size caps as the listing that is diffed
 * afterwards; a tree beyond any of them copies nothing and returns the limit.
 * Symlinks are neither copied nor followed, and `l1Root` itself is read only if
 * it resolves inside `projectRoot`. A missing or escaping L1 root seeds nothing.
 * The project is only read.
 */
export function seedFromL1(
  projectRoot: string,
  l1Root: string,
  outDir: string,
  maxBytes: number = DEFAULT_MAX_FILES_BYTES,
): PreviewLimit | null {
  let confined: string;
  try {
    confined = resolveInside(projectRoot, l1Root);
  } catch {
    return null;
  }
  const listing = listFiles(confined);
  if (listing.limit !== null) return listing.limit;
  const limit = checkFilesSize(
    listing.files.reduce((sum, f) => sum + f.size, 0),
    maxBytes,
  );
  if (limit !== null) return limit;

  for (const file of listing.files) {
    // Re-checked at the copy: copyFileSync follows a link that replaced the file since the listing.
    if (!lstatSync(file.absolute).isFile()) continue;
    const target = join(outDir, ...file.relative.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolute, target);
  }
  return null;
}
