import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveLocalRepository } from "../../config/maven.js";
import { resolveInside } from "../../fs/sandbox.js";

export type VersionSkewStatus = "aligned" | "skew_detected" | "unknown";

/** Where the project's SDK version was read from. */
export type SdkVersionSource = "dependency" | "property" | "app-bom";

export interface VersionSkewReport {
  readonly status: VersionSkewStatus;
  readonly bundledSdkVersion: string;
  readonly projectSdkVersion?: string;
  /** Where projectSdkVersion came from; absent when it is unknown. */
  readonly source?: SdkVersionSource;
  /** `group:artifact:version` of the app BOM pom that supplied it (source "app-bom"). */
  readonly sourceCoordinate?: string;
  /** Why the project version is unknown, when the BOM chain could not be followed. */
  readonly reason?: string;
  readonly warning?: string;
}

/** The project's SDK version with its provenance, or the reason it is unknown. */
export interface SdkVersionResolution {
  readonly version: string | null;
  readonly source?: SdkVersionSource;
  /** `group:artifact:version` of the pom that supplied the version (app-bom only). */
  readonly coordinate?: string;
  readonly reason?: string;
}

const MAX_POM_BYTES = 2 * 1024 * 1024; // 2 MB size cap
const MAX_CHAIN_DEPTH = 6;

/** exeris-tooling 0.9.0 published the app BOM chain under eu.exeris.tooling; 0.10.0 moved it to eu.exeris. */
const APP_GROUP_IDS: readonly string[] = ["eu.exeris", "eu.exeris.tooling"];
const SDK_VERSION_PROPERTY = "exeris.sdk.version";

interface Coordinate {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
}

interface PomModel {
  readonly properties: Map<string, string>;
  readonly parent?: Coordinate;
  readonly body: string;
}

function stripComments(content: string): string {
  // Fixed-point loop to satisfy CodeQL multi-character sanitization check
  let stripped = content;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, "");
  } while (stripped !== prev);
  return stripped;
}

function tagValue(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function parsePom(content: string): PomModel {
  const stripped = stripComments(content);
  const properties = new Map<string, string>();
  const propsMatch = stripped.match(/<properties>([\s\S]*?)<\/properties>/i);
  if (propsMatch) {
    const tagRegex = /<([a-zA-Z0-9_.-]+)>([^<]+)<\/\1>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(propsMatch[1])) !== null) {
      properties.set(match[1].trim(), match[2].trim());
    }
  }
  let parent: Coordinate | undefined;
  const parentMatch = stripped.match(/<parent>([\s\S]*?)<\/parent>/i);
  if (parentMatch) {
    const groupId = tagValue(parentMatch[1], "groupId");
    const artifactId = tagValue(parentMatch[1], "artifactId");
    const version = tagValue(parentMatch[1], "version");
    if (groupId && artifactId && version) {
      parent = { groupId, artifactId, version };
    }
  }
  return { properties, parent, body: stripped };
}

/** Resolves a literal, or a chain of `${prop}` references, within one pom's own properties. */
function resolveValue(
  val: string,
  properties: Map<string, string>,
  visited: Set<string> = new Set(),
): string | null {
  if (visited.size > 15) {
    return null;
  }
  const trimmed = val.trim();
  const propMatch = trimmed.match(/^\$\{([^}]+)\}$/);
  if (propMatch) {
    const key = propMatch[1].trim();
    if (visited.has(key) || !properties.has(key)) {
      return null;
    }
    visited.add(key);
    return resolveValue(properties.get(key)!, properties, visited);
  }
  if (trimmed.includes("${")) {
    return null; // partial interpolation is not attempted
  }
  return trimmed.length > 0 ? trimmed : null;
}

function readBounded(root: string, path: string): string | null {
  try {
    const safe = resolveInside(root, path);
    const stats = statSync(safe);
    if (!stats.isFile() || stats.size > MAX_POM_BYTES) {
      return null;
    }
    return readFileSync(safe, "utf8");
  } catch {
    return null;
  }
}

function dependencyBlocks(model: PomModel): string[] {
  const blocks: string[] = [];
  const depRegex = /<dependency>([\s\S]*?)<\/dependency>/gi;
  let depMatch: RegExpExecArray | null;
  while ((depMatch = depRegex.exec(model.body)) !== null) {
    blocks.push(depMatch[1]);
  }
  return blocks;
}

function findDirectSdkDependency(model: PomModel): string | null {
  for (const block of dependencyBlocks(model)) {
    const artId = tagValue(block, "artifactId") ?? "";
    const version = tagValue(block, "version");
    if (
      tagValue(block, "groupId") === "eu.exeris" &&
      (artId === "exeris-sdk" || artId.startsWith("exeris-sdk-")) &&
      version
    ) {
      const resolved = resolveValue(version, model.properties);
      if (resolved) {
        return resolved;
      }
    }
  }
  return null;
}

/** The app parent or app BOM the project builds on: its `<parent>`, else an imported exeris-app-bom. */
function findAppBomEntry(model: PomModel): Coordinate | null {
  const isAppArtifact = (g: string, a: string): boolean =>
    APP_GROUP_IDS.includes(g) && (a === "exeris-app-parent" || a === "exeris-app-bom");
  if (model.parent && isAppArtifact(model.parent.groupId, model.parent.artifactId)) {
    return model.parent;
  }
  for (const block of dependencyBlocks(model)) {
    const groupId = tagValue(block, "groupId");
    const artifactId = tagValue(block, "artifactId");
    const version = tagValue(block, "version");
    if (
      groupId &&
      artifactId === "exeris-app-bom" &&
      version &&
      isAppArtifact(groupId, artifactId) &&
      tagValue(block, "scope") === "import"
    ) {
      return { groupId, artifactId, version };
    }
  }
  return null;
}

function coordinateOf(e: Coordinate): string {
  return `${e.groupId}:${e.artifactId}:${e.version}`;
}

function localPomPath(repo: string, e: Coordinate): string {
  return join(repo, ...e.groupId.split("."), e.artifactId, e.version, `${e.artifactId}-${e.version}.pom`);
}

/**
 * Follows exeris-app-parent -> exeris-app-bom in the LOCAL Maven repository until a pom in the
 * chain declares `exeris.sdk.version`. Read-only and offline: a pom that is not there ends the
 * walk with a reason; it is never fetched.
 */
function resolveThroughAppBom(
  start: Coordinate,
  projectProps: Map<string, string>,
  env: NodeJS.ProcessEnv,
): SdkVersionResolution {
  const version = resolveValue(start.version, projectProps);
  if (!version) {
    return {
      version: null,
      reason: `pom.xml builds on ${start.groupId}:${start.artifactId} at version "${start.version}", which is not a concrete version the bridge can resolve.`,
    };
  }
  let entry: Coordinate = { ...start, version };
  const repo = resolveLocalRepository(env);
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    const coordinate = coordinateOf(entry);
    const content = repo === null ? null : readBounded(repo, localPomPath(repo, entry));
    if (content === null) {
      const where = repo === null ? "no local Maven repository was found" : `looked in ${repo}`;
      return {
        version: null,
        reason: `The SDK version comes from the app BOM chain, but ${coordinate} is not in the local Maven repository (${where}). Run mvn once (for example mvn validate) to populate it; the bridge never downloads.`,
      };
    }
    const model = parsePom(content);
    const raw = model.properties.get(SDK_VERSION_PROPERTY);
    if (raw !== undefined) {
      const resolved = resolveValue(raw, model.properties);
      if (!resolved) {
        return {
          version: null,
          reason: `${coordinate} declares ${SDK_VERSION_PROPERTY} as "${raw}", which the bridge cannot resolve from the poms it read.`,
        };
      }
      return { version: resolved, source: "app-bom", coordinate };
    }
    const next = model.parent;
    if (!next || !APP_GROUP_IDS.includes(next.groupId)) {
      break;
    }
    const nextVersion = resolveValue(next.version, model.properties);
    if (!nextVersion) {
      break;
    }
    entry = { ...next, version: nextVersion };
  }
  return {
    version: null,
    reason: `No ${SDK_VERSION_PROPERTY} found along the app BOM chain starting at ${coordinateOf(start)}.`,
  };
}

/**
 * Offline detection of the Exeris SDK version a Maven project uses, with its provenance.
 * Order: a direct `eu.exeris:exeris-sdk*` dependency; an `exeris.sdk.version` property in the
 * project's own pom (it overrides the inherited one in Maven); then the app BOM chain
 * (exeris-app-parent -> exeris-app-bom) read from the local Maven repository.
 * Reads poms directly without spawning Maven or linking any Java classpath; every read is
 * sandbox-checked (the project pom under projectRoot, BOM poms under the local repository root).
 */
export function resolveProjectSdkVersion(
  projectRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): SdkVersionResolution {
  if (!projectRoot || typeof projectRoot !== "string") {
    return { version: null };
  }
  const content = readBounded(projectRoot, join(projectRoot, "pom.xml"));
  if (content === null) {
    return { version: null };
  }
  try {
    const model = parsePom(content);

    const direct = findDirectSdkDependency(model);
    if (direct) {
      return { version: direct, source: "dependency" };
    }

    const own = model.properties.get(SDK_VERSION_PROPERTY);
    if (own !== undefined) {
      const resolved = resolveValue(own, model.properties);
      if (resolved) {
        return { version: resolved, source: "property" };
      }
    }

    const bom = findAppBomEntry(model);
    if (bom) {
      return resolveThroughAppBom(bom, model.properties, env);
    }
    return { version: null };
  } catch {
    return { version: null };
  }
}

/** The detected SDK version alone; {@link resolveProjectSdkVersion} adds provenance. */
export function detectProjectSdkVersion(
  projectRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveProjectSdkVersion(projectRoot, env).version;
}

/**
 * Computes version skew between the bundled reference catalog and the user's project.
 */
export function computeVersionSkew(
  bundledSdkVersion?: string | null,
  projectRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): VersionSkewReport {
  if (!bundledSdkVersion || bundledSdkVersion === "unknown") {
    return {
      status: "unknown",
      bundledSdkVersion: "unknown",
    };
  }

  const resolution = resolveProjectSdkVersion(projectRoot, env);
  const projectSdkVersion = resolution.version;
  if (!projectSdkVersion) {
    return {
      status: "unknown",
      bundledSdkVersion,
      ...(resolution.reason ? { reason: resolution.reason } : {}),
    };
  }
  const provenance = {
    source: resolution.source,
    ...(resolution.coordinate ? { sourceCoordinate: resolution.coordinate } : {}),
  };

  if (projectSdkVersion === bundledSdkVersion) {
    return {
      status: "aligned",
      bundledSdkVersion,
      projectSdkVersion,
      ...provenance,
    };
  }

  return {
    status: "skew_detected",
    bundledSdkVersion,
    projectSdkVersion,
    ...provenance,
    warning: `Project pins Exeris SDK version ${projectSdkVersion}, while bundled reference catalog reflects ${bundledSdkVersion}. Annotations, scoping rules, or deprecations may differ between these versions.`,
  };
}
