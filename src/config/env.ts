import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findArtifactJar, newestReleaseVersion, resolveLocalRepository, type MavenCoordinate } from "./maven.js";

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
 * Which rung of the launch ladder produced a child's spec. Ordered by
 * precedence, first hit wins, and `bridge-health` reports which one fired:
 *
 *   env-command  EXERIS_*_COMMAND — a full command line; the escape hatch
 *   env-jar      EXERIS_*_JAR     — a jar this machine already has
 *   m2           a published jar in the local Maven repository, by coordinate
 *   source-tree  mvn against a sibling module, contributor mode only
 *
 * No rung touches the network. `m2` is what makes the family reachable for an
 * application developer with no checkout.
 */
export type LaunchSource = "env-command" | "env-jar" | "m2" | "source-tree";

/** The tool families whose availability depends on the environment. */
export type ToolFamily = "docs" | "lsp" | "kernel";

/**
 * A family that cannot serve requests in this environment.
 *
 * Both strings are agent-facing — every tool in a dark family returns them,
 * and `bridge-health` lists them — so NEITHER may embed an absolute path.
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
  /** The artifact version, when the spec came from the local Maven repository. */
  readonly artifactVersion?: string;
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
  /** The artifact version, when the spec came from the local Maven repository. */
  readonly artifactVersion?: string;
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
  const mode = pinned ?? (docs.state === "available" ? "contributor" : "app");
  warnIfLocalRepositoryUnresolvable(env);
  const launch: LaunchContext = { env, ecosystemRoot, mode, pinned };
  return {
    mode,
    modeSource: pinned === null ? "probe" : "env",
    ecosystemRoot,
    docs,
    lsp: resolveLspConfig(env, launch),
    kernel: resolveChildLaunch("kernel", launch),
  };
}

/** Everything the launch ladder needs, resolved before the children are. */
interface LaunchContext {
  readonly env: NodeJS.ProcessEnv;
  readonly ecosystemRoot: string | null;
  readonly mode: BridgeMode;
  readonly pinned: BridgeMode | null;
}

/**
 * EXERIS_MAVEN_REPO is the one explicitly-set path here whose failure would
 * otherwise be silent: an unresolvable value simply switches the local
 * repository rung off, which is indistinguishable from a machine that does not
 * have the artifact installed. Every other explicit path in this file already
 * warns when it does not resolve; this closes the gap.
 *
 * Warned once, from here rather than per-family, because the variable is global
 * to the ladder — two families probing must not produce two warnings.
 */
function warnIfLocalRepositoryUnresolvable(env: NodeJS.ProcessEnv): void {
  const configured = env.EXERIS_MAVEN_REPO?.trim();
  if (configured === undefined || configured.length === 0) return;
  if (resolveLocalRepository(env) !== null) return;
  warn(
    `EXERIS_MAVEN_REPO is not an existing directory: ${configured} — the local ` +
      `Maven repository rung of the launch ladder is disabled.`,
  );
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
 * Resolve the LSP launch spec. The ladder itself lives in resolveChildLaunch;
 * this adds the workspace root, which is lsp-specific.
 *
 * The env vars are split on whitespace into command + args — they do NOT honour
 * shell quoting or globbing (no shell is involved; the spawner exec's the
 * command directly). None of this is agent-supplied: these are operator-supplied
 * executables, never derived from a tool argument, so the path-sandbox does not
 * apply.
 */
function resolveLspConfig(env: NodeJS.ProcessEnv, launch: LaunchContext): LspConfig | Unavailable {
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
  const resolved = resolveChildLaunch("lsp", launch);
  if (resolved.state === "unavailable") return resolved;
  return { ...resolved, workspaceRoot };
}

type ChildFamily = "lsp" | "kernel";

interface ChildFamilySpec {
  /** What the child is, in operator-facing prose. */
  readonly artefact: string;
  readonly commandVar: string;
  readonly jarVar: string;
  readonly versionVar: string;
  /** Module pom, relative to the ecosystem root, for the source-tree rung. */
  readonly pomRelative: string;
  /** Extra Maven args the source-tree rung needs beyond `exec:java`. */
  readonly mavenArgs: readonly string[];
  /**
   * The executable artifact to probe for in the local Maven repository, and the
   * artifact whose newest release names the version — or null when no published
   * artifact is launchable yet, which skips the rung entirely.
   */
  readonly artifact: { readonly target: MavenCoordinate; readonly versionAnchor: MavenCoordinate } | null;
}

// Both children are Java, both are launched the same four ways, and they differ
// only in these values.
//
// NEITHER gets --enable-preview, and the reason is version history rather than
// a blanket rule. exeris-kernel went preview-clean at 0.11.0 — its root pom now
// binds preview to the test-compile execution and the surefire JVM only, citing
// ADR-066 ("the DISTRIBUTED artifact is preview-clean"). Scanning the published
// shaded jars confirms the boundary exactly: 0.10.2 carries 12 preview-stamped
// classes out of 799, and 0.11.0 carries 0 out of 897. exeris-platform uses no
// preview at all.
//
// So the flag is NOT passed, and a pre-0.11.0 kernel jar is out of scope for the
// jar rungs. That is deliberate: adding version-conditional flags would encode
// upstream release history in this file, and the failure is already loud and
// self-describing — the JVM answers "Preview features are not enabled … Try
// running with '--enable-preview'", which the transport surfaces verbatim. An
// operator on an older jar uses EXERIS_KERNEL_COMMAND, which takes a full
// command line for exactly this reason.
//
// The remaining asymmetry is executability: the kernel CLI is published shaded
// with Main-Class in the manifest, so its m2 rung works. The LSP jar is not
// executable, so lsp:* has no m2 rung until the companion shading ask lands
// upstream (ROADMAP cross-repo table, 0.5.0); EXERIS_LSP_JAR still serves
// anyone who builds a runnable jar themselves.
const CHILD_FAMILIES: Record<ChildFamily, ChildFamilySpec> = {
  lsp: {
    artefact: "exeris-platform-lsp",
    commandVar: "EXERIS_LSP_COMMAND",
    jarVar: "EXERIS_LSP_JAR",
    versionVar: "EXERIS_LSP_VERSION",
    pomRelative: "exeris-platform/exeris-platform-lsp/pom.xml",
    mavenArgs: [],
    artifact: null,
  },
  kernel: {
    artefact: "exeris-kernel-diagnostics-cli",
    commandVar: "EXERIS_KERNEL_COMMAND",
    jarVar: "EXERIS_KERNEL_JAR",
    versionVar: "EXERIS_KERNEL_VERSION",
    pomRelative: "exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml",
    mavenArgs: [`-Dexec.mainClass=eu.exeris.kernel.diagnostics.cli.DiagnosticsCli`],
    artifact: {
      target: { groupId: "eu.exeris", artifactId: "exeris-kernel-diagnostics-cli" },
      versionAnchor: { groupId: "eu.exeris", artifactId: "exeris-kernel-core" },
    },
  },
};

interface ChildLaunch {
  readonly state: "available";
  readonly command: string;
  readonly args: readonly string[];
  readonly source: LaunchSource;
  readonly artifactVersion?: string;
}

/**
 * Walk the launch ladder for one child family. First hit wins; nothing here
 * touches the network.
 */
function resolveChildLaunch(family: ChildFamily, launch: LaunchContext): ChildLaunch | Unavailable {
  const { env, ecosystemRoot, mode, pinned } = launch;
  const spec = CHILD_FAMILIES[family];

  // Rung 1 — a full command line. The escape hatch: anything the other rungs
  // cannot express (a different JDK, an agent, a wrapper script) goes here.
  const command = env[spec.commandVar]?.trim();
  if (command !== undefined && command.length > 0) {
    const tokens = command.split(/\s+/);
    return { state: "available", command: tokens[0], args: tokens.slice(1), source: "env-command" };
  }

  // Rung 2 — a jar this machine already has. An explicitly named jar that is
  // not there takes the family dark rather than quietly falling through: the
  // operator named a mechanism, and silently using a different one would hide
  // the typo. Same stance as an unresolvable EXERIS_DOCS_ROOT.
  const jar = env[spec.jarVar]?.trim();
  if (jar !== undefined && jar.length > 0) {
    if (!isExistingFile(jar)) {
      warn(`${spec.jarVar} does not point at an existing file: ${jar} — ${family}:* is unavailable.`);
      return {
        state: "unavailable",
        reason: `${spec.jarVar} is set but does not point at an existing file.`,
        remedy:
          `Point ${spec.jarVar} at a runnable ${spec.artefact} jar, or unset it to let the bridge ` +
          `resolve one itself. The path that failed is on the bridge's stderr.`,
      };
    }
    return { state: "available", ...jarLaunch(env, jar), source: "env-jar" };
  }

  // Rungs 3 and 4 — a published jar from the local Maven repository, and a
  // build from the sibling checkout. Their ORDER depends on the mode, and this
  // is the one place mode changes behaviour rather than merely describing it:
  //
  //   contributor — the source tree wins. Someone with the checkout is working
  //     ON that tree; answering from a released jar would report the state of
  //     code they are not editing, and they would have no reason to suspect it.
  //     A slow, correct answer beats a fast, quietly stale one.
  //   app — there is usually no tree at all, and where one exists it is not
  //     what the developer is working on, so the published jar wins.
  //
  // This is preference, not gating: whichever rung is second still fires when
  // the first cannot, so availability keeps its single source of truth.
  const rungs = mode === "contributor" ? [sourceTreeRung, localRepositoryRung] : [localRepositoryRung, sourceTreeRung];
  for (const rung of rungs) {
    const hit = rung(spec, launch);
    if (hit !== null) return hit;
  }

  return noLaunchSpec(spec, ecosystemRoot, pinned);
}

/**
 * Build from the sibling checkout — only when the module is actually there. An
 * ecosystem root that predates the module would otherwise produce a spec that
 * fails at spawn time.
 *
 * `-q` silences Maven's own [INFO]/[WARNING] lines, which would otherwise land
 * on the same stdout the framing decoders read and desync them. Both children
 * write their protocol to stdout and their logs to stderr, so with `-q` the
 * channel stays clean; the integration tests exercise exactly this.
 */
function sourceTreeRung(spec: ChildFamilySpec, { ecosystemRoot }: LaunchContext): ChildLaunch | null {
  if (ecosystemRoot === null) return null;
  const pom = join(ecosystemRoot, spec.pomRelative);
  if (!isExistingFile(pom)) return null;
  return {
    state: "available",
    command: "mvn",
    args: ["-q", "-f", pom, "exec:java", ...spec.mavenArgs],
    source: "source-tree",
  };
}

/** A published jar in the local Maven repository — the rung that needs no checkout. */
function localRepositoryRung(spec: ChildFamilySpec, { env }: LaunchContext): ChildLaunch | null {
  const resolved = spec.artifact === null ? null : resolveFromLocalRepository(env, spec);
  if (resolved === null) return null;
  return {
    state: "available",
    ...jarLaunch(env, resolved.jar),
    source: "m2",
    artifactVersion: resolved.version,
  };
}

/**
 * Rung 3: find a runnable jar in the local Maven repository.
 *
 * The version comes from the newest RELEASE of the anchor artifact present in
 * that repository — NOT from the user's project dependency graph, which would
 * need a Maven invocation and therefore a network round-trip on the boot path.
 * Those usually agree, because the anchor is a dependency the project resolved.
 * When they do not, `<FAMILY>_VERSION` pins it.
 */
function resolveFromLocalRepository(
  env: NodeJS.ProcessEnv,
  spec: ChildFamilySpec,
): { jar: string; version: string } | null {
  if (spec.artifact === null) return null;
  const repo = resolveLocalRepository(env);
  if (repo === null) return null;

  const pinnedVersion = env[spec.versionVar]?.trim();
  if (pinnedVersion !== undefined && pinnedVersion.length > 0) {
    const jar = findArtifactJar(repo, spec.artifact.target, pinnedVersion);
    if (jar !== null) return { jar, version: pinnedVersion };
    // Unlike the JAR variable, this one does not name a launch mechanism — it
    // only qualifies this rung — so a miss warns and lets the ladder continue.
    warn(
      `${spec.versionVar}=${pinnedVersion} has no ${spec.artifact.target.artifactId} jar in the ` +
        `local Maven repository — continuing down the launch ladder.`,
    );
    return null;
  }

  const version = newestReleaseVersion(repo, spec.artifact.versionAnchor);
  if (version === null) return null;
  const jar = findArtifactJar(repo, spec.artifact.target, version);
  return jar === null ? null : { jar, version };
}

/**
 * The `java` binary for a jar launch. Honours JAVA_HOME — the universal
 * convention — instead of inventing an Exeris-specific variable, and otherwise
 * takes whatever is on PATH. An operator who needs more control uses rung 1,
 * which accepts a full command line.
 */
function javaCommand(env: NodeJS.ProcessEnv): string {
  const binary = process.platform === "win32" ? "java.exe" : "java";
  const home = env.JAVA_HOME?.trim();
  return home !== undefined && home.length > 0 ? join(home, "bin", binary) : binary;
}

function jarLaunch(env: NodeJS.ProcessEnv, jar: string): { command: string; args: readonly string[] } {
  return { command: javaCommand(env), args: ["-jar", jar] };
}

/**
 * The dark state for a child family: no rung fired. The remedy names the rungs
 * that could realistically be made to fire on this machine, which differs by
 * family — lsp:* has no local-repository rung until its artifact is published
 * as an executable jar.
 */
function noLaunchSpec(
  spec: ChildFamilySpec,
  ecosystemRoot: string | null,
  pinned: BridgeMode | null,
): Unavailable {
  const checkout =
    ecosystemRoot === null
      ? "there is no ecosystem checkout to build it from"
      : `the ecosystem checkout has no ${spec.pomRelative}`;
  const repoClause =
    spec.artifact === null
      ? ""
      : `, no ${spec.artifact.target.artifactId} jar was found in the local Maven repository`;
  const prefix =
    pinned === "contributor" ? "EXERIS_BRIDGE_MODE pins contributor mode, but " : "";
  const repoRemedy =
    spec.artifact === null
      ? ""
      : ` The bridge also looks for a published jar in your local Maven repository; ` +
        `"mvn dependency:get -Dartifact=${spec.artifact.target.groupId}:${spec.artifact.target.artifactId}:<version>" ` +
        `puts one there (it resolves from GitHub Packages, so it needs PACKAGES_READ_TOKEN).`;
  return {
    state: "unavailable",
    reason:
      `${prefix}no launch spec for ${spec.artefact}: ${spec.commandVar} and ${spec.jarVar} are unset` +
      `${repoClause}, and ${checkout}.`,
    remedy:
      `Set ${spec.jarVar} to a runnable ${spec.artefact} jar, or ${spec.commandVar} to a command that ` +
      `starts it on stdio.${repoRemedy}`,
  };
}

/** Non-throwing existence+file probe, for launch specs that name a jar or pom. */
function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
