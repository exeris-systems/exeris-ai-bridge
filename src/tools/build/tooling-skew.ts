import type { ToolingPin, ToolingVersionSource } from "../../config/tooling-pin.js";
import type { CatalogueState } from "../../data/generator-catalogue.js";
import type { VersionSkewStatus } from "../sdk/skew.js";

// Skew between the exeris-tooling release the project pins and the one the
// vendored generator catalogue came from. The catalogue explains the paths an
// emitted tree contains and decodes the diagnostics a generator prints; both
// are the contract of one tooling release, so a project on another release can
// be explained wrongly without any other sign.

/** Same shape as the SDK's `VersionSkewReport`, with tooling-named version fields. */
export interface ToolingSkewReport {
  readonly status: VersionSkewStatus;
  /** The tooling version the bundled generator catalogue was vendored from, or "unknown". */
  readonly bundledToolingVersion: string;
  readonly projectToolingVersion?: string;
  /** Where projectToolingVersion came from; absent when it is unknown. */
  readonly source?: ToolingVersionSource;
  /** Why the project version is unknown, when no pin could be read. */
  readonly reason?: string;
  readonly warning?: string;
}

/**
 * The version in a `group:artifact:version` source coordinate, or null when it
 * does not have that shape.
 */
export function versionOfSourceArtifact(sourceArtifact: string): string | null {
  const parts = sourceArtifact.split(":");
  if (parts.length !== 3 || parts.some((p) => p.trim().length === 0)) return null;
  return parts[2].trim();
}

/** The tooling version the loaded catalogue came from, or null when there is no catalogue or it names none. */
export function bundledToolingVersion(catalogue: CatalogueState): string | null {
  return catalogue.state === "available" ? versionOfSourceArtifact(catalogue.sourceArtifact) : null;
}

/** Compares the project's tooling pin with the bundled catalogue's source version. */
export function computeToolingSkew(catalogue: CatalogueState, pin: ToolingPin): ToolingSkewReport {
  const bundled = bundledToolingVersion(catalogue);
  if (bundled === null) {
    return {
      status: "unknown",
      bundledToolingVersion: "unknown",
      ...(pin.kind === "pinned"
        ? { projectToolingVersion: pin.version, source: pin.source }
        : { reason: pin.reason }),
    };
  }
  if (pin.kind === "none") {
    return { status: "unknown", bundledToolingVersion: bundled, reason: pin.reason };
  }
  const project = { projectToolingVersion: pin.version, source: pin.source };
  if (pin.version === bundled) {
    return { status: "aligned", bundledToolingVersion: bundled, ...project };
  }
  return {
    status: "skew_detected",
    bundledToolingVersion: bundled,
    ...project,
    warning: `Project pins Exeris tooling version ${pin.version}, while the bundled generator catalogue comes from ${bundled}. Generated paths, their explanations and diagnostic meanings may differ between these releases.`,
  };
}
