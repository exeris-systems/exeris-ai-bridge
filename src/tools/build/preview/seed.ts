import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
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

export interface SeedResult {
  /** Set when the tree exceeds a cap; the copy is then incomplete and the run must not start. */
  readonly limit: PreviewLimit | null;
  /** Regular files copied. */
  readonly copied: number;
}

const COPY_CHUNK = 64 * 1024;

/**
 * Copy the regular files of `l1Root` into `outDir`, preserving relative paths.
 *
 * Bounded by the same entry, depth and size caps as the listing that is diffed
 * afterwards. Every source is opened without following a link (`O_NOFOLLOW`),
 * judged on its descriptor (`fstat`: a regular file, within the bytes still
 * allowed) and copied through that descriptor, capped at the remaining budget,
 * so a file replaced or grown after the listing cannot lead the copy elsewhere
 * or past the cap. Symlinks are neither copied nor followed, and `l1Root`
 * itself is read only if it resolves inside `projectRoot`; a missing or
 * escaping L1 root seeds nothing. The project is only read.
 */
export function seedFromL1(
  projectRoot: string,
  l1Root: string,
  outDir: string,
  maxBytes: number = DEFAULT_MAX_FILES_BYTES,
): SeedResult {
  let confined: string;
  try {
    confined = resolveInside(projectRoot, l1Root);
  } catch {
    return { limit: null, copied: 0 };
  }
  const listing = listFiles(confined);
  if (listing.limit !== null) return { limit: listing.limit, copied: 0 };
  const declared = checkFilesSize(
    listing.files.reduce((sum, f) => sum + f.size, 0),
    maxBytes,
  );
  if (declared !== null) return { limit: declared, copied: 0 };

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let total = 0;
  let copied = 0;
  for (const file of listing.files) {
    let source: number;
    try {
      source = openSync(file.absolute, flags);
    } catch (err) {
      // A link that replaced the file since the listing: skipped, like any other link.
      if ((err as NodeJS.ErrnoException).code === "ELOOP") continue;
      throw err;
    }
    try {
      const stat = fstatSync(source);
      if (!stat.isFile()) continue;
      const tooBig = checkFilesSize(total + stat.size, maxBytes);
      if (tooBig !== null) return { limit: tooBig, copied };

      const target = join(outDir, ...file.relative.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      const sink = openSync(target, "wx");
      try {
        const buffer = Buffer.alloc(COPY_CHUNK);
        for (;;) {
          const n = readSync(source, buffer, 0, COPY_CHUNK, null);
          if (n === 0) break;
          total += n;
          const over = checkFilesSize(total, maxBytes);
          if (over !== null) return { limit: over, copied };
          writeSync(sink, buffer, 0, n);
        }
      } finally {
        closeSync(sink);
      }
      copied += 1;
    } finally {
      closeSync(source);
    }
  }
  return { limit: null, copied };
}
