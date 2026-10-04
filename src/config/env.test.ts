import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import { writeDocsEcosystemFixture } from "../data/__tests__/docs-ecosystem.js";
import { buildDocsSnapshot, directoryReader } from "../data/docs-snapshot-build.js";

import { loadConfig, type BridgeConfig, type DocsConfig, type KernelConfig, type LspConfig, type Unavailable } from "./env.js";

let work: string;
let mavenRepo: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-env-"));
  // An EMPTY local Maven repository, pinned into every load() below.
  //
  // Without this the launch ladder's m2 rung reads the developer's real ~/.m2,
  // and whether kernel:* resolves would depend on which eu.exeris artifacts
  // that machine happens to have installed. Tests that exercise the rung
  // install artifacts into this scratch repo explicitly.
  mavenRepo = join(work, "m2");
  mkdirSync(mavenRepo, { recursive: true });
});

/**
 * loadConfig with the local Maven repository pinned to the scratch repo, and
 * the package data root pinned to an empty directory unless a test supplies
 * one — a snapshot generated in this checkout must not decide what docs:*
 * resolves to in a test that is not about the snapshot.
 */
function load(env: NodeJS.ProcessEnv = {}, defaultRoot?: string, dataRoot?: string): BridgeConfig {
  return loadConfig({ EXERIS_MAVEN_REPO: mavenRepo, ...env }, defaultRoot, dataRoot ?? join(work, "no-data"));
}

/** Install a fake artifact jar into the scratch repo and return its path. */
function installJar(artifactId: string, version: string, groupPath = "eu/exeris"): string {
  const dir = join(mavenRepo, groupPath, artifactId, version);
  mkdirSync(dir, { recursive: true });
  const jar = join(dir, `${artifactId}-${version}.jar`);
  writeFileSync(jar, "not really a jar");
  return jar;
}

/** Create a version directory with no jar — enough to anchor version discovery. */
function installVersionDir(artifactId: string, version: string): void {
  mkdirSync(join(mavenRepo, "eu/exeris", artifactId, version), { recursive: true });
}

/** Create the sibling module pom the source-tree rung requires. */
function installPom(relative: string): void {
  const pom = join(work, relative);
  mkdirSync(dirname(pom), { recursive: true });
  writeFileSync(pom, "<project/>");
}

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A docs root that exists, plus the ecosystem root it implies. */
function withDocs(): string {
  const docs = join(work, "exeris-docs");
  mkdirSync(docs);
  return docs;
}

/** A path under `work` that deliberately does not exist. */
function missing(name = "missing"): string {
  return join(work, name);
}

/**
 * Load a config with the install-neighbour default forced to a non-existent
 * path — the zero-checkout (P2) shape. Without this the real default resolves
 * whenever the test run itself sits inside an ecosystem checkout, and the
 * branch under test would never be reached.
 */
function loadZeroCheckout(env: NodeJS.ProcessEnv): BridgeConfig {
  return load(env, missing("no-default-docs"));
}

function docsOf(cfg: BridgeConfig): DocsConfig {
  assert.equal(cfg.docs.state, "available");
  return cfg.docs;
}

function lspOf(cfg: BridgeConfig): LspConfig {
  assert.equal(cfg.lsp.state, "available");
  return cfg.lsp;
}

function kernelOf(cfg: BridgeConfig): KernelConfig {
  assert.equal(cfg.kernel.state, "available");
  return cfg.kernel;
}

function darkOf(family: DocsConfig | LspConfig | KernelConfig | Unavailable): Unavailable {
  assert.equal(family.state, "unavailable");
  return family;
}

/** Run `fn` with stderr captured, so warn-only diagnostics can be asserted. */
function captureStderr<T>(fn: () => T): { value: T; stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    return { value: fn(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

// ---------------------------------------------------------------------------
// docs roots

test("loadConfig honours EXERIS_DOCS_ROOT when set to an existing directory", () => {
  const docs = withDocs();
  const cfg = load({ EXERIS_DOCS_ROOT: docs });
  assert.ok(isAbsolute(docsOf(cfg).docsRoot));
  assert.equal(docsOf(cfg).docsRoot, docs);
});

test("loadConfig derives ecosystemRoot as dirname(docsRoot)", () => {
  const cfg = load({ EXERIS_DOCS_ROOT: withDocs() });
  assert.equal(cfg.ecosystemRoot, work);
  assert.equal(docsOf(cfg).ecosystemRoot, work);
});

test("loadConfig resolves symlinks in EXERIS_DOCS_ROOT to the real path", () => {
  const real = join(work, "real-docs");
  const link = join(work, "docs-symlink");
  mkdirSync(real);
  // Skip symlink assertion on platforms where symlink creation requires elevation.
  try {
    symlinkSync(real, link, "dir");
  } catch {
    return;
  }
  assert.equal(docsOf(load({ EXERIS_DOCS_ROOT: link })).docsRoot, real);
});

test("loadConfig returns absolute paths for both roots", () => {
  const cfg = load({ EXERIS_DOCS_ROOT: withDocs() });
  assert.ok(isAbsolute(docsOf(cfg).docsRoot));
  assert.ok(isAbsolute(docsOf(cfg).ecosystemRoot));
  assert.ok(cfg.ecosystemRoot !== null && isAbsolute(cfg.ecosystemRoot));
});

// ---------------------------------------------------------------------------
// fail-soft: loadConfig never throws (ADR-025 two-personas amendment)

test("loadConfig does not throw when EXERIS_DOCS_ROOT does not exist — docs:* goes dark", () => {
  const { value: cfg } = captureStderr(() => load({ EXERIS_DOCS_ROOT: missing() }));
  const dark = darkOf(cfg.docs);
  assert.match(dark.reason, /EXERIS_DOCS_ROOT is set but does not resolve/);
  assert.ok(dark.remedy.length > 0);
  assert.equal(cfg.ecosystemRoot, null);
});

test("loadConfig does not throw when EXERIS_DOCS_ROOT is a file, not a directory", () => {
  const file = join(work, "not-a-dir");
  writeFileSync(file, "x");
  const { value: cfg } = captureStderr(() => load({ EXERIS_DOCS_ROOT: file }));
  assert.match(darkOf(cfg.docs).reason, /does not resolve to a readable directory/);
});

test("an unresolvable EXERIS_DOCS_ROOT names the path on stderr but never in reason/remedy", () => {
  // reason/remedy are agent-facing (bridge:health lists them verbatim); the
  // operator's absolute path belongs on stderr only. Same discipline as
  // SandboxEscapeError keeping paths out of `.message`.
  const bad = missing("secret-checkout");
  const { value: cfg, stderr } = captureStderr(() => load({ EXERIS_DOCS_ROOT: bad }));
  const dark = darkOf(cfg.docs);
  assert.ok(stderr.includes(bad), `expected the path on stderr, got: ${stderr}`);
  assert.ok(!dark.reason.includes(bad), `leaked path in reason: ${dark.reason}`);
  assert.ok(!dark.remedy.includes(bad), `leaked path in remedy: ${dark.remedy}`);
});

test("loadConfig on a bare application project boots with every family dark", () => {
  // The P2 contract: no ecosystem checkout anywhere, no EXERIS_* set at all.
  const cfg = loadZeroCheckout({});
  assert.equal(cfg.mode, "app");
  assert.equal(cfg.modeSource, "default");
  assert.equal(cfg.ecosystemRoot, null);
  for (const family of [cfg.docs, cfg.lsp, cfg.kernel]) {
    const dark = darkOf(family);
    assert.ok(dark.reason.length > 0);
    assert.ok(dark.remedy.length > 0);
  }
  // From a source tree the package's snapshot has not been generated, and the
  // wording has to say that rather than read as a fault.
  assert.match(darkOf(cfg.docs).reason, /No exeris-docs checkout is present, and this bridge carries no documentation snapshot/);
});

test("loadConfig with the real process environment does not throw", () => {
  assert.doesNotThrow(() => load());
});

// ---------------------------------------------------------------------------
// EXERIS_BRIDGE_MODE

test("a resolved docs checkout does not make the mode contributor", () => {
  const cfg = load({ EXERIS_DOCS_ROOT: withDocs() });
  assert.equal(cfg.mode, "app");
  assert.equal(cfg.modeSource, "default");
  assert.equal(cfg.docs.state, "available");
  assert.notEqual(cfg.ecosystemRoot, null);
});

test("EXERIS_BRIDGE_MODE=contributor with no checkout reports a misconfiguration, not app mode", () => {
  const { value: cfg } = captureStderr(() => loadZeroCheckout({ EXERIS_BRIDGE_MODE: "contributor" }));
  assert.equal(cfg.mode, "contributor");
  assert.equal(cfg.modeSource, "env");
  assert.match(darkOf(cfg.docs).reason, /pins contributor mode/);
  assert.match(darkOf(cfg.lsp).reason, /pins contributor mode/);
  assert.match(darkOf(cfg.kernel).reason, /pins contributor mode/);
});

test("EXERIS_BRIDGE_MODE is descriptive, not a mask: pinning app keeps a resolved docs root", () => {
  const cfg = load({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_BRIDGE_MODE: "app" });
  assert.equal(cfg.mode, "app");
  assert.equal(cfg.modeSource, "env");
  assert.equal(cfg.docs.state, "available");
});

test("a blank EXERIS_BRIDGE_MODE is the default", () => {
  const docs = withDocs();
  for (const value of ["", "   "]) {
    const { value: cfg } = captureStderr(() => load({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: value }));
    assert.equal(cfg.mode, "app", `for ${JSON.stringify(value)}`);
    assert.equal(cfg.modeSource, "default", `for ${JSON.stringify(value)}`);
  }
});

test("EXERIS_BRIDGE_MODE=auto warns that the mode is never inferred, and runs in app mode", () => {
  const docs = withDocs();
  for (const value of ["auto", "  AUTO  "]) {
    const { value: cfg, stderr } = captureStderr(() => load({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: value }));
    assert.equal(cfg.mode, "app", `for ${JSON.stringify(value)}`);
    assert.equal(cfg.modeSource, "default", `for ${JSON.stringify(value)}`);
    assert.match(stderr, /EXERIS_BRIDGE_MODE=auto is not a mode/);
  }
});

test("an unrecognised EXERIS_BRIDGE_MODE warns and falls back to app mode", () => {
  const docs = withDocs();
  const { value: cfg, stderr } = captureStderr(() =>
    load({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: "contrib" }),
  );
  assert.equal(cfg.modeSource, "default");
  assert.equal(cfg.mode, "app");
  assert.match(stderr, /EXERIS_BRIDGE_MODE must be contributor or app/);
});

// ---------------------------------------------------------------------------
// the launch ladder — env-command → env-jar → m2 → source-tree → dark

const LSP_POM = "exeris-platform/exeris-platform-lsp/pom.xml";
const KERNEL_POM = "exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml";

/** Put a runnable kernel CLI in the scratch repo, anchored by kernel-core. */
function installKernelCli(version: string): string {
  installVersionDir("exeris-kernel-core", version);
  return installJar("exeris-kernel-diagnostics-cli", version);
}

test("rung 1: EXERIS_LSP_COMMAND is split on whitespace and wins outright", () => {
  const cfg = load({
    EXERIS_DOCS_ROOT: withDocs(),
    EXERIS_LSP_COMMAND: "  node   /opt/lsp/server.js   --stdio  ",
  });
  const lsp = lspOf(cfg);
  assert.equal(lsp.command, "node");
  assert.deepEqual(lsp.args, ["/opt/lsp/server.js", "--stdio"]);
  assert.equal(lsp.source, "env-command");
});

test("a blank EXERIS_*_COMMAND is treated as unset", () => {
  installPom(LSP_POM);
  installPom(KERNEL_POM);
  const cfg = load({
    EXERIS_DOCS_ROOT: withDocs(),
    EXERIS_LSP_COMMAND: "   ",
    EXERIS_KERNEL_COMMAND: "   ",
  });
  assert.equal(lspOf(cfg).source, "source-tree");
  assert.equal(kernelOf(cfg).source, "source-tree");
});

test("rung 2: an explicit jar launches java -jar, with no preview flag", () => {
  // Neither child is preview-stamped: exeris-kernel binds --enable-preview to
  // test-compile and surefire only (ADR-066 — the distributed artifact is
  // preview-clean, confirmed by class-file minor 0x0000 in every published CLI
  // jar), and exeris-platform uses no preview at all. Adding the flag would
  // imply a constraint neither artifact has.
  const kernelJar = installJar("exeris-kernel-diagnostics-cli", "0.11.0");
  const kernel = kernelOf(load({ EXERIS_KERNEL_JAR: kernelJar }));
  assert.equal(kernel.source, "env-jar");
  assert.equal(kernel.command, "java");
  assert.deepEqual(kernel.args, ["-jar", kernelJar]);

  const lspJar = installJar("exeris-platform-lsp", "0.1.0", "eu/exeris/platform");
  const lsp = lspOf(load({ EXERIS_LSP_JAR: lspJar }));
  assert.equal(lsp.source, "env-jar");
  assert.deepEqual(lsp.args, ["-jar", lspJar]);
});

test("an explicitly named jar that is missing takes the family dark, not down a rung", () => {
  // The operator named a mechanism. Quietly using a different one would hide
  // the typo — same stance as an unresolvable EXERIS_DOCS_ROOT.
  installPom(KERNEL_POM);
  installKernelCli("0.11.0");
  const gone = missing("nope.jar");
  const { value: cfg, stderr } = captureStderr(() =>
    load({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_KERNEL_JAR: gone }),
  );
  const dark = darkOf(cfg.kernel);
  assert.match(dark.reason, /EXERIS_KERNEL_JAR is set but does not point at an existing file/);
  assert.ok(stderr.includes(gone), "the failing path belongs on stderr");
  assert.ok(!dark.reason.includes(gone), `leaked path: ${dark.reason}`);
});

test("rung 3: a published CLI in the local Maven repository serves a zero-checkout P2", () => {
  const jar = installKernelCli("0.11.0");
  const cfg = loadZeroCheckout({});
  const kernel = kernelOf(cfg);
  assert.equal(kernel.source, "m2");
  assert.equal(kernel.artifactVersion, "0.11.0");
  assert.deepEqual(kernel.args, ["-jar", jar]);
  // docs:* has nothing to resolve; the kernel family is live regardless.
  assert.equal(cfg.docs.state, "unavailable");
  assert.equal(cfg.mode, "app");
});

test("rung 3 anchors the version on the newest RELEASE, ignoring snapshots and junk", () => {
  // A real local repository accumulates all of this next to the releases.
  for (const v of ["0.9.0", "0.10.0", "0.10.2", "0.11.0-SNAPSHOT", "0.11.0-preview-SNAPSHOT", "0.6.0-RESEARCH-LOCALITY", "UNSPECIFIED-PIN-VIA-Dexeris.kernel.version"]) {
    installVersionDir("exeris-kernel-core", v);
  }
  // 0.10.2 must outrank 0.9.0 — lexicographic ordering gets that backwards.
  installJar("exeris-kernel-diagnostics-cli", "0.10.2");
  assert.equal(kernelOf(loadZeroCheckout({})).artifactVersion, "0.10.2");
});

test("the local-repository rung is skipped when the anchor version has no matching CLI jar", () => {
  installVersionDir("exeris-kernel-core", "0.11.0"); // no CLI jar alongside it
  installPom(KERNEL_POM);
  const cfg = load({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_BRIDGE_MODE: "app" });
  assert.equal(kernelOf(cfg).source, "source-tree");
});

test("EXERIS_KERNEL_VERSION pins rung 3", () => {
  installKernelCli("0.11.0");
  const jar = installJar("exeris-kernel-diagnostics-cli", "0.10.2");
  const kernel = kernelOf(loadZeroCheckout({ EXERIS_KERNEL_VERSION: "0.10.2" }));
  assert.equal(kernel.artifactVersion, "0.10.2");
  assert.deepEqual(kernel.args, ["-jar", jar]);
});

test("a pinned version with no jar warns and lets the ladder continue", () => {
  // Unlike the JAR variable, this one does not name a launch mechanism — it
  // only qualifies one rung — so a miss must not take the family dark.
  installPom(KERNEL_POM);
  const { value: cfg, stderr } = captureStderr(() =>
    load({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_BRIDGE_MODE: "app", EXERIS_KERNEL_VERSION: "9.9.9" }),
  );
  assert.equal(kernelOf(cfg).source, "source-tree");
  assert.match(stderr, /EXERIS_KERNEL_VERSION=9\.9\.9 has no exeris-kernel-diagnostics-cli jar/);
});

test("lsp:* has no local-repository rung — the published jar is not executable", () => {
  // exeris-platform-lsp publishes a thin jar with no Main-Class, so probing for
  // it would produce a launch that fails at startup. The rung stays off until
  // the companion shading ask lands upstream.
  installJar("exeris-platform-lsp", "0.1.0", "eu/exeris/platform");
  const dark = darkOf(loadZeroCheckout({}).lsp);
  assert.match(dark.reason, /EXERIS_LSP_COMMAND and EXERIS_LSP_JAR are unset/);
  assert.ok(!dark.reason.includes("local Maven repository"), `offered a rung that does not exist: ${dark.reason}`);
  // The kernel's remedy, by contrast, does point at the local repository.
  assert.match(darkOf(loadZeroCheckout({}).kernel).remedy, /local Maven repository/);
});

test("rung 4: the source tree is used only when the module pom is actually there", () => {
  const docs = withDocs();
  // An ecosystem root that predates the module must not yield a spec that only
  // fails at spawn time.
  assert.equal(load({ EXERIS_DOCS_ROOT: docs }).kernel.state, "unavailable");

  installPom(KERNEL_POM);
  const kernel = kernelOf(load({ EXERIS_DOCS_ROOT: docs }));
  assert.equal(kernel.source, "source-tree");
  assert.equal(kernel.command, "mvn");
  assert.ok(kernel.args.includes("exec:java"));
  assert.ok(
    kernel.args.some((a) => a === "-Dexec.mainClass=eu.exeris.kernel.diagnostics.cli.DiagnosticsCli"),
    `expected the CLI main class in args, got ${JSON.stringify(kernel.args)}`,
  );
  assert.ok(kernel.args.some((a) => a.startsWith(work)));
});

test("rung 4 for lsp:* carries no exec.mainClass — the module pom configures it", () => {
  installPom(LSP_POM);
  const lsp = lspOf(load({ EXERIS_DOCS_ROOT: withDocs() }));
  assert.equal(lsp.source, "source-tree");
  assert.deepEqual(lsp.args.filter((a) => a.startsWith("-Dexec")), []);
  assert.ok(lsp.args.some((a) => a.endsWith(LSP_POM)));
});

test("the ladder is ordered: command beats jar beats everything below", () => {
  const jar = installKernelCli("0.11.0");
  installPom(KERNEL_POM);
  const docs = withDocs();

  const all = load({
    EXERIS_DOCS_ROOT: docs,
    EXERIS_KERNEL_COMMAND: "custom-cli",
    EXERIS_KERNEL_JAR: jar,
  });
  assert.equal(kernelOf(all).source, "env-command");

  const noCommand = load({ EXERIS_DOCS_ROOT: docs, EXERIS_KERNEL_JAR: jar });
  assert.equal(kernelOf(noCommand).source, "env-jar");
});

test("contributor mode prefers the source tree; app mode prefers the published jar", () => {
  // The one place mode changes behaviour rather than describing it. Someone
  // with a checkout is working ON that tree — answering kernel:* from a
  // released jar would report code they are not editing, and nothing in the
  // answer would say so.
  const jar = installKernelCli("0.11.0");
  installPom(KERNEL_POM);
  const docs = withDocs();

  assert.equal(kernelOf(load({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: "contributor" })).source, "source-tree");
  assert.equal(kernelOf(load({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: "app" })).source, "m2");
  // Unpinned is app: a checkout next to the install does not flip the order.
  assert.equal(kernelOf(load({ EXERIS_DOCS_ROOT: docs })).source, "m2");

  // Preference, not gating: the second rung still fires when the first cannot.
  const kernel = kernelOf(loadZeroCheckout({ EXERIS_BRIDGE_MODE: "contributor" }));
  assert.equal(kernel.source, "m2");
  assert.deepEqual(kernel.args, ["-jar", jar]);
});

test("JAVA_HOME selects the java binary for jar launches", () => {
  const jar = installJar("exeris-kernel-diagnostics-cli", "0.11.0");
  const kernel = kernelOf(load({ EXERIS_KERNEL_JAR: jar, JAVA_HOME: "/opt/jdk25" }));
  assert.equal(kernel.command, join("/opt/jdk25", "bin", "java"));

  const plain = kernelOf(load({ EXERIS_KERNEL_JAR: jar, JAVA_HOME: "   " }));
  assert.equal(plain.command, "java");
});

test("both children go dark with nothing to launch, naming the rungs that could fire", () => {
  const lsp = darkOf(loadZeroCheckout({}).lsp);
  assert.match(lsp.reason, /exeris-platform-lsp/);
  assert.match(lsp.remedy, /EXERIS_LSP_JAR/);
  assert.match(lsp.remedy, /EXERIS_LSP_COMMAND/);

  const kernel = darkOf(loadZeroCheckout({}).kernel);
  assert.match(kernel.reason, /no exeris-kernel-diagnostics-cli jar was found in the local Maven repository/);
  assert.match(kernel.remedy, /mvn dependency:get/);
  assert.match(kernel.remedy, /PACKAGES_READ_TOKEN/);
});

test("a checkout that lacks the module says so, rather than blaming the checkout's absence", () => {
  const dark = darkOf(load({ EXERIS_DOCS_ROOT: withDocs() }).lsp);
  assert.ok(
    dark.reason.includes(`the ecosystem checkout has no ${LSP_POM}`),
    `expected the missing module named, got: ${dark.reason}`,
  );
});

// ---------------------------------------------------------------------------
// lsp workspace

test("EXERIS_LSP_WORKSPACE sets the LSP workspace root; cwd is the default", () => {
  const docs = withDocs();
  installPom(LSP_POM); // the workspace only matters once lsp:* has something to launch
  const ws = join(work, "workspace");
  mkdirSync(ws);
  assert.equal(lspOf(load({ EXERIS_DOCS_ROOT: docs, EXERIS_LSP_WORKSPACE: ws })).workspaceRoot, ws);
  assert.equal(lspOf(load({ EXERIS_DOCS_ROOT: docs })).workspaceRoot, process.cwd());
  assert.equal(
    lspOf(load({ EXERIS_DOCS_ROOT: docs, EXERIS_LSP_WORKSPACE: "   " })).workspaceRoot,
    process.cwd(),
  );
});

test("a missing explicit EXERIS_LSP_WORKSPACE warns on stderr but does not throw", () => {
  const docs = withDocs();
  installPom(LSP_POM);
  const gone = missing("does-not-exist");

  const { value: cfg, stderr } = captureStderr(() =>
    load({ EXERIS_DOCS_ROOT: docs, EXERIS_LSP_WORKSPACE: gone }),
  );
  // The bad path is still honoured (the server will return an empty index)...
  assert.equal(lspOf(cfg).workspaceRoot, gone);
  // ...but the operator gets a diagnosable warning naming the path.
  assert.match(stderr, /EXERIS_LSP_WORKSPACE is not an existing directory/);
  assert.match(stderr, /empty index/);

  // The default (cwd, which exists) must stay silent.
  const { stderr: silent } = captureStderr(() => load({ EXERIS_DOCS_ROOT: docs }));
  assert.equal(silent, "");
});

test("an unresolvable EXERIS_MAVEN_REPO warns once instead of silently disabling a rung", () => {
  // Every other explicitly-set path here warns when it does not resolve. This
  // one used to just switch the local-repository rung off, which looks exactly
  // like a machine that does not have the artifact installed.
  const gone = missing("no-such-repo");
  const { value: cfg, stderr } = captureStderr(() =>
    loadConfig({ EXERIS_MAVEN_REPO: gone, EXERIS_BRIDGE_MODE: "app" }, missing("no-default-docs"), missing("no-data")),
  );
  assert.equal(cfg.kernel.state, "unavailable");
  assert.match(stderr, /EXERIS_MAVEN_REPO is not an existing directory/);
  // Global to the ladder, so two probing families must not warn twice.
  assert.equal(stderr.match(/EXERIS_MAVEN_REPO is not an existing directory/g)?.length, 1);
});

test("a resolvable EXERIS_MAVEN_REPO stays silent", () => {
  const { stderr } = captureStderr(() => load({ EXERIS_BRIDGE_MODE: "app" }, missing("no-default-docs")));
  assert.equal(stderr, "");
});

// ---------------------------------------------------------------------------
// project root — the pinned root build:* and caps:* read (ROADMAP 0.6.0)

/** A directory that looks like a Maven project: the probe keys on pom.xml. */
function project(...segments: string[]): string {
  const dir = join(work, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pom.xml"), "<project/>");
  return dir;
}

test("EXERIS_PROJECT_ROOT pins the project root and records the source", () => {
  const root = project("app");
  const cfg = load({ EXERIS_PROJECT_ROOT: root });
  assert.equal(cfg.project.state, "available");
  assert.equal((cfg.project as { source: string }).source, "env");
});

// An operator naming a root explicitly has said what they mean. Requiring a
// pom.xml there would veto build layouts this repo has not anticipated, and
// the explicit variable exists precisely to escape our guessing.
test("an explicit project root need not contain a pom.xml", () => {
  const bare = join(work, "bare");
  mkdirSync(bare, { recursive: true });
  const cfg = load({ EXERIS_PROJECT_ROOT: bare });
  assert.equal(cfg.project.state, "available");
});

test("an EXERIS_PROJECT_ROOT that does not resolve is a misconfiguration, not a silent probe", () => {
  const cfg = load({ EXERIS_PROJECT_ROOT: join(work, "not-there") });
  assert.equal(cfg.project.state, "unavailable");
  const dark = cfg.project;
  assert.match(dark.reason, /EXERIS_PROJECT_ROOT is set but does not resolve/);
  assert.match(dark.remedy, /EXERIS_PROJECT_ROOT/);
});

test("with no variable set, the nearest pom.xml at or above cwd wins", () => {
  const root = project("probed");
  const cfg = load({ EXERIS_TEST_CWD: root });
  assert.equal(cfg.project.state, "available");
  assert.equal((cfg.project as { source: string }).source, "cwd");
});

// Walking up is what makes the bridge usable when the agent starts it in a
// module subdirectory — and in a multi-module build it lands on the module
// whose own target/ holds the artefacts, not on the aggregator above it.
test("the probe walks up from a subdirectory to the nearest pom.xml", () => {
  const root = project("multi", "module-a");
  const deep = join(root, "src", "main", "java");
  mkdirSync(deep, { recursive: true });
  const cfg = load({ EXERIS_TEST_CWD: deep });
  assert.equal((cfg.project as { projectRoot: string }).projectRoot, root);
});

test("no pom.xml anywhere above cwd takes build:*/caps:* dark with a remedy", () => {
  const bare = join(work, "nothing-here");
  mkdirSync(bare, { recursive: true });
  const cfg = load({ EXERIS_TEST_CWD: bare });
  assert.equal(cfg.project.state, "unavailable");
  const dark = cfg.project;
  assert.match(dark.reason, /No Maven project was found/);
  assert.match(dark.remedy, /EXERIS_PROJECT_ROOT/);
});

// The zero-checkout contract: no root of any kind may throw out of config load.
test("an unresolvable project root never fails the boot", () => {
  assert.doesNotThrow(() => load({ EXERIS_PROJECT_ROOT: join(work, "gone"), EXERIS_BRIDGE_MODE: "app" }));
});

// Same discipline as every other family: these strings go over the wire.
test("neither project-dark string leaks a machine path", () => {
  const secret = join(work, "secret-dir");
  const cfg = load({ EXERIS_PROJECT_ROOT: secret });
  const dark = cfg.project as Unavailable;
  assert.equal(dark.reason.includes(secret), false);
  assert.equal(dark.remedy.includes(secret), false);
});

// ---------------------------------------------------------------------------
// docs:* — the bundled registry snapshot (ADR-025, 2026-09-30 amendment)

/** Build a snapshot of the fixture ecosystem into a scratch data root and return that root. */
async function snapshotDataRoot(): Promise<string> {
  const ecosystem = join(work, "fixture-ecosystem");
  writeDocsEcosystemFixture(ecosystem);
  const dataRoot = join(work, "data");
  mkdirSync(dataRoot);
  await buildDocsSnapshot(directoryReader(ecosystem), dataRoot);
  return dataRoot;
}

test("with no checkout, docs:* answers from the bundled snapshot and the mode stays app", async () => {
  const dataRoot = await snapshotDataRoot();
  const cfg = load({}, missing("no-default-docs"), dataRoot);
  const docs = docsOf(cfg);
  assert.equal(docs.source, "snapshot");
  assert.ok(docs.docsRoot.endsWith(join("data", "docs", "exeris-docs")));
  // A snapshot is not an ecosystem: nothing to build children from, and no
  // reason to read this machine as a contributor's.
  assert.equal(cfg.ecosystemRoot, null);
  assert.equal(cfg.mode, "app");
  if (docs.source === "snapshot") {
    assert.deepEqual(docs.sources.map((s) => s.repo), ["exeris-docs", "exeris-sdk"]);
  }
});

test("a checkout outranks the snapshot", async () => {
  const dataRoot = await snapshotDataRoot();
  const checkout = join(work, "eco", "exeris-docs");
  mkdirSync(checkout, { recursive: true });
  const cfg = load({ EXERIS_DOCS_ROOT: checkout }, undefined, dataRoot);
  assert.equal(docsOf(cfg).source, "checkout");
  assert.equal(cfg.mode, "app");
});

test("an explicit EXERIS_DOCS_ROOT that does not resolve stays dark rather than falling back to the snapshot", async () => {
  const dataRoot = await snapshotDataRoot();
  const { value: cfg } = captureStderr(() => load({ EXERIS_DOCS_ROOT: missing("typo") }, undefined, dataRoot));
  const dark = darkOf(cfg.docs);
  assert.match(dark.reason, /EXERIS_DOCS_ROOT is set/);
  assert.match(dark.remedy, /unset it to use the documentation snapshot/);
});

test("a pinned contributor with no checkout gets the snapshot, and a warning", async () => {
  const dataRoot = await snapshotDataRoot();
  const { value: cfg, stderr } = captureStderr(() =>
    load({ EXERIS_BRIDGE_MODE: "contributor" }, missing("no-default-docs"), dataRoot),
  );
  assert.equal(docsOf(cfg).source, "snapshot");
  assert.equal(cfg.mode, "contributor");
  assert.match(stderr, /answers from the bundled snapshot/);
});

test("with neither a checkout nor a snapshot, docs:* is dark with the snapshot's remedy", () => {
  const cfg = load({}, missing("no-default-docs"));
  const dark = darkOf(cfg.docs);
  assert.match(dark.reason, /no documentation snapshot/);
  assert.match(dark.remedy, /EXERIS_DOCS_ROOT/);
  assert.equal(cfg.mode, "app");
});
