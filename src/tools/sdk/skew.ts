import { join } from "node:path";
import { resolveLocalRepository } from "../../config/maven.js";
import {
  APP_GROUP_IDS,
  readBounded,
  resolveValue,
  parsePom,
  tagValue,
  type Coordinate,
  type PomModel,
} from "../../config/pom.js";

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

const MAX_CHAIN_DEPTH = 6;

const SDK_VERSION_PROPERTY = "exeris.sdk.version";

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
