import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Unavailable } from "../config/env.js";
import { resolveInside, SandboxEscapeError } from "../fs/sandbox.js";

// Bundled reference data — the read-only corpus that ships INSIDE the npm
// package, so an application developer with no ecosystem checkout and no
// network still gets grounded answers.
//
// 0.5.0 builds the mechanism; 0.6.0's sdk:* family fills it with content (the
// annotation catalog and AST schema, generated at release time from released
// exeris-sdk artifacts). The bundle therefore ships with ZERO entries today —
// an empty manifest is a real, honest state, and shipping placeholder content
// to prove a pipeline works would put fiction in a public package.
//
// The bundle is GENERATED AT PACK TIME (`prepack`), not committed. That keeps a
// stale `generatedAt` out of git, and it means the "absent" branch below is the
// ordinary experience when running from source — the path that would otherwise
// only ever be exercised by a test.

/** Manifest schema version. Bumped when the shape below changes incompatibly. */
export const BUNDLE_SCHEMA_VERSION = 1;

const MANIFEST_FILENAME = "manifest.json";
const DATA_DIRNAME = "data";

/** One vendored file, with the provenance and integrity to check it. */
export interface BundleEntry {
  /** Stable identifier a tool asks for; never a path. */
  readonly id: string;
  /** Location relative to the bundle root. Sandbox-checked before every read. */
  readonly path: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  readonly bytes: number;
  /**
   * Maven coordinate this content was derived from, so an agent can say WHICH
   * upstream release an answer reflects. Per-entry rather than one version for
   * the whole bundle: the catalog comes from exeris-sdk and the AST schema will
   * come from exeris-tooling, and collapsing them would misattribute one.
   */
  readonly sourceArtifact: string;
}

export interface BundleManifest {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  /** The bridge release that generated the bundle. */
  readonly bridgeVersion: string;
  readonly entries: readonly BundleEntry[];
}

export interface AvailableBundle {
  readonly state: "available";
  readonly generatedAt: string;
  readonly bridgeVersion: string;
  readonly entries: readonly BundleEntry[];
}

export type BundleState = AvailableBundle | Unavailable;

/**
 * Read and validate the bundle manifest.
 *
 * NEVER throws. A missing bundle (the normal case when running from a source
 * checkout), an unreadable manifest, malformed JSON, or a schema version this
 * build does not understand all resolve to an `Unavailable` carrying a reason
 * and a remedy — the same vocabulary the tool families use, because it is the
 * same kind of fact: this surface cannot answer, and here is why.
 *
 * `rootOverride` is injectable for tests.
 */
export function loadBundle(rootOverride?: string): BundleState {
  const root = rootOverride ?? defaultBundleRoot();
  let raw: string;
  try {
    raw = readFileSync(join(root, MANIFEST_FILENAME), "utf8");
  } catch {
    return {
      state: "unavailable",
      reason:
        "No bundled reference data is present. The bundle is generated when the package is packed, so a bridge running from a source checkout does not have one.",
      remedy:
        "Install the published package to get the bundle, or run the vendor script (npm run vendor:data) to generate it locally.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed("the bundle manifest is not valid JSON");
  }

  const manifest = parseManifest(parsed);
  if (manifest === null) return malformed("the bundle manifest does not match the expected shape");
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    return {
      state: "unavailable",
      reason: `The bundled reference data uses manifest schema version ${manifest.schemaVersion}, and this bridge understands version ${BUNDLE_SCHEMA_VERSION}.`,
      remedy:
        "Upgrade or downgrade @exeris/ai-bridge so the package and its bundle come from the same release.",
    };
  }

  return {
    state: "available",
    generatedAt: manifest.generatedAt,
    bridgeVersion: manifest.bridgeVersion,
    entries: manifest.entries,
  };
}

/** A bundle entry's verified contents, or the reason it could not be served. */
export type EntryRead = { readonly state: "available"; readonly text: string } | Unavailable;

/**
 * Read one entry by id, verifying its digest against the manifest.
 *
 * Integrity is checked on every read rather than trusted from the manifest,
 * because the failure this guards against — a truncated or half-written file —
 * produces content that parses fine and is quietly wrong. A digest mismatch is
 * reported as a state, never served.
 *
 * The entry's path is resolved INSIDE the bundle root even though the manifest
 * is ours: it is a file on disk that a later step could rewrite, and treating
 * our own generated input as trusted is how path escapes get in.
 */
export function readBundleEntry(bundle: AvailableBundle, id: string, rootOverride?: string): EntryRead {
  const root = rootOverride ?? defaultBundleRoot();
  const entry = bundle.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const known = bundle.entries.map((e) => e.id).sort((a, b) => a.localeCompare(b));
    return {
      state: "unavailable",
      reason: `The bundled reference data has no entry '${id}'.`,
      remedy:
        known.length === 0
          ? "This bundle carries no entries yet; the reference corpus lands with the sdk:* family."
          : `Known entries: ${known.join(", ")}.`,
    };
  }

  let resolved: string;
  try {
    resolved = resolveInside(root, join(root, entry.path));
  } catch (err) {
    if (err instanceof SandboxEscapeError) {
      // resolved === null means the path did not exist at all, which is a
      // different fact from a path that resolved somewhere outside the bundle.
      // Collapsing them would tell an operator their data had been tampered
      // with when a file is merely missing. Same split as the docs registry.
      return err.resolved === null
        ? missingEntry(id)
        : {
            state: "unavailable",
            reason: `The bundle entry '${id}' resolves to a path outside the bundle.`,
            remedy: "Reinstall @exeris/ai-bridge — the bundled data has been modified.",
          };
    }
    throw err;
  }

  let contents: Buffer;
  try {
    contents = readFileSync(resolved);
  } catch {
    return missingEntry(id);
  }

  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== entry.sha256) {
    return {
      state: "unavailable",
      reason: `The bundle entry '${id}' failed its integrity check; the file does not match the digest recorded when it was vendored.`,
      remedy: "Reinstall @exeris/ai-bridge — the bundled data has been modified or is corrupt.",
    };
  }

  return { state: "available", text: contents.toString("utf8") };
}

function missingEntry(id: string): Unavailable {
  return {
    state: "unavailable",
    reason: `The bundle entry '${id}' is listed in the manifest but is not present in the bundle.`,
    remedy: "Reinstall @exeris/ai-bridge — the bundled data is incomplete.",
  };
}

function malformed(what: string): Unavailable {
  return {
    state: "unavailable",
    reason: `The bundled reference data could not be read: ${what}.`,
    remedy: "Reinstall @exeris/ai-bridge — the bundled data is corrupt.",
  };
}

/**
 * Validate the manifest shape. Deliberately strict: a manifest we only half
 * understand is worse than none, because it would let a malformed entry through
 * to the sandbox and digest checks with fields that are the wrong type.
 */
function parseManifest(value: unknown): BundleManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion !== "number") return null;
  if (typeof raw.generatedAt !== "string") return null;
  if (typeof raw.bridgeVersion !== "string") return null;
  if (!Array.isArray(raw.entries)) return null;

  const entries: BundleEntry[] = [];
  for (const candidate of raw.entries) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const e = candidate as Record<string, unknown>;
    if (
      typeof e.id !== "string" ||
      typeof e.path !== "string" ||
      typeof e.sha256 !== "string" ||
      typeof e.bytes !== "number" ||
      typeof e.sourceArtifact !== "string"
    ) {
      return null;
    }
    entries.push({
      id: e.id,
      path: e.path,
      sha256: e.sha256,
      bytes: e.bytes,
      sourceArtifact: e.sourceArtifact,
    });
  }
  return {
    schemaVersion: raw.schemaVersion,
    generatedAt: raw.generatedAt,
    bridgeVersion: raw.bridgeVersion,
    entries,
  };
}

/**
 * The bundle root: `data/` at the package root.
 *
 * After build this file lives at `dist/data/bundle.js`, so two levels up is the
 * package root — the same walk `getServerVersion()` uses to find package.json.
 */
function defaultBundleRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", DATA_DIRNAME);
}
