import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Unavailable } from "../config/env.js";
import { resolveInside, SandboxEscapeError } from "../fs/sandbox.js";

// The docs registry snapshot — what docs:* answers from when no exeris-docs
// checkout resolves (ADR-025, 2026-09-30 amendment "docs:* Serves a Bundled
// Registry Snapshot When No Checkout Is Present").
//
// The snapshot is laid out the way the ecosystem is laid out on disk:
//
//   data/docs/manifest.json
//   data/docs/NOTICE.md
//   data/docs/exeris-docs/adr-index.md, adr/…, templates/…, …
//   data/docs/exeris-sdk/docs/adr/…
//
// so `data/docs` stands in for the ecosystem root and `data/docs/exeris-docs`
// for the docs root, and every docs:* read — the path sandbox, relative
// registry links, GitHub-URL link candidates — works on it unchanged.
//
// Integrity is checked once, at boot, over the whole tree: every file the
// manifest lists must match its digest, and no file may be present that the
// manifest does not list. A docs:* read then goes through the ordinary sandbox
// with no per-read digest, because the tools read the tree by path rather than
// by entry id; the boot check is what stands between a modified tree and an
// agent.

/** Manifest schema version. Bumped when the shape below changes incompatibly. */
export const DOCS_SNAPSHOT_SCHEMA_VERSION = 1;

export const DOCS_SNAPSHOT_DIRNAME = "docs";
export const DOCS_SNAPSHOT_MANIFEST = "manifest.json";
export const DOCS_SNAPSHOT_NOTICE = "NOTICE.md";
/** The registry repository, and the snapshot's docs root inside the snapshot. */
export const REGISTRY_REPO = "exeris-docs";

/** One repository the snapshot draws from, at the commit it was read at. */
export interface SnapshotSource {
  readonly repo: string;
  /** The commit of the repository's default branch the files were read at. */
  readonly commit: string;
  /** SPDX identifier of the licence that admitted the repository. */
  readonly licence: string;
}

/** One vendored file. `path` is relative to its repository's root. */
export interface SnapshotFile {
  readonly repo: string;
  readonly path: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  readonly bytes: number;
}

/** A repository the builder looked at and left out, with why. */
export interface SnapshotExclusion {
  readonly repo: string;
  readonly reason: string;
}

export interface DocsSnapshotManifest {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly sources: readonly SnapshotSource[];
  readonly excluded: readonly SnapshotExclusion[];
  readonly files: readonly SnapshotFile[];
}

export interface AvailableDocsSnapshot {
  readonly state: "available";
  /** Absolute, realpath-resolved `<snapshot>/exeris-docs`. */
  readonly docsRoot: string;
  /** Absolute, realpath-resolved `<snapshot>` — the stand-in ecosystem root. */
  readonly ecosystemRoot: string;
  readonly generatedAt: string;
  readonly sources: readonly SnapshotSource[];
}

export type DocsSnapshotState = AvailableDocsSnapshot | Unavailable;

/**
 * Load and verify the snapshot under `dataRoot` (the package's `data/`).
 *
 * NEVER throws. Absent is the ordinary state for a bridge running from source,
 * because the snapshot is generated at pack time.
 */
export function loadDocsSnapshot(dataRoot: string = defaultDataRoot()): DocsSnapshotState {
  const root = join(dataRoot, DOCS_SNAPSHOT_DIRNAME);
  let raw: string;
  try {
    raw = readFileSync(join(root, DOCS_SNAPSHOT_MANIFEST), "utf8");
  } catch {
    return {
      state: "unavailable",
      reason:
        "No exeris-docs checkout is present, and this bridge carries no documentation snapshot. The snapshot is generated when the package is packed, so a bridge running from a source checkout does not have one.",
      remedy:
        "Set EXERIS_DOCS_ROOT to an exeris-docs checkout, or install the published package, which carries the snapshot.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return corrupt("its manifest is not valid JSON");
  }
  const manifest = parseDocsSnapshotManifest(parsed);
  if (manifest === null) return corrupt("its manifest does not match the expected shape");
  if (manifest.schemaVersion !== DOCS_SNAPSHOT_SCHEMA_VERSION) {
    return {
      state: "unavailable",
      reason: `The documentation snapshot uses manifest schema version ${manifest.schemaVersion}, and this bridge understands version ${DOCS_SNAPSHOT_SCHEMA_VERSION}.`,
      remedy: "Upgrade or downgrade @exeris/ai-bridge so the package and its snapshot come from the same release.",
    };
  }
  if (!manifest.sources.some((s) => s.repo === REGISTRY_REPO)) {
    return corrupt(`it carries no ${REGISTRY_REPO} source, so there is no registry to serve`);
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return corrupt("its directory cannot be resolved");
  }
  // loadConfig never throws, so neither may this: an unreadable directory in
  // the tree is a snapshot that cannot be served, not a failed boot.
  let problem: string | null;
  try {
    problem = verifyTree(realRoot, manifest);
  } catch {
    problem = "its directory tree cannot be read";
  }
  if (problem !== null) return corrupt(problem);

  return {
    state: "available",
    docsRoot: join(realRoot, REGISTRY_REPO),
    ecosystemRoot: realRoot,
    generatedAt: manifest.generatedAt,
    sources: manifest.sources,
  };
}

/**
 * Check every listed file against its digest, and refuse any file on disk the
 * manifest does not list. Returns a path-free description of the first
 * problem, or null. Exported for the vendor script's `--verify`.
 */
export function verifyTree(realRoot: string, manifest: DocsSnapshotManifest): string | null {
  const listed = new Set<string>();
  for (const file of manifest.files) {
    const rel = join(file.repo, file.path);
    listed.add(rel);
    let resolved: string;
    try {
      resolved = resolveInside(realRoot, join(realRoot, rel));
    } catch (err) {
      if (err instanceof SandboxEscapeError) {
        return err.resolved === null
          ? `the listed file ${rel} is missing`
          : `the listed file ${rel} resolves outside the snapshot`;
      }
      throw err;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved);
    } catch {
      return `the listed file ${rel} cannot be read`;
    }
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      return `the file ${rel} does not match the digest recorded when it was vendored`;
    }
  }

  for (const rel of walkFiles(realRoot)) {
    if (rel === DOCS_SNAPSHOT_MANIFEST || rel === DOCS_SNAPSHOT_NOTICE) continue;
    if (!listed.has(rel)) return `the file ${rel} is present but not listed in the manifest`;
  }
  return null;
}

/** Every regular file under `root`, relative to it, with `/` separators. Symlinks are reported as files. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else {
        out.push(relative(root, abs).split(sep).join("/"));
      }
    }
  }
  return out;
}

function corrupt(what: string): Unavailable {
  return {
    state: "unavailable",
    reason: `The documentation snapshot cannot be served: ${what}.`,
    remedy: "Reinstall @exeris/ai-bridge — the bundled snapshot has been modified or is incomplete.",
  };
}

/**
 * Validate the manifest shape. Strict for the same reason the reference-data
 * manifest is: a half-understood manifest would pass wrongly-typed fields to
 * the sandbox and digest checks.
 */
export function parseDocsSnapshotManifest(value: unknown): DocsSnapshotManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion !== "number" || typeof raw.generatedAt !== "string") return null;
  if (!Array.isArray(raw.sources) || !Array.isArray(raw.excluded) || !Array.isArray(raw.files)) return null;

  const sources: SnapshotSource[] = [];
  for (const s of raw.sources as unknown[]) {
    const r = record(s);
    if (r === null || !isString(r.repo) || !isString(r.commit) || !isString(r.licence)) return null;
    sources.push({ repo: r.repo, commit: r.commit, licence: r.licence });
  }
  const excluded: SnapshotExclusion[] = [];
  for (const e of raw.excluded as unknown[]) {
    const r = record(e);
    if (r === null || !isString(r.repo) || !isString(r.reason)) return null;
    excluded.push({ repo: r.repo, reason: r.reason });
  }
  const files: SnapshotFile[] = [];
  for (const f of raw.files as unknown[]) {
    const r = record(f);
    if (r === null || !isString(r.repo) || !isString(r.path) || !isString(r.sha256) || typeof r.bytes !== "number") {
      return null;
    }
    files.push({ repo: r.repo, path: r.path, sha256: r.sha256, bytes: r.bytes });
  }
  return { schemaVersion: raw.schemaVersion, generatedAt: raw.generatedAt, sources, excluded, files };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * The package's `data/`. After build this file lives at `dist/data/`, so two
 * levels up is the package root — the same walk `bundle.ts` uses.
 */
export function defaultDataRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
}

