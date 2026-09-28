import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ProjectConfig, Unavailable } from "../../config/env.js";
import { isSdkAvailable, readBundleEntry, type AvailableBundle, type BundleState } from "../../data/bundle.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import { CANONICAL_SCOPING_RULES, findScopingRules } from "./rules.js";
import { computeVersionSkew } from "./skew.js";
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

export function registerSdkTools(
  bundle: BundleState,
  projectOrRootOverride?: ProjectConfig | Unavailable | string,
  rootOverride?: string,
): RegisteredTool[] {
  let project: ProjectConfig | Unavailable | undefined;
  let resolvedRootOverride: string | undefined = rootOverride;

  if (typeof projectOrRootOverride === "string") {
    resolvedRootOverride = projectOrRootOverride;
  } else if (typeof projectOrRootOverride === "object") {
    project = projectOrRootOverride;
  }

  const projectRoot = project && project.state === "available" ? project.projectRoot : undefined;
  const handle = resolveSdkHandle(bundle);
  return [
    listAnnotationsTool(handle, projectRoot, resolvedRootOverride),
    describeAnnotationTool(handle, projectRoot, resolvedRootOverride),
    getScopingRulesTool(handle, projectRoot, resolvedRootOverride),
    listDeprecationsTool(handle, projectRoot, resolvedRootOverride),
    getAstSchemaTool(handle, projectRoot, resolvedRootOverride),
  ];
}

function loadCatalog(
  bundle: AvailableBundle,
  rootOverride?: string,
): { catalog: AnnotationCatalog } | { errorResult: CallToolResult } {
  const read = readBundleEntry(bundle, "annotation-catalog", rootOverride);
  if (read.state === "unavailable") {
    return {
      errorResult: jsonResult(
        { error: "bundle_entry_unavailable", reason: read.reason, remedy: read.remedy },
        true,
      ),
    };
  }
  try {
    const catalog = parseAnnotationCatalog(JSON.parse(read.text));
    return { catalog };
  } catch (err) {
    return {
      errorResult: jsonResult({ error: "malformed_catalog", message: (err as Error).message }, true),
    };
  }
}

function loadAstSchema(
  bundle: AvailableBundle,
  rootOverride?: string,
): { schema: ParsedAstSchema } | { errorResult: CallToolResult } {
  const read = readBundleEntry(bundle, "ast-schema", rootOverride);
  if (read.state === "unavailable") {
    return {
      errorResult: jsonResult(
        { error: "bundle_entry_unavailable", reason: read.reason, remedy: read.remedy },
        true,
      ),
    };
  }
  try {
    const schema = parseAstSchema(JSON.parse(read.text));
    return { schema };
  } catch (err) {
    return {
      errorResult: jsonResult({ error: "malformed_schema", message: (err as Error).message }, true),
    };
  }
}

function listAnnotationsTool(
  handle: SdkFamily,
  projectRoot?: string,
  rootOverride?: string,
): RegisteredTool {
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
      const loaded = loadCatalog(bundle, rootOverride);
      if ("errorResult" in loaded) {
        return loaded.errorResult;
      }
      const catalog = loaded.catalog;

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
        versionSkew: computeVersionSkew(catalog.sdkVersion, projectRoot),
      });
    }),
  };
}

function describeAnnotationTool(
  handle: SdkFamily,
  projectRoot?: string,
  rootOverride?: string,
): RegisteredTool {
  return {
    definition: {
      name: "sdk-describe_annotation",
      description:
        "Describe a specific Exeris SDK annotation: simple and qualified name, owning package rationale, targets, retention, purpose, detailed description, all attributes (with types, defaults, required-ness, descriptions, and deprecations), and annotation-level deprecation status.",
      inputSchema: {
        type: "object",
        properties: {
          annotation: {
            type: "string",
            description:
              "The annotation name to inspect. Accepts simple name (e.g. 'ExerisDomain', 'Field', 'Validation') or fully-qualified name (e.g. 'eu.exeris.sdk.annotation.ExerisDomain'). Case-insensitive.",
          },
        },
        required: ["annotation"],
      },
    },
    handler: guard("sdk", handle, async ({ bundle }, args) => {
      const loaded = loadCatalog(bundle, rootOverride);
      if ("errorResult" in loaded) {
        return loaded.errorResult;
      }
      const catalog = loaded.catalog;

      const input = typeof args.annotation === "string" ? args.annotation.trim() : "";
      if (input.length === 0) {
        return jsonResult(
          {
            error: "missing_parameter",
            message: "Parameter 'annotation' must be a non-empty string.",
          },
          true,
        );
      }

      const lowerInput = input.toLowerCase();
      const found = catalog.annotations.find(
        (a) =>
          a.name.toLowerCase() === lowerInput ||
          a.qualifiedName.toLowerCase() === lowerInput ||
          a.qualifiedName.toLowerCase().endsWith(`.${lowerInput}`),
      );

      if (!found) {
        const known = catalog.annotations.map((a) => a.name);
        const suggestions = known.filter((k) => k.toLowerCase().includes(lowerInput));
        const hint =
          suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : ` Known annotations: ${known.slice(0, 15).join(", ")}... (${known.length} total)`;
        return jsonResult(
          {
            error: "annotation_not_found",
            message: `Unknown annotation '${input}'.${hint}`,
          },
          true,
        );
      }

      const pkg = catalog.packages.find((p) => p.name === found.package);

      return jsonResult({
        name: found.name,
        qualifiedName: found.qualifiedName,
        package: found.package,
        nested: found.nested,
        targets: found.targets,
        retention: found.retention,
        memberValueOnly: found.memberValueOnly,
        purpose: found.purpose,
        description: found.description ?? null,
        deprecated: found.deprecated ?? null,
        attributes: found.attributes.map((attr) => ({
          name: attr.name,
          type: attr.type,
          required: attr.required,
          default: attr.default ?? null,
          purpose: attr.purpose ?? null,
          description: attr.description ?? null,
          deprecated: attr.deprecated ?? null,
        })),
        packageSummary: pkg
          ? {
              name: pkg.name,
              purpose: pkg.purpose,
              description: pkg.description ?? null,
            }
          : null,
        versionSkew: computeVersionSkew(catalog.sdkVersion, projectRoot),
      });
    }),
  };
}

function getScopingRulesTool(
  handle: SdkFamily,
  projectRoot?: string,
  rootOverride?: string,
): RegisteredTool {
  return {
    definition: {
      name: "sdk-get_scoping_rules",
      description:
        "Get canonical authoring contract scoping rules for Exeris SDK annotations (including @Field vs @Validation split, FieldMetadata as single AST carrier per ADR-054, derived SQL NOT NULL and API not-blank generator semantics, form lifecycle scoping, deprecations, and sibling vs nested form trap). Supports optional filtering by rule ID or query string.",
      inputSchema: {
        type: "object",
        properties: {
          rule: {
            type: "string",
            description:
              "Optional rule identifier (e.g. 'field-vs-validation-split', 'single-ast-carrier', 'derived-nullability-semantics', 'form-lifecycle-scoping', 'deprecation-fallbacks', 'nested-form-trap') or search query.",
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

      const ruleQuery = typeof args.rule === "string" ? args.rule.trim() : undefined;
      const matched = findScopingRules(ruleQuery);

      if (ruleQuery && matched.length === 0) {
        const known = CANONICAL_SCOPING_RULES.map((r) => r.id);
        return jsonResult(
          {
            error: "rule_not_found",
            message: `No scoping rules matched '${ruleQuery}'. Known rule IDs: ${known.join(", ")}`,
          },
          true,
        );
      }

      return jsonResult({
        sdkVersion: catalog.sdkVersion,
        ruleCount: CANONICAL_SCOPING_RULES.length,
        matchedRules: matched.length,
        rules: matched,
        versionSkew: computeVersionSkew(catalog.sdkVersion, projectRoot),
      });
    }),
  };
}

function listDeprecationsTool(
  handle: SdkFamily,
  projectRoot?: string,
  rootOverride?: string,
): RegisteredTool {
  return {
    definition: {
      name: "sdk-list_deprecations",
      description:
        "List all deprecated Exeris SDK annotations and attributes across the authoring contract, including replacement guidance, since version, and forRemoval status. Supports filtering by package or forRemoval only.",
      inputSchema: {
        type: "object",
        properties: {
          forRemovalOnly: {
            type: "boolean",
            description:
              "If true, only returns items marked for removal (forRemoval: true). Defaults to false.",
          },
          package: {
            type: "string",
            description:
              "Optional package filter (e.g. 'system', 'security', 'capability', or full package name).",
          },
        },
      },
    },
    handler: guard("sdk", handle, async ({ bundle }, args) => {
      const loaded = loadCatalog(bundle, rootOverride);
      if ("errorResult" in loaded) {
        return loaded.errorResult;
      }
      const catalog = loaded.catalog;

      const forRemovalOnly = Boolean(args.forRemovalOnly);
      const pkgFilter = typeof args.package === "string" ? args.package.trim().toLowerCase() : undefined;

      let annotations = catalog.annotations;
      if (pkgFilter) {
        annotations = annotations.filter((a) => a.package.toLowerCase().includes(pkgFilter));
      }

      const deprecatedAnnotations: Array<{
        name: string;
        qualifiedName: string;
        package: string;
        forRemoval: boolean;
        since: string;
        replacement: string | null;
      }> = [];

      for (const a of annotations) {
        if (a.deprecated) {
          if (!forRemovalOnly || a.deprecated.forRemoval) {
            deprecatedAnnotations.push({
              name: a.name,
              qualifiedName: a.qualifiedName,
              package: a.package,
              forRemoval: a.deprecated.forRemoval,
              since: a.deprecated.since,
              replacement: a.deprecated.replacement ?? null,
            });
          }
        }
      }

      const deprecatedAttributes: Array<{
        annotation: string;
        qualifiedName: string;
        package: string;
        attribute: string;
        type: string;
        default: string | null;
        forRemoval: boolean;
        since: string;
        replacement: string | null;
      }> = [];

      for (const a of annotations) {
        for (const attr of a.attributes) {
          if (attr.deprecated) {
            if (!forRemovalOnly || attr.deprecated.forRemoval) {
              deprecatedAttributes.push({
                annotation: a.name,
                qualifiedName: a.qualifiedName,
                package: a.package,
                attribute: attr.name,
                type: attr.type,
                default: attr.default ?? null,
                forRemoval: attr.deprecated.forRemoval,
                since: attr.deprecated.since,
                replacement: attr.deprecated.replacement ?? null,
              });
            }
          }
        }
      }

      return jsonResult({
        sdkVersion: catalog.sdkVersion,
        totalDeprecatedAnnotations: deprecatedAnnotations.length,
        totalDeprecatedAttributes: deprecatedAttributes.length,
        deprecatedAnnotations,
        deprecatedAttributes,
        versionSkew: computeVersionSkew(catalog.sdkVersion, projectRoot),
      });
    }),
  };
}

function getAstSchemaTool(
  handle: SdkFamily,
  projectRoot?: string,
  rootOverride?: string,
): RegisteredTool {
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
      const loaded = loadAstSchema(bundle, rootOverride);
      if ("errorResult" in loaded) {
        return loaded.errorResult;
      }
      const schema = loaded.schema;

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
        return jsonResult({
          definition: defName,
          sdkVersion: schema.envelope.sdkVersion,
          astSchemaVersion: schema.envelope.astSchemaVersion,
          schema: found,
          versionSkew: computeVersionSkew(schema.envelope.sdkVersion, projectRoot),
        });
      }

      return jsonResult({
        ...schema.envelope,
        versionSkew: computeVersionSkew(schema.envelope.sdkVersion, projectRoot),
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
