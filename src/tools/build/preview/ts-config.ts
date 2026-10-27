import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { isInsideRealRoot, resolveInside, SandboxEscapeError } from "../../../fs/sandbox.js";
import { TYPESCRIPT_CONFIG_FILE_NAMES, TYPESCRIPT_L1_ROOT } from "./diff.js";

// `exeris-gen` finds its configuration from its working directory upward and has
// no flag to name it. The preview launches it in the project root, so the config
// it will read is decided here the same way, and a config that would make the
// run write somewhere other than the scratch directory, or not write at all, is
// refused rather than previewed.

const MAX_CONFIG_BYTES = 256 * 1024;

export interface TypeScriptL1 {
  readonly kind: "ok";
  /** Absolute L1 root the output is compared against. */
  readonly root: string;
  readonly source: "default" | "config";
}

export interface TypeScriptConfigRefusal {
  readonly kind: "refused";
  readonly error: string;
  readonly reason: string;
  readonly remedy: string;
}

/** The first codegen config at or above `projectRoot`, in the generator's own order. */
function findConfig(projectRoot: string): { dir: string; file: string } | null {
  let dir = resolve(projectRoot);
  for (;;) {
    for (const name of TYPESCRIPT_CONFIG_FILE_NAMES) {
      const file = join(dir, name);
      try {
        if (lstatSync(file).isFile()) return { dir, file };
      } catch {
        // Absent or unreadable: keep looking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveTypeScriptL1(projectRoot: string): TypeScriptL1 | TypeScriptConfigRefusal {
  const root = resolve(projectRoot);
  const found = findConfig(root);
  const fallback: TypeScriptL1 = { kind: "ok", root: join(root, TYPESCRIPT_L1_ROOT), source: "default" };
  if (found === null) return fallback;

  if (!isInsideRealRoot(root, found.dir)) {
    return {
      kind: "refused",
      error: "ts_config_outside_project",
      reason: `exeris-gen would read ${relative(root, found.file).split(sep).join("/")}, a codegen config above the project root, so the preview cannot say what it would do with the project's own settings.`,
      remedy: "Put the codegen config in the project root, or run exeris-gen generate yourself.",
    };
  }

  let config: { dryRun?: unknown; outputPath?: unknown } = {};
  try {
    if (lstatSync(found.file).size <= MAX_CONFIG_BYTES) {
      const parsed: unknown = JSON.parse(readFileSync(found.file, "utf8"));
      if (typeof parsed === "object" && parsed !== null) config = parsed;
    }
  } catch {
    // An unreadable config is the generator's to report; the run's own diagnostics say why.
    return fallback;
  }

  if (config.dryRun === true) {
    return {
      kind: "refused",
      error: "ts_config_dry_run",
      reason: "The project's codegen config sets dryRun, so exeris-gen would write nothing and the preview would show nothing.",
      remedy: "Remove dryRun from the codegen config (or set it to false) to preview, then restore it.",
    };
  }

  if (typeof config.outputPath === "string" && config.outputPath.length > 0) {
    const configured = resolve(root, config.outputPath);
    const escapes = {
      kind: "refused" as const,
      error: "ts_output_outside_project",
      reason: "The codegen config's outputPath points outside the project, so there is no generated tree in the project to compare against.",
      remedy: "Set outputPath to a directory inside the project, then retry.",
    };
    if (!isInsideRealRoot(root, configured)) return escapes;
    try {
      return { kind: "ok", root: resolveInside(root, configured), source: "config" };
    } catch (err) {
      // A directory that does not exist yet is a first run; a link out of the project is not.
      if (err instanceof SandboxEscapeError && err.resolved !== null) return escapes;
      return { kind: "ok", root: configured, source: "config" };
    }
  }
  return fallback;
}
