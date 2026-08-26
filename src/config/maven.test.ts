import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { findArtifactJar, newestReleaseVersion, resolveLocalRepository } from "./maven.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-maven-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const path = join(work, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Write a settings.xml under a scratch HOME and return that HOME. */
function homeWithSettings(body: string): string {
  const home = dir("home");
  mkdirSync(join(home, ".m2"), { recursive: true });
  writeFileSync(join(home, ".m2", "settings.xml"), body, "utf8");
  return home;
}

const KERNEL_CORE = { groupId: "eu.exeris", artifactId: "exeris-kernel-core" };
const LSP = { groupId: "eu.exeris.platform", artifactId: "exeris-platform-lsp" };

// ---------------------------------------------------------------------------
// resolveLocalRepository

test("EXERIS_MAVEN_REPO wins when it is an existing directory", () => {
  const repo = dir("custom-repo");
  assert.equal(resolveLocalRepository({ EXERIS_MAVEN_REPO: repo, HOME: dir("home") }), repo);
});

test("an EXERIS_MAVEN_REPO that does not exist resolves to nothing, not to the default", () => {
  // The caller named a repository. Silently reading a different one would hide
  // the mistake behind results that look right.
  const home = dir("home");
  mkdirSync(join(home, ".m2", "repository"), { recursive: true });
  assert.equal(resolveLocalRepository({ EXERIS_MAVEN_REPO: join(work, "nope"), HOME: home }), null);
});

test("<localRepository> in settings.xml is honoured", () => {
  const repo = dir("configured-repo");
  const home = homeWithSettings(`<settings><localRepository>${repo}</localRepository></settings>`);
  assert.equal(resolveLocalRepository({ HOME: home }), repo);
});

test("a COMMENTED-OUT <localRepository> is ignored", () => {
  // Maven's own shipped settings.xml documents this element inside a comment
  // block containing a complete <localRepository>…</localRepository> line.
  // Matching without stripping comments first would send every default
  // installation to /path/to/local/repo.
  const real = dir("home", ".m2", "repository");
  const home = homeWithSettings(`<settings>
  <!-- localRepository
   | The path to the local repository maven will use to store artifacts.
   |
   | Default: \${user.home}/.m2/repository
  <localRepository>/path/to/local/repo</localRepository>
  -->
</settings>`);
  assert.equal(resolveLocalRepository({ HOME: home }), real);
});

test("${user.home} is expanded against the same HOME the settings file came from", () => {
  // Expanding against the process's real home while reading settings from an
  // injected HOME would resolve half the path from each — and would make this
  // test write into the developer's actual home directory.
  const home = homeWithSettings("<settings><localRepository>${user.home}/custom</localRepository></settings>");
  const repo = join(home, "custom");
  mkdirSync(repo, { recursive: true });
  assert.equal(resolveLocalRepository({ HOME: home }), repo);
});

test("an unexpandable property falls through to the default rather than returning a bogus path", () => {
  const real = dir("home", ".m2", "repository");
  const home = homeWithSettings("<settings><localRepository>${env.NOT_A_THING}/repo</localRepository></settings>");
  assert.equal(resolveLocalRepository({ HOME: home }), real);
});

test("falls back to ~/.m2/repository, and to nothing when even that is absent", () => {
  const home = dir("home");
  assert.equal(resolveLocalRepository({ HOME: home }), null);

  const repo = join(home, ".m2", "repository");
  mkdirSync(repo, { recursive: true });
  assert.equal(resolveLocalRepository({ HOME: home }), repo);
});

// ---------------------------------------------------------------------------
// newestReleaseVersion

test("newestReleaseVersion picks the numerically newest bare MAJOR.MINOR.PATCH", () => {
  const repo = dir("repo");
  // Exactly the mix a working local repository accumulates.
  for (const v of [
    "0.9.0",
    "0.10.0",
    "0.10.2",
    "0.11.0-SNAPSHOT",
    "0.11.0-preview-SNAPSHOT",
    "0.6.0-RESEARCH-LOCALITY",
    "UNSPECIFIED-PIN-VIA-Dexeris.kernel.version",
    "maven-metadata-local.xml",
  ]) {
    mkdirSync(join(repo, "eu", "exeris", "exeris-kernel-core", v), { recursive: true });
  }
  // 0.10.2 over 0.9.0 — lexicographic ordering would get this backwards, and
  // every suffixed entry is somebody's experiment, not a release.
  assert.equal(newestReleaseVersion(repo, KERNEL_CORE), "0.10.2");
});

test("newestReleaseVersion returns null for an unknown coordinate or a releaseless one", () => {
  const repo = dir("repo");
  assert.equal(newestReleaseVersion(repo, KERNEL_CORE), null);

  mkdirSync(join(repo, "eu", "exeris", "exeris-kernel-core", "0.12.0-SNAPSHOT"), { recursive: true });
  assert.equal(newestReleaseVersion(repo, KERNEL_CORE), null);
});

test("a dotted groupId maps onto nested directories", () => {
  const repo = dir("repo");
  mkdirSync(join(repo, "eu", "exeris", "platform", "exeris-platform-lsp", "0.2.0"), { recursive: true });
  assert.equal(newestReleaseVersion(repo, LSP), "0.2.0");
});

// ---------------------------------------------------------------------------
// findArtifactJar

test("findArtifactJar returns the jar path when it exists, null otherwise", () => {
  const repo = dir("repo");
  const versionDir = join(repo, "eu", "exeris", "exeris-kernel-core", "0.11.0");
  mkdirSync(versionDir, { recursive: true });

  assert.equal(findArtifactJar(repo, KERNEL_CORE, "0.11.0"), null);

  const jar = join(versionDir, "exeris-kernel-core-0.11.0.jar");
  writeFileSync(jar, "x");
  assert.equal(findArtifactJar(repo, KERNEL_CORE, "0.11.0"), jar);
  assert.equal(findArtifactJar(repo, KERNEL_CORE, "0.10.0"), null);
});

test("findArtifactJar does not mistake a directory for a jar", () => {
  const repo = dir("repo");
  mkdirSync(join(repo, "eu", "exeris", "exeris-kernel-core", "0.11.0", "exeris-kernel-core-0.11.0.jar"), {
    recursive: true,
  });
  assert.equal(findArtifactJar(repo, KERNEL_CORE, "0.11.0"), null);
});

test("comment stripping survives fragments that splice into a new comment opener", () => {
  // For well-formed XML one pass is already exact — comments do not nest, so a
  // non-greedy match ends where the comment genuinely ends. This covers the
  // malformed case, where removing one comment joins two fragments into a new
  // <!-- that a single pass would leave behind.
  const real = dir("home", ".m2", "repository");
  const home = homeWithSettings(
    "<settings><!<!-- x -->-- <localRepository>/path/to/local/repo</localRepository> --></settings>",
  );
  assert.equal(resolveLocalRepository({ HOME: home }), real);
});

test("a real <localRepository> after a comment is still found", () => {
  // The fixpoint loop must not eat past the comment that actually closes.
  const repo = dir("configured");
  const home = homeWithSettings(
    `<settings><!-- commentary --><localRepository>${repo}</localRepository></settings>`,
  );
  assert.equal(resolveLocalRepository({ HOME: home }), repo);
});
