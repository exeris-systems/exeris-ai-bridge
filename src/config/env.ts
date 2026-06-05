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
}

/**
 * Launch spec for the LSP child process. Structurally compatible with the
 * transport layer's LspLaunchSpec (command + args); `source` is debug
 * provenance for bridge:version (0.7.0) and is ignored by the spawner.
 */
export interface LspConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: "env" | "default";
}

const DEFAULT_DOCS_DIRNAME = "exeris-docs";
const LSP_POM_RELATIVE = "exeris-platform/exeris-platform-lsp/pom.xml";

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
  return { docsRoot, ecosystemRoot, lsp };
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
  const raw = env.EXERIS_LSP_COMMAND?.trim();
  if (raw !== undefined && raw.length > 0) {
    const tokens = raw.split(/\s+/);
    return { command: tokens[0], args: tokens.slice(1), source: "env" };
  }
  return {
    command: "mvn",
    args: ["-f", join(ecosystemRoot, LSP_POM_RELATIVE), "exec:java"],
    source: "default",
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
