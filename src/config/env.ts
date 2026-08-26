import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Config resolution for the two personas the bridge serves (ADR-025,
// 2026-08-16 "Two Personas" amendment):
//
//   P1 — ecosystem contributor: every sibling repo on disk; docs:* / lsp:* /
//        kernel:* all live; the path-sandbox is anchored on the ecosystem root.
//   P2 — application developer: NO ecosystem checkout at all — a Maven
//        dependency on eu.exeris:* and their own sources, nothing else.
//
// Zero-checkout is a hard requirement, not a nicety, so loadConfig() NEVER
// throws. A root that does not resolve disables its family with a structured
// reason + remedy and the server still boots and still serves the families
// that did resolve.
//
// What does NOT vary with the environment is the tool *surface*: tools/list is
// identical on a full checkout and on a bare application project, because 1.0
// freezes it under semver and MCP clients cache it. Only whether a call
// succeeds varies — see src/tools/unavailable.ts.
//
// The path-sandbox is still anchored on a single ecosystem root, derived as
// dirname(docsRoot) rather than from a second env var, because the ADR registry
// links into ../exeris-kernel/…, ../exeris-sdk/… (v0.2.0 locked decision).

/** Which persona the current environment looks like. */
export type BridgeMode = "contributor" | "app";

/**
 * How a child-process launch spec was arrived at. The 0.5.0 ladder adds
 * further rungs (a published jar, a local Maven repository probe); this union
 * is the closed set of rungs that exist today, and `bridge:health` reports it.
 */
export type LaunchSource = "env-command" | "source-tree";

/** The tool families whose availability depends on the environment. */
export type ToolFamily = "docs" | "lsp" | "kernel";

/**
 * A family that cannot serve requests in this environment.
 *
 * Both strings are agent-facing — every tool in a dark family returns them,
 * and `bridge:health` lists them — so NEITHER may embed an absolute path.
 * Operator paths go to stderr, never onto the wire. This is the same
 * discipline SandboxEscapeError follows by keeping paths out of `.message`.
 */
export interface Unavailable {
  readonly state: "unavailable";
  /** Why the family is dark, in one sentence. */
  readonly reason: string;
  /** The single most useful thing the operator can do about it. */
  readonly remedy: string;
}

/** The two roots every docs:* read is anchored on. */
export interface DocsRoots {
  /** Absolute, realpath-resolved path to the exeris-docs checkout. */
  readonly docsRoot: string;
  /** Absolute, realpath-resolved path to the parent of docsRoot (= sibling-repo root). */
  readonly ecosystemRoot: string;
}

/** Resolved docs:* configuration. */
export interface DocsConfig extends DocsRoots {
  readonly state: "available";
}

/**
 * Launch spec for the LSP child process. Structurally compatible with the
 * transport layer's LspLaunchSpec (command + args); `source` is provenance for
 * bridge:health and is ignored by the spawner.
 */
export interface LspConfig {
  readonly state: "available";
  readonly command: string;
  readonly args: readonly string[];
  readonly source: LaunchSource;
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
 * provenance for bridge:health and is ignored by the spawner.
 */
export interface KernelConfig {
  readonly state: "available";
  readonly command: string;
  readonly args: readonly string[];
  readonly source: LaunchSource;
}

export interface BridgeConfig {
  /** The persona this environment looks like. Descriptive — see below. */
  readonly mode: BridgeMode;
  /** "env" when EXERIS_BRIDGE_MODE pinned the mode, "probe" when it was inferred. */
  readonly modeSource: "env" | "probe";
  /**
   * Parent of the docs checkout, or null in zero-checkout mode. Optional by
   * contract: never assume it exists.
   */
  readonly ecosystemRoot: string | null;
  readonly docs: DocsConfig | Unavailable;
  readonly lsp: LspConfig | Unavailable;
  readonly kernel: KernelConfig | Unavailable;
}

const DEFAULT_DOCS_DIRNAME = "exeris-docs";
const LSP_POM_RELATIVE = "exeris-platform/exeris-platform-lsp/pom.xml";
const KERNEL_CLI_POM_RELATIVE = "exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml";
const KERNEL_CLI_MAIN_CLASS = "eu.exeris.kernel.diagnostics.cli.DiagnosticsCli";

/**
 * Resolve the bridge runtime config from the process environment.
 *
 * NEVER throws — see the file header. Every failure to resolve a root becomes
 * an `Unavailable` on the family it belongs to.
 *
 * `mode` is DESCRIPTIVE, not a mask: it records which persona the environment
 * looks like and is reported by bridge:health, but it does not switch families
 * off. Availability has exactly one source of truth — whether the family's
 * dependency resolved. A contributor who pins `app` still gets docs:* if
 * exeris-docs is on disk; pinning only changes the wording of a family's
 * `reason` (a pinned contributor whose roots are missing is a misconfiguration
 * to report, not a silent downgrade to app mode).
 *
 * The `env` and `defaultRoot` parameters are injectable for tests. Injecting
 * the install-neighbour default is what makes the zero-checkout branch
 * reachable from a test run that is itself sitting inside an ecosystem
 * checkout, where the real default resolves.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultRoot: string = defaultDocsRoot(),
): BridgeConfig {
  const pinned = resolvePinnedMode(env);
  const docs = resolveDocsConfig(env, pinned, defaultRoot);
  const ecosystemRoot = docs.state === "available" ? docs.ecosystemRoot : null;
  return {
    mode: pinned ?? (docs.state === "available" ? "contributor" : "app"),
    modeSource: pinned === null ? "probe" : "env",
    ecosystemRoot,
    docs,
    lsp: resolveLspConfig(env, ecosystemRoot, pinned),
    kernel: resolveKernelConfig(env, ecosystemRoot, pinned),
  };
}

/**
 * Read EXERIS_BRIDGE_MODE. `auto` (or unset) means "infer from what resolved".
 * An unrecognised value warns and falls back to auto rather than throwing —
 * a typo in an operator's MCP client config must not take the server down.
 */
function resolvePinnedMode(env: NodeJS.ProcessEnv): BridgeMode | null {
  const raw = env.EXERIS_BRIDGE_MODE?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0 || raw === "auto") return null;
  if (raw === "contributor" || raw === "app") return raw;
  warn(
    `EXERIS_BRIDGE_MODE must be one of auto, contributor, app — got ${JSON.stringify(raw)}; ` +
      `falling back to auto.`,
  );
  return null;
}

/**
 * Resolve the docs roots from `EXERIS_DOCS_ROOT`, falling back to the
 * install-neighbour layout (`../exeris-docs` relative to the package root).
 *
 * Three distinct dark cases, deliberately worded differently: an explicitly
 * configured root that does not resolve is an operator error; a missing
 * default under pinned contributor mode is a misconfiguration; a missing
 * default otherwise is the expected P2 state and must not read as a fault.
 */
function resolveDocsConfig(
  env: NodeJS.ProcessEnv,
  pinned: BridgeMode | null,
  defaultRoot: string,
): DocsConfig | Unavailable {
  const explicit = env.EXERIS_DOCS_ROOT?.trim();
  const configured = explicit !== undefined && explicit.length > 0 ? explicit : null;
  const real = resolveRealDir(configured ?? defaultRoot);
  if (real !== null) {
    return { state: "available", docsRoot: real, ecosystemRoot: dirname(real) };
  }
  if (configured !== null) {
    warn(`EXERIS_DOCS_ROOT does not resolve to a readable directory: ${configured} — docs:* is unavailable.`);
    return {
      state: "unavailable",
      reason: "EXERIS_DOCS_ROOT is set but does not resolve to a readable directory.",
      remedy:
        "Point EXERIS_DOCS_ROOT at an exeris-docs checkout. The path that failed to resolve is on the bridge's stderr.",
    };
  }
  if (pinned === "contributor") {
    warn(
      "EXERIS_BRIDGE_MODE=contributor, but no exeris-docs checkout was found next to the bridge " +
        "installation — docs:* is unavailable.",
    );
    return {
      state: "unavailable",
      reason:
        "EXERIS_BRIDGE_MODE pins contributor mode, but no exeris-docs checkout was found next to the bridge installation.",
      remedy:
        "Set EXERIS_DOCS_ROOT to an exeris-docs checkout, or unset EXERIS_BRIDGE_MODE to run in application-developer mode.",
    };
  }
  return {
    state: "unavailable",
    reason:
      "No exeris-docs checkout is present. The bridge is running in application-developer mode, where the ecosystem documentation registry is not expected on disk.",
    remedy:
      "Set EXERIS_DOCS_ROOT to an exeris-docs checkout if you are working on the Exeris ecosystem itself.",
  };
}

/**
 * Resolve the LSP launch spec from `EXERIS_LSP_COMMAND`, falling back to a
 * Maven invocation against the sibling exeris-platform module when there is an
 * ecosystem checkout to run it from.
 *
 * The env var is split on whitespace into command + args — it does NOT honour
 * shell quoting or globbing (no shell is involved; the spawner exec's the
 * command directly). A value whose first token would be empty is treated as
 * unset. The path-sandbox does not apply here: this is an operator-supplied
 * executable, not an agent-supplied path, and it is never derived from a tool
 * argument.
 */
function resolveLspConfig(
  env: NodeJS.ProcessEnv,
  ecosystemRoot: string | null,
  pinned: BridgeMode | null,
): LspConfig | Unavailable {
  const explicitWorkspace = env.EXERIS_LSP_WORKSPACE?.trim();
  const workspaceRoot = explicitWorkspace || process.cwd();
  // An empty workspace is legal (a project with no @ExerisDomain sources yet),
  // so a missing root must NOT throw — but a misspelled EXERIS_LSP_WORKSPACE
  // would otherwise yield a silent empty index that looks like "no domains".
  // Warn to stderr (never stdout — that channel is JSON-RPC) when an explicitly
  // set root does not resolve to a directory, so the `[]` is diagnosable.
  if (explicitWorkspace && !isExistingDir(workspaceRoot)) {
    warn(
      `EXERIS_LSP_WORKSPACE is not an existing directory: ${workspaceRoot} — ` +
        `lsp:* tools will return an empty index.`,
    );
  }
  const raw = env.EXERIS_LSP_COMMAND?.trim();
  if (raw !== undefined && raw.length > 0) {
    const tokens = raw.split(/\s+/);
    return { state: "available", command: tokens[0], args: tokens.slice(1), source: "env-command", workspaceRoot };
  }
  if (ecosystemRoot === null) {
    return noLaunchSpec("lsp", pinned);
  }
  // `-q` silences Maven's own [INFO]/[WARNING] lines, which would otherwise
  // land on the same stdout the framing decoder reads and desync it. The
  // server (exeris-platform-lsp, LspMain) writes JSON-RPC frames to stdout and
  // logs to stderr, so with `-q` the framing channel stays clean. If a given
  // environment still leaks Maven output onto stdout, switch this default to a
  // clean channel (`exec:exec` with stdout reserved for JSON-RPC, or launch the
  // built jar directly) — the integration test (ROADMAP 0.3.0) exercises this.
  return {
    state: "available",
    command: "mvn",
    args: ["-q", "-f", join(ecosystemRoot, LSP_POM_RELATIVE), "exec:java"],
    source: "source-tree",
    workspaceRoot,
  };
}

/**
 * Resolve the kernel diagnostics CLI launch spec from `EXERIS_KERNEL_COMMAND`,
 * falling back to a Maven invocation against the sibling exeris-kernel CLI
 * module when there is an ecosystem checkout to run it from. Same
 * whitespace-split / no-shell-quoting rules as the LSP command, and likewise
 * NOT an agent-supplied path.
 */
function resolveKernelConfig(
  env: NodeJS.ProcessEnv,
  ecosystemRoot: string | null,
  pinned: BridgeMode | null,
): KernelConfig | Unavailable {
  const raw = env.EXERIS_KERNEL_COMMAND?.trim();
  if (raw !== undefined && raw.length > 0) {
    const tokens = raw.split(/\s+/);
    return { state: "available", command: tokens[0], args: tokens.slice(1), source: "env-command" };
  }
  if (ecosystemRoot === null) {
    return noLaunchSpec("kernel", pinned);
  }
  // As with the LSP default, `-q` keeps Maven's own logging off the NDJSON
  // stdout (the CLI writes responses to stdout, JVM/Maven logs to stderr).
  // `exec:java` does not require the exec plugin in the module pom — the main
  // class is passed explicitly. A pre-built shaded jar (`java -jar
  // …/exeris-kernel-diagnostics-cli-<ver>.jar`) is the faster documented
  // override via EXERIS_KERNEL_COMMAND.
  return {
    state: "available",
    command: "mvn",
    args: [
      "-q",
      "-f",
      join(ecosystemRoot, KERNEL_CLI_POM_RELATIVE),
      "exec:java",
      `-Dexec.mainClass=${KERNEL_CLI_MAIN_CLASS}`,
    ],
    source: "source-tree",
  };
}

/** Per-family wording for "there is nothing to launch". */
const CHILD_FAMILIES: Record<"lsp" | "kernel", { artefact: string; envVar: string }> = {
  lsp: { artefact: "exeris-platform-lsp", envVar: "EXERIS_LSP_COMMAND" },
  kernel: { artefact: "exeris-kernel-diagnostics-cli", envVar: "EXERIS_KERNEL_COMMAND" },
};

/**
 * The dark state for a child-process family: no explicit command and no
 * ecosystem checkout to build one from. This is the ordinary P2 state for both
 * families today; the 0.5.0 launch ladder will fill it in from a published
 * artefact in the local Maven repository.
 */
function noLaunchSpec(family: "lsp" | "kernel", pinned: BridgeMode | null): Unavailable {
  const { artefact, envVar } = CHILD_FAMILIES[family];
  const reason =
    pinned === "contributor"
      ? `EXERIS_BRIDGE_MODE pins contributor mode, but ${envVar} is unset and there is no ecosystem checkout to run ${artefact} from.`
      : `No launch spec for ${artefact}: ${envVar} is unset and there is no ecosystem checkout to run it from.`;
  return {
    state: "unavailable",
    reason,
    remedy:
      `Set ${envVar} to a command that starts ${artefact} on stdio (for example a "java -jar …" invocation), ` +
      `or run the bridge from an ecosystem checkout so it can build ${artefact} from source.`,
  };
}

/**
 * Locate the default exeris-docs checkout: sibling of the bridge install root.
 *
 * After build, this file lives at `dist/config/env.js`. Walking up three
 * levels (`config → dist → package root → ecosystem`) lands at the parent
 * directory; appending the docs dirname yields the sibling checkout. Local
 * dev (cloning under `~/exeris-systems/`) gets this for free; an
 * npm-installed deployment resolves it inside `node_modules/@exeris/`, where
 * no such sibling exists — which is exactly the zero-checkout case.
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

/**
 * Realpath-resolve `path` and return it only if it is an existing directory.
 * Returns null for every failure mode (missing, unreadable, a file rather than
 * a directory) — the caller turns that into a family-level `Unavailable`.
 */
function resolveRealDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Operator-facing diagnostic. stderr only — stdout is the MCP channel. */
function warn(message: string): void {
  process.stderr.write(`[exeris-ai-bridge] warning: ${message}\n`);
}
