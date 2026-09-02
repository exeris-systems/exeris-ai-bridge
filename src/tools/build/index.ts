import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BridgeConfig, ProjectConfig, Unavailable } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import {
  classifyMetadataFile,
  isJavaSimpleName,
  MetadataShapeError,
  parseMetadataEnvelope,
  prefixFor,
  type MetadataEntry,
  type MetadataKind,
} from "./shapes.js";

// build:* — read-only questions about the USER'S OWN build output. Nothing here
// runs a build, and no handler writes into the project: this family reads what
// `mvn compile` already produced and nothing else (ADR-025 §"Preview, never
// write"; CLAUDE.md hard constraint 3 extended across families by the
// 2026-06-24 amendment).
//
// Source of truth is the annotation processor's own output directory —
// CLASS_OUTPUT/exeris-metadata, i.e. target/classes/exeris-metadata for a
// Maven build (ExerisDomainProcessor.METADATA_DIR).

const METADATA_DIR = "target/classes/exeris-metadata";

const KINDS: readonly MetadataKind[] = ["domain", "enum", "capability", "view"];

type BuildFamily = { readonly state: "available"; readonly project: ProjectConfig } | Unavailable;

export function registerBuildTools(config: BridgeConfig): RegisteredTool[] {
  const handle: BuildFamily =
    config.project.state === "available"
      ? { state: "available", project: config.project }
      : config.project;
  return [listDomainsTool(handle), getDomainMetadataTool(handle)];
}

/**
 * Discovery, and not an optional nicety.
 *
 * `lsp-list_domains` answers the same question, but that family needs a
 * platform LSP that has no published artifact yet, so it is contributor-only —
 * which leaves P2, the persona this whole family exists for, with no way to
 * learn an entity name. Without this, the first call into `build:*` would have
 * to be a guess. Every other family in this server pairs a list with a get; so
 * does this one.
 */
function listDomainsTool(handle: BuildFamily): RegisteredTool {
  return {
    definition: {
      name: "build-list_domains",
      description:
        "List what this project's last build emitted into target/classes/exeris-metadata: every @ExerisDomain entity, plus the enums, capabilities and views the processor wrote alongside them, each with its kind. Use it to discover names before calling build-get_domain_metadata. A project that has not been built, or has no @ExerisDomain sources, returns present:false rather than an error.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("build", handle, async ({ project }) => {
      const dir = resolveMetadataDir(project);
      if (dir.kind === "error") return dir.result;
      if (dir.kind === "absent") return notBuiltAnswer();

      let entries: MetadataEntry[];
      try {
        entries = readdirSync(dir.path)
          .map(classifyMetadataFile)
          .filter((e): e is MetadataEntry => e !== null)
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      } catch {
        return notBuiltAnswer();
      }

      return jsonResult({
        present: true,
        entries,
        counts: Object.fromEntries(
          KINDS.map((kind) => [kind, entries.filter((e) => e.kind === kind).length]),
        ),
      });
    }),
  };
}

function getDomainMetadataTool(handle: BuildFamily): RegisteredTool {
  return {
    definition: {
      name: "build-get_domain_metadata",
      description:
        "Fetch the DomainMetadata JSON the annotation processor emitted for one declaration of this project — the authoritative AST the code generators consume, including fields, actions, events, relationships and the system-field flags. `name` is the Java simple name (e.g. 'Station'), as listed by build-list_domains. Returns the record verbatim, plus the schemaVersion and (when the build could compute one) the ADR-042 sourceDigest.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Java simple name of the entity, enum, capability or view.",
          },
          kind: {
            type: "string",
            enum: [...KINDS],
            description: "Which kind of declaration to read. Defaults to 'domain'.",
          },
        },
        required: ["name"],
      },
    },
    handler: guard("build", handle, async ({ project }, args) => {
      const name = args.name;
      if (typeof name !== "string" || name.trim().length === 0) {
        return errorResult("'name' is required and must be a non-empty string.");
      }
      const kind = args.kind ?? "domain";
      if (typeof kind !== "string" || !KINDS.includes(kind as MetadataKind)) {
        return errorResult(`'kind' must be one of: ${KINDS.join(", ")}.`);
      }
      // Checked against the grammar it is meant to satisfy before it is ever
      // joined into a path. The sandbox below still decides; this only means a
      // fat-fingered name gets a sentence about names.
      if (!isJavaSimpleName(name.trim())) {
        return errorResult(
          `'${name}' is not a Java simple name. Pass the bare type name, such as 'Station' — not a package-qualified name, a file path, or a filename.`,
        );
      }

      const dir = resolveMetadataDir(project);
      if (dir.kind === "error") return dir.result;
      if (dir.kind === "absent") return notBuiltAnswer();

      const fileName = `${prefixFor(kind as MetadataKind)}${name.trim()}.json`;
      let raw: string;
      try {
        raw = readFileSync(resolveInside(dir.path, join(dir.path, fileName)), "utf8");
      } catch (err) {
        if (err instanceof SandboxEscapeError && err.resolved !== null) {
          return errorResult(
            `${fileName} resolves outside the project's metadata directory (sandbox escape); refusing to read it.`,
          );
        }
        return errorResult(notFoundMessage(dir.path, name.trim(), kind as MetadataKind));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return errorResult(
          `${METADATA_DIR}/${fileName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const envelope = parseMetadataEnvelope(parsed, `${METADATA_DIR}/${fileName}`);
        return jsonResult({
          name: envelope.entityName,
          kind,
          packageName: envelope.packageName,
          schemaVersion: envelope.schemaVersion,
          // Null when the build could not compute one — an incremental or IDE
          // build without the Compiler Tree API. Normal, not damaged.
          sourceDigest: envelope.sourceDigest,
          metadata: envelope.metadata,
        });
      } catch (err) {
        if (err instanceof MetadataShapeError) return errorResult(err.message);
        throw err;
      }
    }),
  };
}

type DirResolution =
  | { kind: "ok"; path: string }
  | { kind: "absent" }
  | { kind: "error"; result: CallToolResult };

/**
 * Resolve the metadata directory inside the pinned project root.
 *
 * The path is the bridge's own constant, not agent input, and it is still
 * sandbox-checked: `target/` is build output, a build can be configured to
 * symlink it, and "we wrote this string ourselves" is not containment.
 */
function resolveMetadataDir(project: ProjectConfig): DirResolution {
  try {
    return { kind: "ok", path: resolveInside(project.projectRoot, join(project.projectRoot, METADATA_DIR)) };
  } catch (err) {
    if (err instanceof SandboxEscapeError && err.resolved !== null) {
      return {
        kind: "error",
        result: errorResult(
          `${METADATA_DIR} resolves outside the project root (sandbox escape); refusing to read it.`,
        ),
      };
    }
    return { kind: "absent" };
  }
}

/**
 * "You have not built this yet" is an answer with an obvious next step, so it
 * is not an error — the same discipline `caps:*` applies to a cap-less project.
 * An agent that reads this as a broken server stops asking; one that reads it
 * as state runs the build and asks again.
 */
function notBuiltAnswer() {
  return jsonResult({
    present: false,
    reason: `This project has no ${METADATA_DIR} directory, so the annotation processor has not written any metadata yet.`,
    remedy:
      "Build the project (for example `mvn compile`). If it builds and this stays empty, the sources declare no @ExerisDomain types.",
    entries: [],
  });
}

/** A miss the agent can act on: say what is actually there. */
function notFoundMessage(dir: string, name: string, kind: MetadataKind): string {
  let available: MetadataEntry[] = [];
  try {
    available = readdirSync(dir)
      .map(classifyMetadataFile)
      .filter((e): e is MetadataEntry => e !== null && e.kind === kind);
  } catch {
    available = [];
  }
  const known =
    available.length === 0
      ? `This build emitted no ${kind} metadata at all.`
      : `Known ${kind} names: ${available.map((e) => e.name).sort((a, b) => a.localeCompare(b)).join(", ")}.`;
  return `No ${kind} metadata for '${name}' in ${METADATA_DIR}. ${known} Call build-list_domains for the full inventory.`;
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
