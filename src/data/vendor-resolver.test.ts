import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  collectSources,
  compareVersions,
  findArtifactJar,
  parseLocalRepository,
  resolveMavenRepo,
  stripXmlComments,
} from "./vendor-resolver.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "exeris-vendor-resolver-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createFakeArtifact(repo: string, artifactId: string, version: string): string {
  const dir = join(repo, "eu", "exeris", artifactId, version);
  mkdirSync(dir, { recursive: true });
  const jarPath = join(dir, `${artifactId}-${version}.jar`);
  writeFileSync(jarPath, Buffer.from(`fake jar ${artifactId} ${version}`));
  return jarPath;
}

test("stripXmlComments strips nested and multiple comments iteratively", () => {
  const xml = "<a><!-- comment 1 -->text<!-- comment 2 --></a>";
  assert.equal(stripXmlComments(xml), "<a>text</a>");

  const nested = "<a><!-- outer <!-- inner --> comment -->content</a>";
  const stripped = stripXmlComments(nested);
  assert.ok(!stripped.includes("<!--"));
  assert.ok(stripped.includes("content"));
});

test("parseLocalRepository extracts repository path and replaces user.home", () => {
  const settings = `
<settings>
  <!-- <localRepository>/commented/out</localRepository> -->
  <localRepository>\${user.home}/custom-m2</localRepository>
</settings>
`;
  const result = parseLocalRepository(settings, "/home/testuser");
  assert.equal(result, "/home/testuser/custom-m2");
});

test("compareVersions ranks releases above snapshots and orders semver", () => {
  assert.ok(compareVersions("0.12.0", "0.11.0") > 0);
  assert.ok(compareVersions("0.11.0", "0.12.0") < 0);
  assert.ok(compareVersions("0.12.0", "0.12.0-SNAPSHOT") > 0);
  assert.ok(compareVersions("0.12.0-SNAPSHOT", "0.12.0") < 0);
  assert.equal(compareVersions("0.12.0", "0.12.0"), 0);
  assert.equal(compareVersions("0.12.0-SNAPSHOT", "0.12.0-SNAPSHOT"), 0);

  // Pre-release qualifiers rank below release of the same base, above SNAPSHOT, and compare lexically
  assert.ok(compareVersions("0.12.0", "0.12.0-rc1") > 0);
  assert.ok(compareVersions("0.12.0-rc1", "0.12.0") < 0);
  assert.ok(compareVersions("0.12.0-rc1", "0.12.0-SNAPSHOT") > 0);
  assert.ok(compareVersions("0.12.0-SNAPSHOT", "0.12.0-rc1") < 0);
  assert.ok(compareVersions("0.12.0-rc1", "0.12.0-rc2") < 0);
  assert.ok(compareVersions("0.12.0-rc2", "0.12.0-rc1") > 0);
  assert.ok(compareVersions("0.13.0-rc1", "0.12.0") > 0);
  assert.ok(compareVersions("0.11.0", "0.12.0-rc1") < 0);
});

test("findArtifactJar chooses release over snapshot and highest release", () => {
  const repo = join(tempDir, "repo");
  createFakeArtifact(repo, "test-art", "0.11.0");
  createFakeArtifact(repo, "test-art", "0.12.0-SNAPSHOT");
  createFakeArtifact(repo, "test-art", "0.12.0");

  const found = findArtifactJar(repo, "test-art");
  assert.ok(found);
  assert.equal(found.version, "0.12.0");
});

test("findArtifactJar chooses release over pre-release qualifier (0.12.0 over 0.12.0-rc1)", () => {
  const repo = join(tempDir, "repo");
  createFakeArtifact(repo, "test-art", "0.12.0-rc1");
  createFakeArtifact(repo, "test-art", "0.12.0");

  const found = findArtifactJar(repo, "test-art");
  assert.ok(found);
  assert.equal(found.version, "0.12.0");
});

test("findArtifactJar respects minVersion and filters out pre-release qualifiers below minVersion", () => {
  const repo = join(tempDir, "repo");
  createFakeArtifact(repo, "test-art", "0.12.0-rc1");

  const found = findArtifactJar(repo, "test-art", undefined, { minVersion: "0.12.0" });
  assert.equal(found, null);
});

test("findArtifactJar skips -SNAPSHOT by default when no release exists", () => {
  const repo = join(tempDir, "repo");
  createFakeArtifact(repo, "test-art", "0.12.0-SNAPSHOT");

  const found = findArtifactJar(repo, "test-art");
  assert.equal(found, null);
});

test("findArtifactJar accepts -SNAPSHOT when explicitVersion is specified", () => {
  const repo = join(tempDir, "repo");
  createFakeArtifact(repo, "test-art", "0.12.0-SNAPSHOT");

  const found = findArtifactJar(repo, "test-art", "0.12.0-SNAPSHOT");
  assert.ok(found);
  assert.equal(found.version, "0.12.0-SNAPSHOT");
});

test("resolveMavenRepo respects precedence order and fallback fixtures", () => {
  const fakeEnvRepo = join(tempDir, "env-repo");
  const fakeSettingsDir = join(tempDir, "settings-repo");
  const fakeDefaultM2 = join(tempDir, "default-m2");
  const fakeFallback = join(tempDir, "fallback-m2");

  mkdirSync(fakeFallback, { recursive: true });

  // When only fallback exists:
  let resolved = resolveMavenRepo({
    fallbackFixturesDir: fakeFallback,
    existsFn: (p) => p === fakeFallback,
  });
  assert.equal(resolved, fakeFallback);

  // When default m2 exists, it beats fallback:
  mkdirSync(fakeDefaultM2, { recursive: true });
  resolved = resolveMavenRepo({
    defaultM2Repo: fakeDefaultM2,
    fallbackFixturesDir: fakeFallback,
    existsFn: (p) => p === fakeFallback || p === fakeDefaultM2,
  });
  assert.equal(resolved, fakeDefaultM2);

  // When settingsPath points to a valid repo, it beats default m2:
  mkdirSync(fakeSettingsDir, { recursive: true });
  const fakeSettingsXml = join(tempDir, "settings.xml");
  writeFileSync(fakeSettingsXml, `<settings><localRepository>${fakeSettingsDir}</localRepository></settings>`);
  resolved = resolveMavenRepo({
    settingsPath: fakeSettingsXml,
    defaultM2Repo: fakeDefaultM2,
    fallbackFixturesDir: fakeFallback,
    existsFn: (p) => p === fakeFallback || p === fakeDefaultM2 || p === fakeSettingsXml || p === fakeSettingsDir,
  });
  assert.equal(resolved, fakeSettingsDir);

  // When env repo exists, it beats default m2:
  mkdirSync(fakeEnvRepo, { recursive: true });
  resolved = resolveMavenRepo({
    envRepo: fakeEnvRepo,
    defaultM2Repo: fakeDefaultM2,
    fallbackFixturesDir: fakeFallback,
    existsFn: (p) => p === fakeFallback || p === fakeDefaultM2 || p === fakeEnvRepo,
  });
  assert.equal(resolved, fakeEnvRepo);
});

test("collectSources fails in strict mode when repo is missing", () => {
  assert.throws(
    () => collectSources({ repo: null, strict: true }),
    /No local Maven repository found/,
  );
});

test("collectSources returns empty array in non-strict mode when repo is missing", () => {
  const warnings: string[] = [];
  const entries = collectSources({
    repo: null,
    strict: false,
    warnFn: (m) => warnings.push(m),
  });
  assert.deepEqual(entries, []);
  assert.ok(warnings.length > 0);
});

test("collectSources fails in strict mode when jars are missing", () => {
  const repo = join(tempDir, "empty-repo");
  mkdirSync(repo, { recursive: true });

  assert.throws(
    () => collectSources({ repo, strict: true }),
    /Could not find required Exeris SDK jars/,
  );
});

test("collectSources returns empty array in non-strict mode when jars are missing", () => {
  const repo = join(tempDir, "empty-repo");
  mkdirSync(repo, { recursive: true });
  const warnings: string[] = [];

  const entries = collectSources({
    repo,
    strict: false,
    warnFn: (m) => warnings.push(m),
  });
  assert.deepEqual(entries, []);
  assert.ok(warnings.length > 0);
});

test("collectSources extracts entries when jars are found", () => {
  const repo = join(tempDir, "valid-repo");
  createFakeArtifact(repo, "exeris-sdk-annotations", "0.12.0");
  createFakeArtifact(repo, "exeris-sdk-source-model", "0.12.0");

  const entries = collectSources({
    repo,
    strict: true,
    extractFn: (_jar, entry) => Buffer.from(`extracted ${entry}`),
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "annotation-catalog");
  assert.equal(entries[0].sourceArtifact, "eu.exeris:exeris-sdk-annotations:0.12.0");
  assert.equal(entries[1].id, "ast-schema");
  assert.equal(entries[1].sourceArtifact, "eu.exeris:exeris-sdk-source-model:0.12.0");
});
