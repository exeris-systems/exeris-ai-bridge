import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// Per ADR-025 §Concrete obligations item 4 and the v0.2.0 locked sandbox
// decision: every filesystem read in `docs:*` (and any future filesystem-bound
// family) MUST flow through resolveInside() against a pinned root. Agent input
// is never trusted to be inside the sandbox by inspection of the input string.

export class SandboxEscapeError extends Error {
  readonly root: string;
  readonly candidate: string;
  readonly resolved: string | null;

  constructor(root: string, candidate: string, resolved: string | null) {
    super(
      `Path escapes sandbox (root=${root}, candidate=${candidate}` +
        (resolved !== null ? `, resolved=${resolved})` : ", unresolved)"),
    );
    this.name = "SandboxEscapeError";
    this.root = root;
    this.candidate = candidate;
    this.resolved = resolved;
  }
}

/**
 * Resolve `candidate` against `root` and return the absolute realpath if
 * (and only if) it lies inside `root`'s realpath.
 *
 * Security model:
 *   - `root` is trusted; it has already been realpath-resolved by config.
 *   - `candidate` is untrusted (agent input or doc-derived link).
 *   - Absolute candidates are NOT rejected outright, because cross-repo ADR
 *     links resolve to absolute paths after path.resolve(). They still go
 *     through the containment check below.
 *   - realpath is the actual containment boundary, not the lexical join —
 *     symlinks that escape are rejected by the relative()-based check.
 *   - Missing files raise SandboxEscapeError, not ENOENT. Callers downstream
 *     get a single, consistent error type for both classes of failure.
 */
export function resolveInside(root: string, candidate: string): string {
  const joined = isAbsolute(candidate) ? candidate : resolve(root, candidate);

  let realCandidate: string;
  try {
    realCandidate = realpathSync(joined);
  } catch {
    throw new SandboxEscapeError(root, candidate, null);
  }

  const realRoot = realpathSync(root);
  const rel = relative(realRoot, realCandidate);

  // Inside-root iff the relative path is "" (same as root), or it neither
  // climbs out (starts with "..") nor jumps to a different drive (absolute).
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return realCandidate;
  }

  throw new SandboxEscapeError(realRoot, candidate, realCandidate);
}
