import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Unavailable } from "../../config/env.js";
import { isSdkAvailable, readBundleEntry, type AvailableBundle, type BundleState } from "../../data/bundle.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import {
  parseAnnotationCatalog,
  parseAstSchema,
  type AnnotationCatalog,
  type ParsedAstSchema,
} from "./shapes.js";

// sdk:* — read-only authoring contract of the Exeris SDK, sourced from bundled
// reference data (annotation-catalog.json and ast-schema.json).
//
// Authorised by the ADR-025 2026-08-16 "Two Personas" amendment (scheduled at
// ROADMAP 0.7.0). Sourced from released/published SDK artifacts inside the
// bundled reference data, so application developers without an ecosystem
// checkout get authoritative answers.
//
// Read-only by construction: every tool is a read.

export type SdkFamily =
  | { readonly state: "available"; readonly bundle: AvailableBundle }
  | Unavailable;

export { isSdkAvailable };

export function resolveSdkHandle(bundle: BundleState): SdkFamily {
  if (bundle.state === "unavailable") {
    return { state: "unavailable", reason: bundle.reason, remedy: bundle.remedy };
  }
  if (!isSdkAvailable(bundle)) {
    return {
      state: "unavailable",
      reason: "The bundled reference data carries no annotation catalog.",
      remedy: "Run npm run vendor:data to generate the bundle.",
    };
  }
  return { state: "available", bundle };
}

export function registerSdkTools(bundle: BundleState, rootOverride?: string): RegisteredTool[] {
  const handle = resolveSdkHandle(bundle);
  return [listAnnotationsTool(handle, rootOverride), getAstSchemaTool(handle, rootOverride)];
}

function listAnnotationsTool(handle: SdkFamily, rootOverride?: string): RegisteredTool {
  return {
    definition: {
      name: "sdk-list_annotations",
      description:
        "List Exeris SDK annotations from the authoring contract: name, qualified name, package, targets, retention, and purpose. Supports optional filtering by package (e.g. 'system', 'security', 'capability', or full package name), target (e.g. 'METHOD', 'TYPE', 'FIELD'), or query string.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Optional package filter, e.g. 'system', 'security', 'capability', or full package name.",
          },
          target: {
            type: "string",
            description: "Optional ElementType target filter, e.g. 'TYPE', 'METHOD', 'FIELD', 'PARAMETER'.",
          },
          query: {
            type: "string",
            description: "Optional case-insensitive search string matching annotation name or purpose.",
          },
        },
      },
    },
    handler: guard("sdk", handle, async ({ bundle }, args) => {
      const read = readBundleEntry(bundle, "annotation-catalog", rootOverride);
      if (read.state === "unavailable") {
        return jsonResult(
          { error: "bundle_entry_unavailable", reason: read.reason, remedy: read.remedy },
          true,
        );
      }
      let catalog: AnnotationCatalog;
      try {
        catalog = parseAnnotationCatalog(JSON.parse(read.text));
      } catch (err) {
        return jsonResult({ error: "malformed_catalog", message: (err as Error).message }, true);
      }

      let annotations = catalog.annotations;
      const pkgFilter = typeof args.package === "string" ? args.package.trim().toLowerCase() : undefined;
      const targetFilter =
        typeof args.target === "string" ? args.target.trim().toUpperCase() : undefined;
      const queryFilter = typeof args.query === "string" ? args.query.trim().toLowerCase() : undefined;

      if (pkgFilter) {
        annotations = annotations.filter((a) => a.package.toLowerCase().includes(pkgFilter));
      }
      if (targetFilter) {
        annotations = annotations.filter((a) => a.targets.includes(targetFilter));
      }
      if (queryFilter) {
        annotations = annotations.filter(
          (a) =>
            a.name.toLowerCase().includes(queryFilter) ||
            a.qualifiedName.toLowerCase().includes(queryFilter) ||
            a.purpose.toLowerCase().includes(queryFilter),
        );
      }

      const summaries = annotations.map((a) => ({
        name: a.name,
        qualifiedName: a.qualifiedName,
        package: a.package,
        targets: a.targets,
        retention: a.retention,
        purpose: a.purpose,
      }));

      return jsonResult({
        sdkVersion: catalog.sdkVersion,
        totalInCatalog: catalog.annotationCount,
        matched: summaries.length,
        annotations: summaries,
      });
    }),
  };
}

function getAstSchemaTool(handle: SdkFamily, rootOverride?: string): RegisteredTool {
  return {
    definition: {
      name: "sdk-get_ast_schema",
      description:
        "Get JSON Schema for the Exeris build-time DomainMetadata AST and sibling records. If 'definition' is omitted, returns the top-level schema envelope, reader requirements (such as Jackson 3 constraints), and definition list. If 'definition' is specified (e.g. 'DomainMetadata', 'FieldMetadata', 'ActionMetadata'), returns the schema definition for that specific record.",
      inputSchema: {
        type: "object",
        properties: {
          definition: {
            type: "string",
            description: "Optional AST definition name (e.g. 'DomainMetadata', 'FieldMetadata', 'ActionMetadata').",
          },
        },
      },
    },
    handler: guard("sdk", handle, async ({ bundle }, args) => {
      const read = readBundleEntry(bundle, "ast-schema", rootOverride);
      if (read.state === "unavailable") {
        return jsonResult(
          { error: "bundle_entry_unavailable", reason: read.reason, remedy: read.remedy },
          true,
        );
      }
      let schema: ParsedAstSchema;
      try {
        schema = parseAstSchema(JSON.parse(read.text));
      } catch (err) {
        return jsonResult({ error: "malformed_schema", message: (err as Error).message }, true);
      }

      const defName = typeof args.definition === "string" ? args.definition.trim() : undefined;
      if (defName) {
        if (!Object.hasOwn(schema.definitions, defName)) {
          return jsonResult(
            {
              error: "unknown_definition",
              message: `Unknown AST definition '${defName}'. Known definitions: ${schema.envelope.definitions.join(", ")}`,
            },
            true,
          );
        }
        const found = schema.definitions[defName];
        if (!found) {
          return jsonResult(
            {
              error: "unknown_definition",
              message: `Unknown AST definition '${defName}'. Known definitions: ${schema.envelope.definitions.join(", ")}`,
            },
            true,
          );
        }
        return jsonResult({
          definition: defName,
          sdkVersion: schema.envelope.sdkVersion,
          astSchemaVersion: schema.envelope.astSchemaVersion,
          schema: found,
        });
      }

      return jsonResult({
        ...schema.envelope,
      });
    }),
  };
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: isError ? true : undefined,
  };
}
