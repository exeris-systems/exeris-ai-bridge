import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Resource } from "@modelcontextprotocol/sdk/types.js";

import type { BundleState } from "../data/bundle.js";
import { hasBriefSchema, loadBriefSchema } from "../data/brief-schema.js";
import type { ResourceContents } from "./docs.js";

// The exeris://sdk/* resources: static SDK reference data served from the
// bundle. They need no project and no ecosystem root, and they are never
// subscribable: the content is immutable for the life of the process.

const MIME_TYPE = "application/schema+json";

export const BRIEF_SCHEMA_URI = "exeris://sdk/brief-schema";

const BRIEF_SCHEMA_RESOURCE: Resource = {
  uri: BRIEF_SCHEMA_URI,
  name: "brief-schema",
  title: "Discovery brief JSON Schema",
  description:
    "The JSON Schema for docs/briefs/<area>.brief.yaml (ADR-106), vendored from the SDK's source model. " +
    "It carries briefSchemaFormat and sdkVersion. Static: it never changes during a session and cannot be subscribed to.",
  mimeType: MIME_TYPE,
};

/**
 * The SDK resources this bundle can serve. An entry the bundle does not carry
 * is absent from the list rather than listed and unreadable.
 *
 * @param bundle - The loaded bundle state.
 */
export function listSdkResources(bundle: BundleState): readonly Resource[] {
  return hasBriefSchema(bundle) ? [BRIEF_SCHEMA_RESOURCE] : [];
}

/**
 * Return the bundled brief schema as resource contents, or throw an internal
 * error whose data names the cause (the shape the docs resources use for an
 * unavailable family) when the schema is missing, fails its digest or declares
 * a format this build does not read.
 *
 * @param bundle - The loaded bundle state.
 * @param bundleRoot - Bundle root, injectable for tests.
 */
export function readBriefSchemaResource(bundle: BundleState, bundleRoot?: string): ResourceContents[] {
  const schema = loadBriefSchema(bundle, bundleRoot);
  if (schema.state === "unavailable") {
    throw new McpError(
      ErrorCode.InternalError,
      `The brief schema is not available in this environment. ${schema.reason} ${schema.remedy}`,
      { error: "family_unavailable", family: "sdk", reason: schema.reason, remedy: schema.remedy },
    );
  }
  return [{ uri: BRIEF_SCHEMA_URI, mimeType: MIME_TYPE, text: schema.text }];
}
