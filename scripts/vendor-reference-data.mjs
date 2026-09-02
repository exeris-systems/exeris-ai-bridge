#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Generates the bundled reference data that ships inside the npm package, so an
// application developer with no ecosystem checkout and no network still gets
// grounded answers. Run by `prepack`; see src/data/bundle.ts for the reader.
//
//   --emit     rebuild data/ and data/manifest.json  (default)
//   --verify   check that the manifest is present, well-formed, and that every
//              entry's bytes still match the digest recorded for it
//
// data/ is NOT committed. Generating at pack time keeps a stale `generatedAt`
// out of git and means the bundle-absent path is the ordinary experience when
// running from source, rather than a branch only a test ever reaches.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PACKAGE_ROOT, "data");
const MANIFEST = join(DATA_DIR, "manifest.json");
const SCHEMA_VERSION = 1;

/**
 * Decide what to vendor.
 *
 * Returns nothing at 0.5.0, on purpose: this milestone ships the mechanism and
 * 0.7.0's sdk:* family ships the content — the annotation catalog and AST
 * schema, generated upstream by the reflection mechanism `AnnotationContractTest`
 * already uses. Shipping placeholder content to prove a pipeline works would put
 * fiction in a public package, so the bundle ships with zero entries and an
 * honest manifest instead.
 *
 * A function rather than a constant because 0.7.0 has to *locate* these — probe
 * the local Maven repository, pick a version, fail loudly if the artifact is
 * absent — which is logic, not a literal.
 *
 * @returns {Array<{id: string, file: string, sourceArtifact: string}>} `file` is
 *   an absolute path to read; `sourceArtifact` the Maven coordinate it was
 *   derived from, so an agent can say which upstream release an answer reflects.
 */
function collectSources() {
  return [];
}

function emit() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const entries = collectSources().map(({ id, file, sourceArtifact }) => {
    const bytes = readFileSync(file);
    const path = `${id}.json`;
    copyFileSync(file, join(DATA_DIR, path));
    return {
      id,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      sourceArtifact,
    };
  });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    bridgeVersion: JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version,
    entries,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[vendor-reference-data] wrote ${entries.length} entr${entries.length === 1 ? "y" : "ies"} to data/`);
}

function verify() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (cause) {
    fail(`data/manifest.json is missing or unreadable: ${cause.message}`);
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    fail(`data/manifest.json declares schemaVersion ${manifest.schemaVersion}, expected ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(manifest.entries)) fail("data/manifest.json has no entries array");

  for (const entry of manifest.entries) {
    const file = join(DATA_DIR, entry.path);
    // Belt and braces against a path escaping the bundle. The reader enforces
    // this too, but a bad manifest should never reach a published tarball.
    if (!file.startsWith(DATA_DIR + "/")) fail(`entry '${entry.id}' resolves outside data/`);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      fail(`entry '${entry.id}' is listed in the manifest but ${entry.path} is not present`);
    }
    if (statSync(file).size !== entry.bytes) fail(`entry '${entry.id}' has an unexpected size`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) fail(`entry '${entry.id}' does not match its recorded digest`);
  }
  console.log(`[vendor-reference-data] verified ${manifest.entries.length} entries`);
}

function fail(message) {
  console.error(`[vendor-reference-data] ${message}`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const wantsVerify = args.has("--verify");
const wantsEmit = args.has("--emit") || !wantsVerify;
if (wantsEmit) emit();
if (wantsVerify) verify();
