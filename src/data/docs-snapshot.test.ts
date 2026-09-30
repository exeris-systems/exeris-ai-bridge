import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { writeDocsEcosystemFixture } from "./__tests__/docs-ecosystem.js";
import { buildDocsSnapshot, detectLicence, directoryReader, locate } from "./docs-snapshot-build.js";
import { loadDocsSnapshot, type AvailableDocsSnapshot } from "./docs-snapshot.js";

let work: string;
let fixture: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-docs-snapshot-"));
  fixture = mkdtempSync(join(tmpdir(), "exeris-docs-ecosystem-"));
  writeDocsEcosystemFixture(fixture);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
});

async function build() {
  return buildDocsSnapshot(directoryReader(fixture), work, new Date("2026-09-30T00:00:00Z"));
}

function available(): AvailableDocsSnapshot {
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "available", snapshot.state === "unavailable" ? snapshot.reason : "");
  return snapshot;
}

test("detectLicence recognises the Apache 2.0 header and nothing else", () => {
  assert.equal(detectLicence("\n                                 Apache License\n   Version 2.0, January 2004\n"), "Apache-2.0");
  assert.equal(detectLicence("EXERIS SOFTWARE LICENSE — INDEX\nVersion 1.1"), null);
  assert.equal(detectLicence("Apache License\nVersion 1.1"), null);
  assert.equal(detectLicence(""), null);
});

test("locate splits a registry-relative candidate and refuses anything but a plain in-repo path", () => {
  assert.deepEqual(locate("adr/ADR-001.md"), { repo: "exeris-docs", path: "adr/ADR-001.md" });
  assert.deepEqual(locate("../exeris-sdk/docs/adr/ADR-003.md"), { repo: "exeris-sdk", path: "docs/adr/ADR-003.md" });
  assert.equal(locate("../exeris-sdk/../outside.md"), null);
  assert.equal(locate("../../outside.md"), null);
  assert.equal(locate("/etc/passwd"), null);
  assert.equal(locate("../exeris-sdk"), null);
});

test("the snapshot carries the registry tier and each licensed, public, in-scope record", async () => {
  const { manifest, unresolved } = await build();

  assert.deepEqual(manifest.sources, [
    { repo: "exeris-docs", commit: "fixture-docs-commit", licence: "Apache-2.0" },
    { repo: "exeris-sdk", commit: "fixture-sdk-commit", licence: "Apache-2.0" },
  ]);
  assert.deepEqual(
    manifest.files.map((f) => `${f.repo}/${f.path}`),
    [
      "exeris-docs/adr-index.md",
      "exeris-docs/adr/ADR-001-local-record.md",
      "exeris-docs/b2b-technical-whitepaper.md",
      "exeris-docs/high-level-architecture.md",
      "exeris-docs/templates/ADR-TEMPLATE.md",
      "exeris-docs/templates/RESEARCH-TEMPLATE.md",
      "exeris-docs/templates/RFC-TEMPLATE.md",
      "exeris-sdk/docs/adr/ADR-003-sibling-by-url.md",
    ],
    "the working note and the licence files are not registry content",
  );

  // Excluded for a licence it does not recognise, and — by name, before it is
  // read at all — the enterprise repository, even for a row marked public.
  assert.deepEqual(manifest.excluded, [
    { repo: "exeris-kernel", reason: "no licence that permits redistributing its documentation" },
    { repo: "exeris-kernel-enterprise", reason: "outside the public documentation scope" },
  ]);
  assert.deepEqual(
    Object.fromEntries(unresolved.map((u) => [u.adr, u.reason])),
    {
      "007": "repository exeris-kernel is excluded",
      "016": "visibility enterprise-private",
      "018": "repository exeris-kernel-enterprise is excluded",
      "020": "not present on the default branch of exeris-sdk",
      "040": "linked outside the ecosystem",
    },
  );

  const notice = readFileSync(join(work, "docs", "NOTICE.md"), "utf8");
  assert.match(notice, /\| \[exeris-sdk\]\(https:\/\/github\.com\/exeris-systems\/exeris-sdk\) \| `fixture-sdk-commit` \| Apache-2\.0 \|/);
  assert.match(notice, /- exeris-kernel — no licence/);
});

test("the build refuses to write over an existing snapshot directory", async () => {
  await build();
  await assert.rejects(build(), /already exists/);
});

test("the build fails when the registry itself cannot be vendored", async () => {
  const noRegistry = mkdtempSync(join(tmpdir(), "exeris-docs-snapshot-empty-"));
  try {
    await assert.rejects(
      buildDocsSnapshot(directoryReader(noRegistry), work),
      /registry repository exeris-docs cannot be vendored: not found/,
    );
  } finally {
    rmSync(noRegistry, { recursive: true, force: true });
  }
});

test("a built snapshot loads with the registry as docs root and the snapshot as ecosystem root", async () => {
  await build();
  const snapshot = available();
  assert.equal(snapshot.ecosystemRoot, join(snapshot.docsRoot, ".."));
  assert.ok(snapshot.docsRoot.endsWith(join("docs", "exeris-docs")));
  assert.equal(snapshot.generatedAt, "2026-09-30T00:00:00.000Z");
  assert.deepEqual(
    snapshot.sources.map((s) => s.repo),
    ["exeris-docs", "exeris-sdk"],
  );
});

test("an absent snapshot is unavailable with a remedy, not an error", () => {
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.remedy : "", /EXERIS_DOCS_ROOT/);
});

test("a file that no longer matches its digest takes the snapshot dark", async () => {
  await build();
  appendFileSync(join(work, "docs", "exeris-sdk", "docs", "adr", "ADR-003-sibling-by-url.md"), "tampered\n");
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /does not match the digest/);
});

test("a file the manifest does not list takes the snapshot dark", async () => {
  await build();
  writeFileSync(join(work, "docs", "exeris-docs", "adr", "ADR-999-planted.md"), "# planted\n");
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /present but not listed/);
});

test("a listed file that is missing takes the snapshot dark", async () => {
  await build();
  rmSync(join(work, "docs", "exeris-docs", "high-level-architecture.md"));
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /is missing/);
});

test("a manifest from another schema version is refused with the version named", async () => {
  await build();
  const path = join(work, "docs", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...manifest, schemaVersion: 99 }));
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /schema version 99/);
});

test("a manifest with no registry source is refused", async () => {
  await build();
  const path = join(work, "docs", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { sources: { repo: string }[] };
  writeFileSync(path, JSON.stringify({ ...manifest, sources: manifest.sources.filter((s) => s.repo !== "exeris-docs") }));
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /no exeris-docs source/);
});

test("reasons carry no machine path", async () => {
  await build();
  appendFileSync(join(work, "docs", "exeris-docs", "adr-index.md"), "x");
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  if (snapshot.state === "unavailable") {
    assert.equal(snapshot.reason.includes(work), false);
    assert.equal(snapshot.remedy.includes(work), false);
  }
});

test("a manifest entry that climbs out of the snapshot takes it dark without reading outside", async () => {
  await build();
  writeFileSync(join(work, "outside.md"), "# outside\n");
  const path = join(work, "docs", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { files: Record<string, unknown>[] };
  manifest.files.push({ repo: "exeris-docs", path: "../../outside.md", sha256: "0".repeat(64), bytes: 11 });
  writeFileSync(path, JSON.stringify(manifest));
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /resolves outside the snapshot/);
});

test("a symlink planted in the snapshot tree takes it dark", async () => {
  await build();
  writeFileSync(join(work, "secret.md"), "# secret\n");
  symlinkSync(join(work, "secret.md"), join(work, "docs", "exeris-docs", "adr", "ADR-998-link.md"));
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /present but not listed/);
});

test("a listed file replaced by a symlink to outside the snapshot takes it dark", async () => {
  await build();
  const target = join(work, "docs", "exeris-docs", "high-level-architecture.md");
  writeFileSync(join(work, "elsewhere.md"), readFileSync(target));
  rmSync(target);
  symlinkSync(join(work, "elsewhere.md"), target);
  const snapshot = loadDocsSnapshot(work);
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.state === "unavailable" ? snapshot.reason : "", /resolves outside the snapshot/);
});
