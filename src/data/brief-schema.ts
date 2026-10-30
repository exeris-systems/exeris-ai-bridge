import type { Unavailable } from "../config/env.js";
import { readBundleEntry, type BundleState } from "./bundle.js";

// The discovery brief's JSON Schema (`META-INF/exeris/brief-schema.json`,
// shipped in `eu.exeris:exeris-sdk-source-model`). The SDK owns the contract;
// the bridge vendors the schema at pack time and serves it verbatim.
//
// The pin is `briefSchemaFormat`, not the SDK version. It is declared apart
// from the AST schema's `schemaFormat` so the two move independently. A format
// this build does not know is refused rather than half-read, both when the
// schema is vendored and when it is loaded.

/** The only `briefSchemaFormat` this build understands. */
export const SUPPORTED_BRIEF_SCHEMA_FORMAT = 1;

/** Bundle entry id the brief schema is vendored under. */
export const BRIEF_SCHEMA_ENTRY = "brief-schema";

export class BriefSchemaFormatError extends Error {}

/**
 * Check that `text` is a JSON object declaring a `briefSchemaFormat` this
 * build reads, and return that number. Throws {@link BriefSchemaFormatError}
 * otherwise; unknown keys are ignored.
 *
 * @param text - The raw contents of `brief-schema.json`.
 */
export function assertBriefSchemaFormat(text: string): number {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BriefSchemaFormatError("the brief schema is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BriefSchemaFormatError("the brief schema is not a JSON object");
  }
  const format = (raw as Record<string, unknown>).briefSchemaFormat;
  if (format !== SUPPORTED_BRIEF_SCHEMA_FORMAT) {
    throw new BriefSchemaFormatError(
      `the brief schema declares briefSchemaFormat ${JSON.stringify(format)}; this bridge reads format ${SUPPORTED_BRIEF_SCHEMA_FORMAT}`,
    );
  }
  return SUPPORTED_BRIEF_SCHEMA_FORMAT;
}

/** True when the bundle manifest lists a brief schema entry. */
export function hasBriefSchema(bundle: BundleState): boolean {
  return bundle.state === "available" && bundle.entries.some((e) => e.id === BRIEF_SCHEMA_ENTRY);
}

export type BriefSchemaState =
  | {
      readonly state: "available";
      /** The schema file's contents as text, unmodified. */
      readonly text: string;
      readonly briefSchemaFormat: number;
      /** Maven coordinate the schema was vendored from. */
      readonly sourceArtifact: string;
    }
  | Unavailable;

/**
 * Load the vendored brief schema from the bundle. Never throws: every failure
 * is a state with a reason and a remedy.
 *
 * @param bundle - The loaded bundle state.
 * @param rootOverride - Bundle root, injectable for tests.
 */
export function loadBriefSchema(bundle: BundleState, rootOverride?: string): BriefSchemaState {
  if (bundle.state === "unavailable") return bundle;
  const entry = bundle.entries.find((e) => e.id === BRIEF_SCHEMA_ENTRY);
  if (entry === undefined) {
    return {
      state: "unavailable",
      reason: "The bundled reference data carries no brief schema.",
      remedy:
        "Install a published @exeris/ai-bridge, or run npm run vendor:data with EXERIS_SDK_VERSION set to 0.13.1 or later.",
    };
  }
  const read = readBundleEntry(bundle, BRIEF_SCHEMA_ENTRY, rootOverride);
  if (read.state === "unavailable") return read;
  try {
    return {
      state: "available",
      text: read.text,
      briefSchemaFormat: assertBriefSchemaFormat(read.text),
      sourceArtifact: entry.sourceArtifact,
    };
  } catch (err) {
    if (err instanceof BriefSchemaFormatError) {
      return {
        state: "unavailable",
        reason: `The bundled brief schema cannot be used: ${err.message}.`,
        remedy: "Upgrade @exeris/ai-bridge to a release that reads this brief schema format.",
      };
    }
    throw err;
  }
}
