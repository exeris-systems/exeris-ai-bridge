import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  BUNDLE_SCHEMA_VERSION,
  loadBundle,
  readBundleEntry,
  type AvailableBundle,
  type BundleState,
} from "./bundle.js";

let work: string;
let root: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-bundle-"));
  root = join(work, "data");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Write an entry file plus the manifest row that describes it truthfully. */
function writeEntry(id: string, text: string, overrides: Record<string, unknown> = {}) {
  const path = `${id}.json`;
  writeFileSync(join(root, path), text, "utf8");
  return {
    id,
    path,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
    sourceArtifact: "eu.exeris:exeris-sdk-annotations:0.10.0",
    ...overrides,
  };
}

function writeManifest(entries: unknown[], overrides: Record<string, unknown> = {}) {
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      generatedAt: "2026-08-26T00:00:00.000Z",
      bridgeVersion: "0.5.0",
      entries,
      ...overrides,
    }),
    "utf8",
  );
}

function available(state: BundleState): AvailableBundle {
  assert.equal(state.state, "available");
  return state as AvailableBundle;
}

function unavailable(state: { state: string; reason?: string; remedy?: string }) {
  assert.equal(state.state, "unavailable");
  assert.ok((state.reason ?? "").length > 0);
  assert.ok((state.remedy ?? "").length > 0);
  return state as { reason: string; remedy: string };
}

// ---------------------------------------------------------------------------
// loadBundle — every failure is a state, never a throw

test("a missing bundle is the ordinary source-checkout state, not an error", () => {
  const dark = unavailable(loadBundle(join(work, "no-such-dir")));
  assert.match(dark.reason, /source checkout/);
  assert.match(dark.remedy, /vendor:data/);
});

test("a malformed manifest reports corruption rather than throwing", () => {
  writeFileSync(join(root, "manifest.json"), "{ not json", "utf8");
  assert.match(unavailable(loadBundle(root)).reason, /not valid JSON/);
});

test("a manifest of the wrong shape is refused rather than half-understood", () => {
  // A manifest we only partly understand is worse than none: entries with
  // wrong-typed fields would reach the sandbox and digest checks.
  writeManifest([{ id: "x", path: "x.json", sha256: 42, bytes: 1, sourceArtifact: "a:b:1" }]);
  assert.match(unavailable(loadBundle(root)).reason, /expected shape/);

  writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");
  assert.match(unavailable(loadBundle(root)).reason, /expected shape/);
});

test("a manifest from a different schema version names both versions", () => {
  writeManifest([], { schemaVersion: BUNDLE_SCHEMA_VERSION + 1 });
  const dark = unavailable(loadBundle(root));
  assert.match(dark.reason, new RegExp(String(BUNDLE_SCHEMA_VERSION + 1)));
  assert.match(dark.reason, new RegExp(String(BUNDLE_SCHEMA_VERSION)));
  assert.match(dark.remedy, /same release/);
});

test("an empty bundle is available, not absent", () => {
  // 0.5.0 ships exactly this: the mechanism, with the content arriving in
  // 0.6.0. "Present and carrying nothing" and "not present at all" are
  // different facts and bridge:version reports them differently.
  writeManifest([]);
  const bundle = available(loadBundle(root));
  assert.deepEqual(bundle.entries, []);
  assert.equal(bundle.bridgeVersion, "0.5.0");
});

test("a well-formed bundle exposes its entries with provenance", () => {
  writeManifest([writeEntry("catalog", '{"annotations":[]}')]);
  const bundle = available(loadBundle(root));
  assert.equal(bundle.entries.length, 1);
  assert.equal(bundle.entries[0].id, "catalog");
  assert.equal(bundle.entries[0].sourceArtifact, "eu.exeris:exeris-sdk-annotations:0.10.0");
});

// ---------------------------------------------------------------------------
// readBundleEntry — integrity and sandbox

test("readBundleEntry returns verified contents", () => {
  const text = '{"annotations":["ExerisDomain"]}';
  writeManifest([writeEntry("catalog", text)]);
  const read = readBundleEntry(available(loadBundle(root)), "catalog", root);
  assert.equal(read.state, "available");
  assert.equal(read.state === "available" ? read.text : "", text);
});

test("an unknown id lists what is there, and says so plainly when nothing is", () => {
  writeManifest([writeEntry("catalog", "{}")]);
  const known = unavailable(readBundleEntry(available(loadBundle(root)), "ghost", root));
  assert.match(known.remedy, /Known entries: catalog/);

  writeManifest([]);
  const empty = unavailable(readBundleEntry(available(loadBundle(root)), "ghost", root));
  assert.match(empty.remedy, /carries no entries yet/);
});

test("a digest mismatch is reported, never served", () => {
  // The failure this guards is a truncated or half-written file: content that
  // parses fine and is quietly wrong.
  const entry = writeEntry("catalog", '{"annotations":[]}');
  writeFileSync(join(root, entry.path), '{"annotations":["TAMPERED"]}', "utf8");
  writeManifest([entry]);
  assert.match(unavailable(readBundleEntry(available(loadBundle(root)), "catalog", root)).reason, /integrity check/);
});

test("an entry listed but absent on disk reads as incomplete, not as tampering", () => {
  // A missing file trips the sandbox guard too (there is nothing to realpath),
  // so the two must be told apart — otherwise a merely incomplete install is
  // reported as modified data.
  writeManifest([{ ...writeEntry("catalog", "{}"), path: "gone.json" }]);
  const dark = unavailable(readBundleEntry(available(loadBundle(root)), "catalog", root));
  assert.match(dark.reason, /is not present in the bundle/);
  assert.match(dark.remedy, /incomplete/);
  assert.ok(!dark.reason.includes("outside"), `misreported as an escape: ${dark.reason}`);
});

test("an entry path that escapes the bundle is refused", () => {
  // The manifest is ours, but it is still a file on disk that a later step
  // could rewrite. Treating our own generated input as trusted is how path
  // escapes get in.
  writeFileSync(join(work, "outside.json"), '{"secret":true}', "utf8");
  writeManifest([{ ...writeEntry("catalog", "{}"), path: "../outside.json" }]);
  const dark = unavailable(readBundleEntry(available(loadBundle(root)), "catalog", root));
  assert.match(dark.reason, /outside the bundle/);
  assert.ok(!dark.reason.includes(work), `leaked an absolute path: ${dark.reason}`);
});
