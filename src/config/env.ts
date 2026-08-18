import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Per the v0.2.0 locked decision (ADR-025 + project memory): the path-sandbox
// is anchored on a single ecosystem root that covers exeris-docs AND its
// sibling repos, because the ADR registry links into ../exeris-kernel/...,
// ../exeris-sdk/..., etc. The bridge derives ecosystemRoot = dirname(docsRoot)
// rather than introducing a second env var.

export interface BridgeConfig {
  /** Absolute, realpath-resolved path to the exeris-docs checkout. */
  readonly docsRoot: string;
  /** Absolute, realpath-resolved path to the parent of docsRoot (= sibling-repo root). */
  readonly ecosystemRoot: string;
  /** How to launch the exeris-platform-lsp child for the lsp:* family. */
  readonly lsp: LspConfig;
  /** How to launch the exeris-kernel-diagnostics-cli child for the kernel:* family. */
  readonly kernel: KernelConfig;
}

/**
 * Launch spec for the LSP child process. Structurally compatible with the
 * transport layer's LspLaunchSpec (command + args); `source` is debug
 * provenance for bridge:version (0.5.0) and is ignored by the spawner.
 */
export interface LspConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "env" | "default";
  /**
   * Workspace root the LSP server indexes for `@ExerisDomain` sources, sent as
   * `rootUri` in the `initialize` handshake. The server walks this tree at
   * initialize time; with no root it returns an empty index. Defaults to the
   * bridge's cwd (the project it was spawned in); override with
   * `EXERIS_LSP_WORKSPACE`.
   */
  readonly workspaceRoot: string;
}

/**
 * Launch spec for the kernel diagnostics CLI child. Structurally compatible
 * with the transport layer's KernelLaunchSpec (command + args); `source` is
 * debug provenance for bridge:version (0.5.0) and is ignored by the spawner.
 */
export interface KernelConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "env" | "default";
}

const DEFAULT_DOCS_DIRNAME = "exeris-docs";
const LSP_POM_RELATIVE = "exeris-platform/exeris-platform-lsp/pom.xml";
const KERNEL_CLI_POM_RELATIVE = "exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml";
const KERNEL_CLI_MAIN_CLASS = "eu.exeris.kernel.diagnostics.cli.DiagnosticsCli";

/**
 * Resolve the bridge runtime config from the process environment.
 *
 * Honours `EXERIS_DOCS_ROOT`; falls back to the monorepo-neighbour layout
 * (`../exeris-docs` relative to the package install root). Fails fast if the
 * resolved path does not refer to an existing readable directory.
 *
 * The `env` parameter is injectable for tests.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const candidate = env.EXERIS_DOCS_ROOT ?? defaultDocsRoot();
  const docsRoot = resolveExistingDir(candidate, "EXERIS_DOCS_ROOT");
  const ecosystemRoot = dirname(docsRoot);
  const lsp = resolveLspConfig(env, ecosystemRoot);
  const kernel = resolveKernelConfig(env, ecosystemRoot);
  return { docsRoot, ecosystemRoot, lsp, kernel };
}

/**
 * Resolve the kernel diagnostics CLI launch spec from `EXERIS_KERNEL_COMMAND`,
 * falling back to a Maven invocation against the sibling exeris-kernel CLI
 * module. Same whitespace-split / no-shell-quoting rules as the LSP command,
 * and likewise NOT an agent-supplied path: it is an operator-supplied
 * executable, never derived from a tool argument, so the path-sandbox does not
 * apply.
 */
function resolveKernelConfig(env: NodeJS.ProcessEnv, ecosystemRoot: string): KernelConfig {
  const raw = env.EXERIS_KERNEL_COMMAND?.trim();
  if (raw !== undefined && raw.length > 0) {
    const tokens = raw.split(/\s+/);
    return { command: tokens[0], args: tokens.slice(1), source: "env" };
  }
  // Default: run the CLI's main class via Maven against the sibling module. As
  // with the LSP default, `-q` keeps Maven's own logging off the NDJSON stdout
  // (the CLI writes responses to stdout, JVM/Maven logs to stderr). `exec:java`
  // does not require the exec plugin in the module pom — the main class is
  // passed explicitly. A pre-built shaded jar (`java -jar
  // …/exeris-kernel-diagnostics-cli-<ver>.jar`) is the faster documented
  // override via EXERIS_KERNEL_COMMAND.
  return {
    command: "mvn",
    args: [
      "-q",
      "-f",
      join(ecosystemRoot, KERNEL_CLI_POM_RELATIVE),
      "exec:java",
      `-Dexec.mainClass=${KERNEL_CLI_MAIN_CLASS}`,
    ],
    source: "default",
  };
}

/**
 * Resolve the LSP launch spec from `EXERIS_LSP_COMMAND`, falling back to the
 * monorepo-neighbour Maven invocation against the sibling exeris-platform.
 *
 * The env var is split on whitespace into command + args — it does NOT honour
 * shell quoting or globbing (no shell is involved; the spawner exec's the
 * command directly). A value whose first token would be empty is treated as
 * unset. The path-sandbox does not apply here: this is an operator-supplied
 * executable, not an agent-supplied path, and it is never derived from a
 * tool argument.
 */
function resolveLspConfig(env: NodeJS.ProcessEnv, ecosystemRoot: string): LspConfig {
  const explicitWorkspace = env.EXERIS_LSP_WORKSPACE?.trim();
  const workspaceRoot = explicitWorkspace || process.cwd();
  // An empty workspace is legal (a project with no @ExerisDomain sources yet),
  // so a missing root must NOT throw — but a misspelled EXERIS_LSP_WORKSPACE
  // would otherwise yield a silent empty index that looks like "no domains".
  // Warn to stderr (never stdout — that channel is JSON-RPC) when an explicitly
  // set root does not resolve to a directory, so the `[]` is diagnosable.
  if (explicitWorkspace && !isExistingDir(workspaceRoot)) {
    process.stderr.write(
      `[exeris-ai-bridge] warning: EXERIS_LSP_WORKSPACE is not an existing directory: ` +
        `${workspaceRoot} — lsp:* tools will return an empty index.\n`,
    );
  }
  const raw = env.EXERIS_LSP_COMMAND?.trim();
  if (raw !== undefined && raw.length > 0) {
    const tokens = raw.split(/\s+/);
    return { command: tokens[0], args: tokens.slice(1), source: "env", workspaceRoot };
  }
  // `-q` silences Maven's own [INFO]/[WARNING] lines, which would otherwise
  // land on the same stdout the framing decoder reads and desync it. The
  // server (exeris-platform-lsp, LspMain) writes JSON-RPC frames to stdout and
  // logs to stderr, so with `-q` the framing channel stays clean. If a given
  // environment still leaks Maven output onto stdout, switch this default to a
  // clean channel (`exec:exec` with stdout reserved for JSON-RPC, or launch the
  // built jar directly) — the integration test (ROADMAP 0.3.0) exercises this.
  return {
    command: "mvn",
    args: ["-q", "-f", join(ecosystemRoot, LSP_POM_RELATIVE), "exec:java"],
    source: "default",
    workspaceRoot,
  };
}

/**
 * Locate the default exeris-docs checkout: sibling of the bridge install root.
 *
 * After build, this file lives at `dist/config/env.js`. Walking up three
 * levels (`config → dist → package root → ecosystem`) lands at the parent
 * directory; appending the docs dirname yields the sibling checkout. Local
 * dev (cloning under `~/exeris-systems/`) gets this for free; npm-installed
 * deployments must set `EXERIS_DOCS_ROOT` explicitly.
 */
function defaultDocsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", DEFAULT_DOCS_DIRNAME);
}

/** Non-throwing existence+directory probe for warn-only diagnostics. */
function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveExistingDir(path: string, envName: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch (cause) {
    throw new Error(
      `${envName} does not resolve to an existing path: ${path}`,
      { cause },
    );
  }
  let stat;
  try {
    stat = statSync(real);
  } catch (cause) {
    throw new Error(`${envName} could not be stat'd: ${real}`, { cause });
  }
  if (!stat.isDirectory()) {
    throw new Error(`${envName} must point at a directory, not a file: ${real}`);
  }
  return real;
}
