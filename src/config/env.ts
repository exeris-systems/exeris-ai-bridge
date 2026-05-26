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
}

const DEFAULT_DOCS_DIRNAME = "exeris-docs";

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
  return { docsRoot, ecosystemRoot };
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
