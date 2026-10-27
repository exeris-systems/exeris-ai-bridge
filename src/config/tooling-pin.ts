import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveInside } from "../fs/sandbox.js";
import { APP_GROUP_IDS, parsePom, readBounded, resolveValue, tagValue } from "./pom.js";

// The exeris-tooling release a project pins, read offline from its own files.
// Shared by the generator resolution (which launches the pinned release) and the
// tooling-skew report (which compares it with the bundled generator catalogue), so
// the two can never disagree about what "the project's tooling version" means.

/** Where a project's tooling version was read from. */
export type ToolingVersionSource = "app-parent" | "codegen-plugin" | "node-modules";

export type ToolingPin =
  | { readonly kind: "pinned"; readonly version: string; readonly source: ToolingVersionSource }
  | { readonly kind: "none"; readonly reason: string };

export const CODEGEN_PLUGIN = "exeris-codegen-maven-plugin";

/** Package directory of the TypeScript generator, relative to the project root. */
export const CODEGEN_TS_PACKAGE_DIR = ["node_modules", "@exeris", "codegen-ts"] as const;

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * The tooling version a Maven project pins: its `exeris-app-parent` parent version first, else
 * the `exeris-codegen-maven-plugin` version declared in its own `pom.xml`.
 */
export function resolveJavaToolingPin(projectRoot: string): ToolingPin {
  const content = readBounded(projectRoot, join(projectRoot, "pom.xml"));
  if (content === null) {
    return { kind: "none", reason: "The project has no readable pom.xml, so its pinned tooling version is unknown." };
  }
  const model = parsePom(content);

  const parent = model.parent;
  if (
    parent !== undefined &&
    APP_GROUP_IDS.includes(parent.groupId) &&
    parent.artifactId === "exeris-app-parent"
  ) {
    const version = resolveValue(parent.version, model.properties);
    return version === null
      ? { kind: "none", reason: `pom.xml parents on exeris-app-parent at "${parent.version}", which is not a concrete version the bridge can resolve.` }
      : { kind: "pinned", version, source: "app-parent" };
  }

  const pluginVersion = codegenPluginVersion(model.body, model.properties);
  if (pluginVersion !== null) return { kind: "pinned", version: pluginVersion, source: "codegen-plugin" };
  return {
    kind: "none",
    reason: `pom.xml neither parents on exeris-app-parent nor declares ${CODEGEN_PLUGIN} with a concrete version, so no tooling version is pinned.`,
  };
}

function codegenPluginVersion(body: string, properties: Map<string, string>): string | null {
  const pluginRegex = /<plugin>([\s\S]*?)<\/plugin>/gi;
  let match: RegExpExecArray | null;
  while ((match = pluginRegex.exec(body)) !== null) {
    const block = match[1];
    if (tagValue(block, "artifactId") !== CODEGEN_PLUGIN) continue;
    const raw = tagValue(block, "version");
    if (raw === null) continue;
    const resolved = resolveValue(raw, properties);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * The `package.json` of the project's own installed `@exeris/codegen-ts`, or null when it is
 * absent, oversized, unreadable or not inside the project (a workspace-hoisted install is not
 * followed).
 */
export function readInstalledCodegenTs(
  projectRoot: string,
): { readonly pkgDir: string; readonly manifest: { version?: unknown; bin?: unknown } } | null {
  try {
    const pkgDir = resolveInside(projectRoot, join(projectRoot, ...CODEGEN_TS_PACKAGE_DIR));
    const manifestPath = resolveInside(pkgDir, join(pkgDir, "package.json"));
    if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) return null;
    return {
      pkgDir,
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; bin?: unknown },
    };
  } catch {
    return null;
  }
}

/** The installed `@exeris/codegen-ts` version: for a TypeScript project, the installed package is the pin. */
export function resolveTypeScriptToolingPin(projectRoot: string): ToolingPin {
  const installed = readInstalledCodegenTs(projectRoot);
  const version =
    installed !== null && typeof installed.manifest.version === "string" ? installed.manifest.version : null;
  return version === null
    ? {
        kind: "none",
        reason:
          "No @exeris/codegen-ts is installed in the project's own node_modules, so no TypeScript tooling version is pinned.",
      }
    : { kind: "pinned", version, source: "node-modules" };
}

/** The Maven pin when there is one, else the installed TypeScript generator's version. */
export function resolveProjectToolingVersion(projectRoot: string): ToolingPin {
  const java = resolveJavaToolingPin(projectRoot);
  if (java.kind === "pinned") return java;
  const ts = resolveTypeScriptToolingPin(projectRoot);
  return ts.kind === "pinned" ? ts : java;
}
