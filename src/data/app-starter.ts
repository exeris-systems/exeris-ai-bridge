import type { Unavailable } from "../config/env.js";
import { readBundleEntry, type BundleState } from "./bundle.js";

// The application starter: the tested tooling + kernel + SDK triple that
// `eu.exeris:exeris-app-bom` names (ADR-091), vendored at pack time from the
// BOM, `exeris-app-parent` and `exeris-app-starter` POMs. The bridge keeps no
// version of its own; every version `build-get_starter` returns is read from
// this entry.
//
// The pin is `appStarterFormat`, the shape of the vendored JSON. A format this
// build does not know is refused rather than half-read, both when the entry is
// vendored and when it is loaded.

/** The only `appStarterFormat` this build understands. */
export const SUPPORTED_APP_STARTER_FORMAT = 1;

/** Bundle entry id the starter is vendored under. */
export const APP_STARTER_ENTRY = "app-starter";

export const APP_GROUP_ID = "eu.exeris";
export const APP_BOM_ARTIFACT = "exeris-app-bom";
export const APP_PARENT_ARTIFACT = "exeris-app-parent";
export const APP_STARTER_ARTIFACT = "exeris-app-starter";

export interface Coordinate {
  readonly groupId: string;
  readonly artifactId: string;
  readonly version: string;
}

export interface AppStarter {
  readonly appStarterFormat: number;
  /** Version of `exeris-app-bom`, which `exeris-app-parent` and `exeris-app-starter` share. */
  readonly bomVersion: string;
  readonly triple: { readonly tooling: string; readonly kernel: string; readonly sdk: string };
  readonly coordinates: {
    readonly bom: Coordinate;
    readonly parent: Coordinate;
    readonly starter: Coordinate;
  };
}

export class AppStarterFormatError extends Error {}

export interface AppStarterPoms {
  readonly bom: string;
  readonly parent: string;
  readonly starter: string;
}

function withoutComments(xml: string): string {
  let prev = xml;
  while (true) {
    const next = prev.replace(/<!--[\s\S]*?-->/g, "");
    if (next === prev) return next;
    prev = next;
  }
}

function tagText(xml: string, tag: string): string | null {
  const escaped = tag.replace(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`);
  const match = new RegExp(`<${escaped}>([^<]*)</${escaped}>`).exec(xml);
  return match === null ? null : match[1].trim();
}

/** The text of `<parent>`'s child, or null when the POM has no parent block. */
function parentBlock(xml: string): string | null {
  const match = /<parent>([\s\S]*?)<\/parent>/.exec(xml);
  return match === null ? null : match[1];
}

/** A version the publisher wrote as a literal, never an expression. */
function literal(value: string | null, what: string): string {
  if (value === null || value.length === 0) {
    throw new AppStarterFormatError(`${what} is not declared`);
  }
  if (value.includes("${")) {
    throw new AppStarterFormatError(`${what} is '${value}', not a literal version`);
  }
  return value;
}

/**
 * Read the triple out of the three starter POMs. Throws
 * {@link AppStarterFormatError} when a POM does not have the shape ADR-091
 * gives it: the versions must be literals, and the parent and starter must
 * inherit the BOM at the BOM's own version.
 */
export function parseAppStarterPoms(poms: AppStarterPoms): AppStarter {
  const bom = withoutComments(poms.bom);
  const parent = withoutComments(poms.parent);
  const starter = withoutComments(poms.starter);

  // The BOM has no <parent>, so its first <version> after its artifactId is its own.
  const bomHead = bom.replace(/<properties>[\s\S]*$/, "");
  if (tagText(bomHead, "artifactId") !== APP_BOM_ARTIFACT) {
    throw new AppStarterFormatError(`the BOM POM is not ${APP_GROUP_ID}:${APP_BOM_ARTIFACT}`);
  }
  const bomVersion = literal(tagText(bomHead, "version"), "the BOM version");

  const triple = {
    tooling: literal(tagText(bom, "exeris.tooling.version"), "exeris.tooling.version"),
    kernel: literal(tagText(bom, "exeris.kernel.version"), "exeris.kernel.version"),
    sdk: literal(tagText(bom, "exeris.sdk.version"), "exeris.sdk.version"),
  };
  if (triple.tooling !== bomVersion) {
    throw new AppStarterFormatError(
      `exeris.tooling.version '${triple.tooling}' differs from the BOM version '${bomVersion}'`,
    );
  }

  for (const [artifact, xml] of [
    [APP_PARENT_ARTIFACT, parent],
    [APP_STARTER_ARTIFACT, starter],
  ] as const) {
    const block = parentBlock(xml);
    const declared = block === null ? null : tagText(block, "artifactId");
    const inherited = block === null ? null : tagText(block, "version");
    if (declared !== APP_BOM_ARTIFACT || inherited !== bomVersion) {
      throw new AppStarterFormatError(`${artifact} does not inherit ${APP_BOM_ARTIFACT} ${bomVersion}`);
    }
    const own = tagText(xml.replace(/<parent>[\s\S]*?<\/parent>/, ""), "artifactId");
    if (own !== artifact) {
      throw new AppStarterFormatError(`the ${artifact} POM declares artifactId '${own ?? "(none)"}'`);
    }
  }

  const at = (artifactId: string): Coordinate => ({ groupId: APP_GROUP_ID, artifactId, version: bomVersion });
  return {
    appStarterFormat: SUPPORTED_APP_STARTER_FORMAT,
    bomVersion,
    triple,
    coordinates: {
      bom: at(APP_BOM_ARTIFACT),
      parent: at(APP_PARENT_ARTIFACT),
      starter: at(APP_STARTER_ARTIFACT),
    },
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseCoordinate(value: unknown, what: string): Coordinate {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (!isString(raw.groupId) || !isString(raw.artifactId) || !isString(raw.version)) {
    throw new AppStarterFormatError(`the application starter's ${what} coordinate is incomplete`);
  }
  return { groupId: raw.groupId, artifactId: raw.artifactId, version: raw.version };
}

/**
 * Parse and validate the vendored entry. Unknown keys are ignored.
 */
export function parseAppStarter(text: string): AppStarter {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AppStarterFormatError("the application starter is not valid JSON");
  }
  const root = (raw ?? {}) as Record<string, unknown>;
  if (root.appStarterFormat !== SUPPORTED_APP_STARTER_FORMAT) {
    throw new AppStarterFormatError(
      `the application starter declares appStarterFormat ${String(root.appStarterFormat)}; this build reads ${SUPPORTED_APP_STARTER_FORMAT}`,
    );
  }
  const triple = (root.triple ?? {}) as Record<string, unknown>;
  const coordinates = (root.coordinates ?? {}) as Record<string, unknown>;
  if (!isString(root.bomVersion) || !isString(triple.tooling) || !isString(triple.kernel) || !isString(triple.sdk)) {
    throw new AppStarterFormatError("the application starter does not name its bomVersion and tooling/kernel/sdk triple");
  }
  return {
    appStarterFormat: SUPPORTED_APP_STARTER_FORMAT,
    bomVersion: root.bomVersion,
    triple: { tooling: triple.tooling, kernel: triple.kernel, sdk: triple.sdk },
    coordinates: {
      bom: parseCoordinate(coordinates.bom, "bom"),
      parent: parseCoordinate(coordinates.parent, "parent"),
      starter: parseCoordinate(coordinates.starter, "starter"),
    },
  };
}

export interface AvailableAppStarter {
  readonly state: "available";
  readonly starter: AppStarter;
  /** Maven coordinate the starter was vendored from. */
  readonly sourceArtifact: string;
}

export type AppStarterState = AvailableAppStarter | Unavailable;

/**
 * Load the vendored starter from the bundle. Never throws: every failure is a
 * state with a reason and a remedy.
 */
export function loadAppStarter(bundle: BundleState, rootOverride?: string): AppStarterState {
  if (bundle.state === "unavailable") return bundle;
  const entry = bundle.entries.find((e) => e.id === APP_STARTER_ENTRY);
  if (entry === undefined) {
    return {
      state: "unavailable",
      reason: "The bundled reference data carries no application starter.",
      remedy: "Install a published @exeris/ai-bridge, or run npm run vendor:data with EXERIS_TOOLING_VERSION set.",
    };
  }
  const read = readBundleEntry(bundle, APP_STARTER_ENTRY, rootOverride);
  if (read.state === "unavailable") return read;
  try {
    return { state: "available", starter: parseAppStarter(read.text), sourceArtifact: entry.sourceArtifact };
  } catch (err) {
    if (err instanceof AppStarterFormatError) {
      return {
        state: "unavailable",
        reason: `The bundled application starter cannot be used: ${err.message}.`,
        remedy: "Upgrade @exeris/ai-bridge to a release that reads this starter format.",
      };
    }
    throw err;
  }
}
