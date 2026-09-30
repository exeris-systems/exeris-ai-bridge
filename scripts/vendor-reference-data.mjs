#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDocsSnapshot, directoryReader, githubReader } from "../dist/data/docs-snapshot-build.js";
import { loadDocsSnapshot } from "../dist/data/docs-snapshot.js";
import { collectSources, resolveMavenRepo } from "../dist/data/vendor-resolver.js";

// Generates the bundled reference data that ships inside the npm package, so an
// application developer with no ecosystem checkout and no network still gets
// grounded answers. Run by `prepack`; see src/data/bundle.ts for the reader.
//
//   --emit     rebuild data/ and data/manifest.json  (default)
//   --verify   check that the manifest is present, well-formed, and that every
//              entry's bytes still match the digest recorded for it
//   --strict   fail hard if no repository or SDK jars are found, or the docs
//              registry snapshot cannot be built (required in prepack)
//
// The docs registry snapshot (data/docs/, ADR-025 2026-09-30 amendment) is read
// from GitHub — each repository's default branch at one recorded commit — or,
// when EXERIS_DOCS_SNAPSHOT_SOURCE names a directory laid out as <repo>/<path>,
// from there. The directory source is what keeps the smoke run hermetic.
// GITHUB_TOKEN, when set, only raises the API rate limit.
//
// data/ is NOT committed. Generating at pack time keeps a stale `generatedAt`
// out of git and means the bundle-absent path is the ordinary experience when
// running from source, rather than a branch only a test ever reaches.

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PACKAGE_ROOT, "data");
const MANIFEST = join(DATA_DIR, "manifest.json");
const SCHEMA_VERSION = 1;

async function emit(strict = false) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  const explicitVersion = process.env.EXERIS_SDK_VERSION?.trim();
  const repo = resolveMavenRepo({
    explicitVersion,
    checkArtifacts: ["exeris-sdk-annotations", "exeris-sdk-source-model"],
    minVersion: "0.12.0",
  });

  let sources;
  try {
    sources = collectSources({
      repo,
      explicitVersion,
      strict,
      failFn: (msg) => fail(msg),
    });
  } catch (err) {
    fail(err.message);
  }

  const entries = sources.map(({ id, bytes, sourceArtifact }) => {
    const path = `${id}.json`;
    writeFileSync(join(DATA_DIR, path), bytes);
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

  await emitDocsSnapshot(strict);
}

async function emitDocsSnapshot(strict) {
  const local = process.env.EXERIS_DOCS_SNAPSHOT_SOURCE?.trim();
  const reader = local ? directoryReader(local) : githubReader(process.env.GITHUB_TOKEN?.trim());
  let report;
  try {
    report = await buildDocsSnapshot(reader, DATA_DIR);
  } catch (cause) {
    rmSync(join(DATA_DIR, "docs"), { recursive: true, force: true });
    if (strict) fail(`docs registry snapshot: ${cause.message}`);
    console.warn(`[vendor-reference-data] no docs registry snapshot: ${cause.message}`);
    return;
  }
  const { manifest, unresolved } = report;
  const from = manifest.sources.map((s) => `${s.repo}@${s.commit.slice(0, 7)}`).join(", ");
  console.log(`[vendor-reference-data] docs snapshot: ${manifest.files.length} files from ${from}`);
  for (const e of manifest.excluded) console.log(`[vendor-reference-data]   excluded ${e.repo}: ${e.reason}`);
  if (unresolved.length > 0) {
    console.log(`[vendor-reference-data]   ${unresolved.length} index rows not vendored:`);
    for (const u of unresolved) console.log(`[vendor-reference-data]     ADR-${u.adr}: ${u.reason}`);
  }
}

function verify(strict = false) {
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

  // The same check the server runs at boot, so a snapshot the server would
  // refuse never reaches a published tarball.
  const snapshot = loadDocsSnapshot(DATA_DIR);
  if (snapshot.state === "available") {
    console.log(`[vendor-reference-data] verified the docs registry snapshot`);
  } else if (strict) {
    fail(`docs registry snapshot: ${snapshot.reason}`);
  }
}

function fail(message) {
  console.error(`[vendor-reference-data] ${message}`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const wantsStrict = args.has("--strict") || process.env.EXERIS_VENDOR_STRICT === "1";
const wantsVerify = args.has("--verify");
const wantsEmit = args.has("--emit") || !wantsVerify;
if (wantsEmit) await emit(wantsStrict);
if (wantsVerify) verify(wantsStrict);
