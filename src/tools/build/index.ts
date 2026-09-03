import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BridgeConfig, ProjectConfig, Unavailable } from "../../config/env.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import {
  explainArtefact,
  GENERATED_ROOT,
  GITIGNORE_ENTRY,
  MANIFEST_NAME,
  matchesEntity,
  OWNED_ROOT,
  parseCodegenManifest,
  TEST_GENERATED_ROOT,
} from "./artefacts.js";
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
  return [
    listDomainsTool(handle),
    getDomainMetadataTool(handle),
    explainArtefactsTool(handle),
    getDetachStateTool(handle),
  ];
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

/**
 * The tool the observed failure asked for.
 *
 * An agent building on Exeris hand-wrote an `init-db.sql` and got the column
 * naming wrong, while `KernelFlywayGenerator` was already emitting the CREATE
 * TABLE, its indexes, its CHECK constraints and its RLS policy for that same
 * entity. Nothing was missing. The generated artefact simply was not
 * discoverable from inside the agent's session — so this turns "run the build
 * and look" into a question with an answer.
 */
function explainArtefactsTool(handle: BuildFamily): RegisteredTool {
  return {
    definition: {
      name: "build-explain_artefacts",
      description:
        "List the files Exeris codegen has generated into this project, each with the generator that produced it and what drove it — handlers, services, repositories, domain errors, event publishers, graph projections, sagas, Flyway CREATE TABLE migrations, OpenAPI specs, and the project-wide bootstrap. Ask this BEFORE hand-writing SQL, a DTO or a controller for an Exeris entity: the build usually already emits it. Optional `entity` narrows to one entity's artefacts. Reports what the pipeline actually emitted, read from its own output manifest — a project that has not run codegen returns present:false.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description:
              "Optional Java simple name (e.g. 'Station'). Narrows to the artefacts whose filename carries that name; project-wide artefacts are always included.",
          },
        },
      },
    },
    handler: guard("build", handle, async ({ project }, args) => {
      const entity = args.entity;
      if (entity !== undefined && (typeof entity !== "string" || !isJavaSimpleName(entity.trim()))) {
        return errorResult(
          `'entity' must be a Java simple name such as 'Station' — not a package-qualified name, a file path, or a filename.`,
        );
      }
      const filter = typeof entity === "string" ? entity.trim() : null;

      const roots: { root: string; entries: string[] }[] = [];
      for (const root of [GENERATED_ROOT, TEST_GENERATED_ROOT]) {
        const manifest = readCodegenManifest(project, root);
        if (manifest.kind === "error") return manifest.result;
        if (manifest.kind === "ok") roots.push({ root, entries: manifest.entries });
      }
      if (roots.length === 0) return notGeneratedAnswer();

      const known = knownEntityNames(project);
      const all = roots.flatMap(({ root, entries }) =>
        entries.map((path) => ({ root, ...explainArtefact(path, known, root === TEST_GENERATED_ROOT) })),
      );
      const selected =
        filter === null
          ? all
          : all.filter((a) => a.scope === "project" || matchesEntity(a.path, filter));

      const missing = all
        .filter((a) => !existsInProject(project, `${a.root}/${a.path}`))
        .map((a) => `${a.root}/${a.path}`);

      return jsonResult({
        present: true,
        roots: roots.map(({ root, entries }) => ({ root, generatedFiles: entries.length })),
        total: all.length,
        filter,
        ...(filter === null
          ? {}
          : {
              matched: selected.length,
              note: `Filtered to '${filter}' by filename match, plus every project-wide artefact. A Flyway migration is named after the SQL table, so an entity with an explicit @ExerisDomain(tableName) override can miss this filter — call without 'entity' to see everything.`,
            }),
        artefacts: selected,
        ...(missing.length === 0
          ? {}
          : {
              missingOnDisk: missing,
              missingNote:
                "The codegen manifest lists these paths but they are not on disk. The pipeline still considers them its own; re-running codegen restores them.",
            }),
      });
    }),
  };
}

/**
 * "If I edit this file, does my edit survive the next build?"
 *
 * The answer is ownership, and ownership is recorded rather than inferred:
 * `OutputWriter` writes `.exeris-codegen-manifest` at the root of each output
 * tree listing every path that run emitted, and the next run deletes the paths
 * it no longer produces. A file in that manifest is the pipeline's, full stop.
 *
 * `exeris:detach` (L2) is what changes the answer, and it deliberately destroys
 * the L1 signal: it moves every regular file out of the generated root into
 * src/main/java, prunes the emptied tree, and strips the .gitignore entry.
 * Detecting the AFTER state therefore rests on weaker evidence than the before
 * state, which is why this tool reports the observations and not only a verdict.
 */
function getDetachStateTool(handle: BuildFamily): RegisteredTool {
  return {
    definition: {
      name: "build-get_detach_state",
      description:
        "Report whether this project's generated code is still pipeline-owned (L1, src/main/generated/java — regenerated on every build, so edits are lost) or has been detached into the developer's own sources (L2, src/main/java — owned, safe to edit). Ask this before editing anything under a generated tree. Returns the state, the observations behind it, and how many files the pipeline claims.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: guard("build", handle, async ({ project }) => {
      const evidence: string[] = [];

      const main = readCodegenManifest(project, GENERATED_ROOT);
      if (main.kind === "error") return main.result;
      const tests = readCodegenManifest(project, TEST_GENERATED_ROOT);
      if (tests.kind === "error") return tests.result;
      const promoted = readCodegenManifest(project, OWNED_ROOT);
      if (promoted.kind === "error") return promoted.result;

      const roots: { root: string; layer: "L1" | "L2"; ownedByPipeline: number }[] = [];
      if (main.kind === "ok") {
        roots.push({ root: GENERATED_ROOT, layer: "L1", ownedByPipeline: main.entries.length });
        evidence.push(
          `${GENERATED_ROOT}/${MANIFEST_NAME} is present and lists ${main.entries.length} file(s); the pipeline owns them.`,
        );
      }
      if (tests.kind === "ok") {
        roots.push({ root: TEST_GENERATED_ROOT, layer: "L1", ownedByPipeline: tests.entries.length });
        evidence.push(
          `${TEST_GENERATED_ROOT}/${MANIFEST_NAME} is present and lists ${tests.entries.length} file(s) — the generated-test root is a separate output tree with its own manifest (ADR-058), and exeris:detach defaults do not cover it.`,
        );
      }
      if (promoted.kind === "ok") {
        roots.push({ root: OWNED_ROOT, layer: "L2", ownedByPipeline: 0 });
        evidence.push(
          `${OWNED_ROOT}/${MANIFEST_NAME} is present, listing ${promoted.entries.length} file(s). Detach promotes every regular file under the generated root, and the manifest sits at that root, so it travels with them. It is a record of what was promoted, not a claim of ownership — codegen does not write into ${OWNED_ROOT}.`,
        );
      }

      const ignored = gitignoreCarriesGeneratedEntry(project);
      if (ignored === true) {
        evidence.push(
          `.gitignore still carries '${GITIGNORE_ENTRY}', which exeris:detach removes — so this project has not detached. (The reverse does not follow: nothing in the build ever ADDS that entry, so its absence is not evidence of a detach.)`,
        );
      } else if (ignored === false) {
        evidence.push(
          `.gitignore does not carry '${GITIGNORE_ENTRY}'. That is not evidence either way — nothing in the build ever adds the entry, so it may simply never have been there.`,
        );
      }

      const state =
        main.kind === "ok" ? "l1_generated" : promoted.kind === "ok" ? "l2_detached" : "not_generated";

      return jsonResult({ state, summary: SUMMARIES[state], roots, evidence, guidance: GUIDANCE[state] });
    }),
  };
}

const SUMMARIES = {
  l1_generated: `Generated code is pipeline-owned (L1), under ${GENERATED_ROOT}.`,
  l2_detached: `Generated code has been detached (L2) — the developer owns it under ${OWNED_ROOT}.`,
  not_generated: "No Exeris-generated tree was found in this project.",
} as const;

const GUIDANCE = {
  l1_generated: `Do not edit these files. The next \`mvn exeris:generate\` rewrites every one of them, and deletes any it no longer emits, so an edit is lost silently. To take ownership, run \`mvn exeris:detach\` — it moves the tree into ${OWNED_ROOT}, never overwrites a file already there, and reports a conflict instead. To change what is generated, change the @ExerisDomain source and rebuild.`,
  l2_detached: `These files are the developer's. Codegen does not write into ${OWNED_ROOT}, so edits are safe and permanent — and correspondingly, changing the @ExerisDomain source no longer updates them.`,
  not_generated: "Run `mvn exeris:generate` (it is bound to generate-sources, so `mvn compile` runs it too). If it produces nothing, the project declares no @ExerisDomain types, or the codegen plugin is not configured.",
} as const;

type ManifestResolution =
  | { kind: "ok"; entries: string[] }
  | { kind: "absent" }
  | { kind: "error"; result: CallToolResult };

/**
 * Read one output tree's manifest, inside the pinned project root.
 *
 * The path is the bridge's own constant, and it is still sandbox-checked for
 * the same reason `resolveMetadataDir` is: a source tree can be symlinked, and
 * "we wrote this string ourselves" is not containment.
 */
function readCodegenManifest(project: ProjectConfig, root: string): ManifestResolution {
  const rel = `${root}/${MANIFEST_NAME}`;
  try {
    const path = resolveInside(project.projectRoot, join(project.projectRoot, rel));
    return { kind: "ok", entries: parseCodegenManifest(readFileSync(path, "utf8")) };
  } catch (err) {
    if (err instanceof SandboxEscapeError && err.resolved !== null) {
      return {
        kind: "error",
        result: errorResult(`${rel} resolves outside the project root (sandbox escape); refusing to read it.`),
      };
    }
    return { kind: "absent" };
  }
}

/** Normalised the way DetachService compares it: trimmed, leading and trailing slash dropped. */
function gitignoreCarriesGeneratedEntry(project: ProjectConfig): boolean | null {
  try {
    const path = resolveInside(project.projectRoot, join(project.projectRoot, ".gitignore"));
    const lines = readFileSync(path, "utf8").split("\n");
    return lines.some((line) => line.trim().replace(/^\//, "").replace(/\/$/, "") === GITIGNORE_ENTRY);
  } catch {
    return null;
  }
}

/** Domain names from the last build, or an empty list when it has not run. */
function knownEntityNames(project: ProjectConfig): string[] {
  const dir = resolveMetadataDir(project);
  if (dir.kind !== "ok") return [];
  try {
    return readdirSync(dir.path)
      .map(classifyMetadataFile)
      .filter((e): e is MetadataEntry => e !== null && e.kind === "domain")
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function existsInProject(project: ProjectConfig, rel: string): boolean {
  try {
    resolveInside(project.projectRoot, join(project.projectRoot, rel));
    return true;
  } catch {
    return false;
  }
}

/** Symmetric with notBuiltAnswer(): a state with an obvious next step, not an error. */
function notGeneratedAnswer() {
  return jsonResult({
    present: false,
    reason: `This project has no codegen output manifest under ${GENERATED_ROOT} or ${TEST_GENERATED_ROOT}, so Exeris codegen has not written a tree here.`,
    remedy:
      "Run `mvn exeris:generate` (bound to generate-sources, so `mvn compile` runs it too). If the project has already run `mvn exeris:detach`, the tree is owned rather than generated — call build-get_detach_state.",
    artefacts: [],
  });
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
