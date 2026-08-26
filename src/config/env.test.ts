import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import { loadConfig, type BridgeConfig, type DocsConfig, type KernelConfig, type LspConfig, type Unavailable } from "./env.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-env-"));
});

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
  return loadConfig(env, missing("no-default-docs"));
}

function docsOf(cfg: BridgeConfig): DocsConfig {
  assert.equal(cfg.docs.state, "available");
  return cfg.docs as DocsConfig;
}

function lspOf(cfg: BridgeConfig): LspConfig {
  assert.equal(cfg.lsp.state, "available");
  return cfg.lsp as LspConfig;
}

function kernelOf(cfg: BridgeConfig): KernelConfig {
  assert.equal(cfg.kernel.state, "available");
  return cfg.kernel as KernelConfig;
}

function darkOf(family: DocsConfig | LspConfig | KernelConfig | Unavailable): Unavailable {
  assert.equal(family.state, "unavailable");
  return family as Unavailable;
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
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: docs });
  assert.ok(isAbsolute(docsOf(cfg).docsRoot));
  assert.equal(docsOf(cfg).docsRoot, docs);
});

test("loadConfig derives ecosystemRoot as dirname(docsRoot)", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs() });
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
  assert.equal(docsOf(loadConfig({ EXERIS_DOCS_ROOT: link })).docsRoot, real);
});

test("loadConfig returns absolute paths for both roots", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs() });
  assert.ok(isAbsolute(docsOf(cfg).docsRoot));
  assert.ok(isAbsolute(docsOf(cfg).ecosystemRoot));
  assert.ok(cfg.ecosystemRoot !== null && isAbsolute(cfg.ecosystemRoot));
});

// ---------------------------------------------------------------------------
// fail-soft: loadConfig never throws (ADR-025 two-personas amendment)

test("loadConfig does not throw when EXERIS_DOCS_ROOT does not exist — docs:* goes dark", () => {
  const { value: cfg } = captureStderr(() => loadConfig({ EXERIS_DOCS_ROOT: missing() }));
  const dark = darkOf(cfg.docs);
  assert.match(dark.reason, /EXERIS_DOCS_ROOT is set but does not resolve/);
  assert.ok(dark.remedy.length > 0);
  assert.equal(cfg.ecosystemRoot, null);
});

test("loadConfig does not throw when EXERIS_DOCS_ROOT is a file, not a directory", () => {
  const file = join(work, "not-a-dir");
  writeFileSync(file, "x");
  const { value: cfg } = captureStderr(() => loadConfig({ EXERIS_DOCS_ROOT: file }));
  assert.match(darkOf(cfg.docs).reason, /does not resolve to a readable directory/);
});

test("an unresolvable EXERIS_DOCS_ROOT names the path on stderr but never in reason/remedy", () => {
  // reason/remedy are agent-facing (bridge:health lists them verbatim); the
  // operator's absolute path belongs on stderr only. Same discipline as
  // SandboxEscapeError keeping paths out of `.message`.
  const bad = missing("secret-checkout");
  const { value: cfg, stderr } = captureStderr(() => loadConfig({ EXERIS_DOCS_ROOT: bad }));
  const dark = darkOf(cfg.docs);
  assert.ok(stderr.includes(bad), `expected the path on stderr, got: ${stderr}`);
  assert.ok(!dark.reason.includes(bad), `leaked path in reason: ${dark.reason}`);
  assert.ok(!dark.remedy.includes(bad), `leaked path in remedy: ${dark.remedy}`);
});

test("loadConfig on a bare application project boots with every family dark", () => {
  // The P2 contract: no ecosystem checkout anywhere, no EXERIS_* set at all.
  const cfg = loadZeroCheckout({});
  assert.equal(cfg.mode, "app");
  assert.equal(cfg.modeSource, "probe");
  assert.equal(cfg.ecosystemRoot, null);
  for (const family of [cfg.docs, cfg.lsp, cfg.kernel]) {
    const dark = darkOf(family);
    assert.ok(dark.reason.length > 0);
    assert.ok(dark.remedy.length > 0);
  }
  // The expected-state wording must not read as a fault.
  assert.match(darkOf(cfg.docs).reason, /application-developer mode/);
});

test("loadConfig with the real process environment does not throw", () => {
  assert.doesNotThrow(() => loadConfig());
});

// ---------------------------------------------------------------------------
// EXERIS_BRIDGE_MODE

test("mode probes to contributor when the docs root resolves", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs() });
  assert.equal(cfg.mode, "contributor");
  assert.equal(cfg.modeSource, "probe");
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
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_BRIDGE_MODE: "app" });
  assert.equal(cfg.mode, "app");
  assert.equal(cfg.modeSource, "env");
  assert.equal(cfg.docs.state, "available");
});

test("EXERIS_BRIDGE_MODE=auto and blank both mean probe", () => {
  const docs = withDocs();
  for (const value of ["auto", "  AUTO  ", "", "   "]) {
    const cfg = loadConfig({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: value });
    assert.equal(cfg.modeSource, "probe", `for ${JSON.stringify(value)}`);
  }
});

test("an unrecognised EXERIS_BRIDGE_MODE warns and falls back to auto", () => {
  const docs = withDocs();
  const { value: cfg, stderr } = captureStderr(() =>
    loadConfig({ EXERIS_DOCS_ROOT: docs, EXERIS_BRIDGE_MODE: "contrib" }),
  );
  assert.equal(cfg.modeSource, "probe");
  assert.equal(cfg.mode, "contributor");
  assert.match(stderr, /EXERIS_BRIDGE_MODE must be one of/);
});

// ---------------------------------------------------------------------------
// lsp launch spec

test("lsp config defaults to the sibling exeris-platform Maven invocation", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs() });
  const lsp = lspOf(cfg);
  assert.equal(lsp.command, "mvn");
  assert.equal(lsp.source, "source-tree");
  assert.ok(lsp.args.includes("exec:java"));
  // The -f pom path is anchored under ecosystemRoot (= dirname(docsRoot)).
  assert.ok(
    lsp.args.some((a) => a.endsWith("exeris-platform/exeris-platform-lsp/pom.xml")),
    `expected a pom path in args, got ${JSON.stringify(lsp.args)}`,
  );
  assert.ok(lsp.args.some((a) => a.startsWith(work)));
});

test("EXERIS_LSP_COMMAND overrides the default, split on whitespace", () => {
  const cfg = loadConfig({
    EXERIS_DOCS_ROOT: withDocs(),
    EXERIS_LSP_COMMAND: "  node   /opt/lsp/server.js   --stdio  ",
  });
  const lsp = lspOf(cfg);
  assert.equal(lsp.command, "node");
  assert.deepEqual(lsp.args, ["/opt/lsp/server.js", "--stdio"]);
  assert.equal(lsp.source, "env-command");
});

test("a blank EXERIS_LSP_COMMAND falls back to the default", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_LSP_COMMAND: "   " });
  assert.equal(lspOf(cfg).command, "mvn");
  assert.equal(lspOf(cfg).source, "source-tree");
});

test("lsp:* goes dark with no command and no ecosystem checkout to build from", () => {
  const dark = darkOf(loadZeroCheckout({}).lsp);
  assert.match(dark.reason, /exeris-platform-lsp/);
  assert.match(dark.reason, /EXERIS_LSP_COMMAND is unset/);
  assert.match(dark.remedy, /EXERIS_LSP_COMMAND/);
});

test("EXERIS_LSP_COMMAND alone keeps lsp:* live with no checkout at all", () => {
  // A P2 who points the bridge at a downloaded jar gets the family, even
  // though docs:* and kernel:* stay dark.
  const cfg = loadZeroCheckout({ EXERIS_LSP_COMMAND: "java -jar /opt/lsp.jar" });
  assert.equal(lspOf(cfg).source, "env-command");
  assert.equal(cfg.docs.state, "unavailable");
  assert.equal(cfg.kernel.state, "unavailable");
});

// ---------------------------------------------------------------------------
// kernel launch spec

test("kernel config defaults to the sibling exeris-kernel diagnostics-CLI Maven invocation", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs() });
  const kernel = kernelOf(cfg);
  assert.equal(kernel.command, "mvn");
  assert.equal(kernel.source, "source-tree");
  assert.ok(kernel.args.includes("exec:java"));
  // The CLI main class is passed explicitly (the module pom has no exec config).
  assert.ok(
    kernel.args.some((a) => a === "-Dexec.mainClass=eu.exeris.kernel.diagnostics.cli.DiagnosticsCli"),
    `expected the CLI main class in args, got ${JSON.stringify(kernel.args)}`,
  );
  assert.ok(
    kernel.args.some((a) => a.endsWith("exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml")),
    `expected a pom path in args, got ${JSON.stringify(kernel.args)}`,
  );
  assert.ok(kernel.args.some((a) => a.startsWith(work)));
});

test("EXERIS_KERNEL_COMMAND overrides the default, split on whitespace", () => {
  const cfg = loadConfig({
    EXERIS_DOCS_ROOT: withDocs(),
    EXERIS_KERNEL_COMMAND: "  java   -jar   /opt/diag-cli.jar  ",
  });
  const kernel = kernelOf(cfg);
  assert.equal(kernel.command, "java");
  assert.deepEqual(kernel.args, ["-jar", "/opt/diag-cli.jar"]);
  assert.equal(kernel.source, "env-command");
});

test("a blank EXERIS_KERNEL_COMMAND falls back to the default", () => {
  const cfg = loadConfig({ EXERIS_DOCS_ROOT: withDocs(), EXERIS_KERNEL_COMMAND: "   " });
  assert.equal(kernelOf(cfg).command, "mvn");
  assert.equal(kernelOf(cfg).source, "source-tree");
});

test("kernel:* goes dark with no command and no ecosystem checkout to build from", () => {
  const dark = darkOf(loadZeroCheckout({}).kernel);
  assert.match(dark.reason, /exeris-kernel-diagnostics-cli/);
  assert.match(dark.reason, /EXERIS_KERNEL_COMMAND is unset/);
  assert.match(dark.remedy, /EXERIS_KERNEL_COMMAND/);
});

// ---------------------------------------------------------------------------
// lsp workspace

test("EXERIS_LSP_WORKSPACE sets the LSP workspace root; cwd is the default", () => {
  const docs = withDocs();
  const ws = join(work, "workspace");
  mkdirSync(ws);
  assert.equal(lspOf(loadConfig({ EXERIS_DOCS_ROOT: docs, EXERIS_LSP_WORKSPACE: ws })).workspaceRoot, ws);
  assert.equal(lspOf(loadConfig({ EXERIS_DOCS_ROOT: docs })).workspaceRoot, process.cwd());
  assert.equal(
    lspOf(loadConfig({ EXERIS_DOCS_ROOT: docs, EXERIS_LSP_WORKSPACE: "   " })).workspaceRoot,
    process.cwd(),
  );
});

test("a missing explicit EXERIS_LSP_WORKSPACE warns on stderr but does not throw", () => {
  const docs = withDocs();
  const gone = missing("does-not-exist");

  const { value: cfg, stderr } = captureStderr(() =>
    loadConfig({ EXERIS_DOCS_ROOT: docs, EXERIS_LSP_WORKSPACE: gone }),
  );
  // The bad path is still honoured (the server will return an empty index)...
  assert.equal(lspOf(cfg).workspaceRoot, gone);
  // ...but the operator gets a diagnosable warning naming the path.
  assert.match(stderr, /EXERIS_LSP_WORKSPACE is not an existing directory/);
  assert.match(stderr, /empty index/);

  // The default (cwd, which exists) must stay silent.
  const { stderr: silent } = captureStderr(() => loadConfig({ EXERIS_DOCS_ROOT: docs }));
  assert.equal(silent, "");
});
