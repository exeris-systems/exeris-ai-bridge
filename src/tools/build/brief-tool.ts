import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ProjectConfig, Unavailable } from "../../config/env.js";
import { findArtifactJar, resolveLocalRepository } from "../../config/maven.js";
import { assertBriefSchemaFormat, BriefSchemaFormatError, type BriefSchemaState } from "../../data/brief-schema.js";
import { readJarEntry } from "../../data/jar-entry.js";
import { resolveInside, SandboxEscapeError } from "../../fs/sandbox.js";
import type { RegisteredTool } from "../types.js";
import { guard } from "../unavailable.js";
import { resolveProjectSdkVersion, type SdkVersionResolution } from "../sdk/skew.js";
import {
  compareCore,
  compileBriefSchema,
  judge,
  MAX_BRIEF_BYTES,
  MAX_SCHEMA_BYTES,
  parseBriefYaml,
  readBriefFacts,
  refused,
  versionCore,
  UnknownReaderRequirementError,
  type BriefValidator,
  type BriefVerdict,
} from "./brief.js";
import { readBriefSource, type BriefSource } from "./brief-source.js";

// build-validate_brief. Reads docs/briefs/*.brief.yaml of the user's project and
// the brief schema; writes nothing, starts no process and opens no network
// connection. The brief contract is the SDK's (ADR-106); this tool is its
// validator and nothing else.

/** Where briefs live, relative to the project root. */
export const BRIEFS_DIR = "docs/briefs";

/** What a brief file is called: `<area>.brief.yaml`. */
export const BRIEF_SUFFIX = ".brief.yaml";

/** Most briefs validated in one call; more than this needs an `area`. */
export const MAX_BRIEFS = 50;

/** Most stray file names listed under `ignored`. */
export const MAX_IGNORED = 20;

/** An area is a name, never a path. */
export const AREA_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_AREA_LENGTH = 64;

/** The first SDK release that carries the brief contract. */
export const FIRST_BRIEF_SDK = "0.13.0";

const SCHEMA_ENTRY = "META-INF/exeris/brief-schema.json";
const SDK_SOURCE_MODEL = { groupId: "eu.exeris", artifactId: "exeris-sdk-source-model" } as const;

type Handle = { readonly state: "available"; readonly project: ProjectConfig } | Unavailable;

/** Test seams; production reads the process environment. */
export interface BriefDeps {
  readonly env?: NodeJS.ProcessEnv;
}

type SchemaSource = "project" | "bundled";

interface Contract {
  readonly validate: BriefValidator;
  /** The SDK release a brief is held to: the used schema's own, else the project's pin. */
  readonly reference: string | null;
  readonly skew: Record<string, unknown>;
}

export function validateBriefTool(
  handle: Handle,
  briefSchema: BriefSchemaState,
  deps: BriefDeps = {},
): RegisteredTool {
  return {
    definition: {
      name: "build-validate_brief",
      description:
        `Check the pre-construction brief(s) of this project, docs/briefs/<area>.brief.yaml, against the brief schema (ADR-106) and say whether each is ready for authoring. Reads only the brief files, the project's pom.xml (and the app BOM poms it inherits from, read from the local Maven repository), the brief schema and, when present, target/classes/exeris-metadata; writes nothing, starts no process and uses no network, and is local only: the family needs the project root, so private product intent never reaches a hosted endpoint. The schema is the one inside the project's pinned eu.exeris:exeris-sdk-source-model jar in the local Maven repository (never downloaded), else the schema bundled with this bridge; \`skew.schemaSource\` says which. A project pinned below SDK ${FIRST_BRIEF_SDK} has no brief contract and gets a reason instead. A brief whose briefSchema is newer than the SDK of the schema used is returned valid:false, ready:false with the skew reported, and is not validated. \`valid\` means the schema passes. \`ready\` means valid and no blocking open question is still 'open'; an absent, empty or invalid brief is never ready. \`assumed\` lists the questions decided on credit with their owner. EARS criteria are checked by structure, never by text. Where the project has been built, each fulfilledBy reference is resolved against the emitted DomainMetadata (an entity by qualified class name; an action, rule or saga as <entity>#<member>); \`unresolved\` names those that match nothing and does not change readiness, and without metadata every reference is \`unchecked\`. Optional \`area\` names one brief; without it every brief directly under docs/briefs is validated, up to ${MAX_BRIEFS}.`,
      inputSchema: {
        type: "object",
        properties: {
          area: {
            type: "string",
            pattern: AREA_PATTERN.source,
            maxLength: MAX_AREA_LENGTH,
            description:
              "Optional name of one bounded area (lowercase letters, digits and hyphens): validates docs/briefs/<area>.brief.yaml. A name, never a path.",
          },
        },
      },
    },
    handler: guard("build", handle, async ({ project }, args) => {
      const area = args.area;
      if (area !== undefined) {
        if (typeof area !== "string" || area.length > MAX_AREA_LENGTH || !AREA_PATTERN.test(area)) {
          return errorResult(
            `'area' must be a name of lowercase letters, digits and hyphens, at most ${MAX_AREA_LENGTH} characters, such as 'billing' — not a path or a filename.`,
          );
        }
      }

      const dir = resolveBriefsDir(project);
      if (dir.kind === "error") return errorResult(dir.message);

      const names =
        dir.kind === "absent"
          ? { areas: [] as string[], ignored: [] as string[] }
          : listAreas(dir.path);
      const requested = typeof area === "string" ? [area] : names.areas;
      if (requested.length > MAX_BRIEFS) {
        return errorResult(
          `${BRIEFS_DIR} holds ${requested.length} briefs; the limit is ${MAX_BRIEFS} per call. Pass 'area' to validate one.`,
        );
      }
      const stray = {
        ignored: names.ignored.slice(0, MAX_IGNORED),
        ignoredTruncated: names.ignored.length > MAX_IGNORED,
      };
      if (requested.length === 0) {
        return jsonResult({
          present: false,
          briefs: [],
          referenceSource: describeSource(undefined),
          ...stray,
          notice: `No briefs exist: ${BRIEFS_DIR} holds no *${BRIEF_SUFFIX} file, so nothing is ready. Write the discovery brief to ${BRIEFS_DIR}/<area>${BRIEF_SUFFIX} (the brief schema is the resource exeris://sdk/brief-schema), then call this again.`,
        });
      }

      const contract = resolveContract(project, briefSchema, deps.env ?? process.env);
      if ("result" in contract) return contract.result;

      const memo: { source?: BriefSource } = {};
      let filesRead = 0;
      const briefs = requested.map((name) => {
        const read = dir.kind === "ok" ? readBrief(dir.path, name) : ({ kind: "absent" } as const);
        if (read.kind === "absent") {
          return entry(name, refused(`no brief: ${BRIEFS_DIR}/${name}${BRIEF_SUFFIX} does not exist`), contract.skew);
        }
        if (read.kind === "refused") return entry(name, refused(read.message), contract.skew);
        filesRead += 1;

        const parsed = parseBriefYaml(read.text);
        if (parsed.kind === "invalid") {
          return entry(name, { ...refused(""), errors: parsed.errors }, contract.skew);
        }
        const declared = parsed.value.briefSchema;
        if (
          contract.reference !== null &&
          typeof declared === "string" &&
          (compareCore(declared, contract.reference) ?? 0) > 0
        ) {
          const warning = `The brief's briefSchema ${declared} is newer than the SDK ${contract.reference} whose brief schema was used, so it was not validated.`;
          return entry(
            name,
            refused(`${warning} Raise the project's SDK version to ${declared} or later, or write the brief against ${contract.reference}.`, "/briefSchema"),
            {
              ...contract.skew,
              status: "skew_detected",
              briefSchema: declared,
              warning: [contract.skew.warning, warning].filter((w) => typeof w === "string").join(" "),
            },
          );
        }

        memo.source ??= readBriefSource(project);
        const elements = memo.source.state === "present" ? memo.source.elements : null;
        const verdict = judge(contract.validate(parsed.value), readBriefFacts(parsed.value), elements);
        return entry(name, verdict, {
          ...contract.skew,
          ...(typeof declared === "string" ? { briefSchema: declared } : {}),
        });
      });

      return jsonResult({
        present: filesRead > 0,
        briefs,
        referenceSource: describeSource(memo.source),
        ...stray,
        notice: null,
      });
    }),
  };
}

function describeSource(source: BriefSource | undefined) {
  if (source === undefined) {
    return { state: "not_read", note: "No brief reached reference resolution, so the emitted metadata was not read." };
  }
  if (source.state === "absent") {
    return { state: "absent", note: "target/classes/exeris-metadata does not exist, so every fulfilledBy reference is unchecked." };
  }
  return source.state === "unusable" ? { state: "unusable", reason: source.reason } : { state: "present" };
}

function entry(area: string, verdict: BriefVerdict, skew: Record<string, unknown>) {
  return {
    area,
    valid: verdict.valid,
    ready: verdict.ready,
    errors: verdict.errors,
    assumed: verdict.assumed,
    unresolved: verdict.unresolved,
    unchecked: verdict.unchecked,
    skew,
  };
}

type DirResolution =
  | { readonly kind: "ok"; readonly path: string }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly message: string };

/** The briefs directory's real path, confined to the project root. */
function resolveBriefsDir(project: ProjectConfig): DirResolution {
  try {
    const path = resolveInside(project.projectRoot, join(project.projectRoot, BRIEFS_DIR));
    return statSync(path).isDirectory() ? { kind: "ok", path } : { kind: "absent" };
  } catch (err) {
    if (err instanceof SandboxEscapeError && err.resolved !== null) {
      return { kind: "error", message: `${BRIEFS_DIR} resolves outside the project root (sandbox escape); refusing to read it.` };
    }
    return { kind: "absent" };
  }
}

/** Areas with a brief directly under the directory; files that are not named as an area are ignored, and named. */
function listAreas(dir: string): { areas: string[]; ignored: string[] } {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { areas: [], ignored: [] };
  }
  const areas: string[] = [];
  const ignored: string[] = [];
  for (const file of files.toSorted((a, b) => a.localeCompare(b))) {
    if (!file.endsWith(BRIEF_SUFFIX)) continue;
    const name = file.slice(0, -BRIEF_SUFFIX.length);
    if (AREA_PATTERN.test(name) && name.length <= MAX_AREA_LENGTH) areas.push(name);
    else ignored.push(file);
  }
  return { areas, ignored };
}

type BriefRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly message: string };

/** One brief's text, confined to the briefs directory and read no further than the size limit. */
function readBrief(dir: string, area: string): BriefRead {
  const file = `${area}${BRIEF_SUFFIX}`;
  let path: string;
  try {
    path = resolveInside(dir, join(dir, file));
  } catch (err) {
    if (err instanceof SandboxEscapeError && err.resolved !== null) {
      return { kind: "refused", message: `${BRIEFS_DIR}/${file} resolves outside ${BRIEFS_DIR} (sandbox escape); refusing to read it.` };
    }
    return { kind: "absent" };
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "refused", message: `${BRIEFS_DIR}/${file} is not a regular file.` };
    if (stat.size > MAX_BRIEF_BYTES) {
      return { kind: "refused", message: `${BRIEFS_DIR}/${file} is ${stat.size} bytes; the limit is ${MAX_BRIEF_BYTES}. It was not read.` };
    }
    const buffer = Buffer.alloc(MAX_BRIEF_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (n === 0) break;
      length += n;
    }
    if (length > MAX_BRIEF_BYTES) {
      return { kind: "refused", message: `${BRIEFS_DIR}/${file} is larger than ${MAX_BRIEF_BYTES} bytes. It was not read.` };
    }
    return { kind: "ok", text: buffer.toString("utf8", 0, length) };
  } catch {
    return { kind: "refused", message: `${BRIEFS_DIR}/${file} could not be read.` };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sameVersion(a: string, b: string): boolean {
  const c = compareCore(a, b);
  return c === null ? a === b : c === 0;
}

/**
 * Choose the schema: the pinned SDK's own, else the bundled one. A refusal
 * carries the structured result to return as it is.
 */
function resolveContract(
  project: ProjectConfig,
  bundled: BriefSchemaState,
  env: NodeJS.ProcessEnv,
): Contract | { readonly result: CallToolResult } {
  const resolution = resolveProjectSdkVersion(project.projectRoot, env);
  const pin = resolution.version !== null && versionCore(resolution.version) !== null ? resolution.version : null;
  const bundledVersion = bundled.state === "available" ? bundledSdkVersion(bundled.text, bundled.sourceArtifact) : "unknown";

  const skewOf = (source: SchemaSource, schemaSdkVersion: string, note?: string): Record<string, unknown> =>
    skewReport(resolution, pin, bundledVersion, source, schemaSdkVersion, note);
  const referenceOf = (schemaSdkVersion: string): string | null =>
    versionCore(schemaSdkVersion) !== null ? schemaSdkVersion : pin;

  if (pin !== null && (compareCore(pin, FIRST_BRIEF_SDK) ?? 0) < 0) {
    return {
      result: jsonResult(
        {
          error: "brief_contract_unsupported",
          reason: `This project pins Exeris SDK ${pin}, which predates the brief contract (first carried by ${FIRST_BRIEF_SDK}). No brief was validated.`,
          remedy: `Raise the project's eu.exeris SDK version to ${FIRST_BRIEF_SDK} or later, then call this again.`,
          skew: skewOf("bundled", bundledVersion),
        },
        true,
      ),
    };
  }

  let note: string | undefined;
  if (pin !== null) {
    const fromProject = projectSchema(pin, env);
    if (fromProject.kind === "ok") {
      const version = schemaVersionOf(fromProject.text) ?? pin;
      try {
        return { validate: compileBriefSchema(fromProject.text), reference: referenceOf(version), skew: skewOf("project", version) };
      } catch (err) {
        const unknown = err instanceof UnknownReaderRequirementError;
        return {
          result: jsonResult(
            {
              error: "brief_schema_unusable",
              reason: unknown
                ? `The brief schema in the project's pinned eu.exeris:exeris-sdk-source-model:${pin} jar cannot be used: ${err.message}, and validating without it would call an invalid brief valid.`
                : `The brief schema in the project's pinned eu.exeris:exeris-sdk-source-model:${pin} jar cannot be compiled as JSON Schema draft 2020-12.`,
              remedy: unknown
                ? "Upgrade @exeris/ai-bridge to a release that implements this requirement."
                : "Rebuild or re-download that SDK release into the local Maven repository.",
              skew: skewOf("project", version),
            },
            true,
          ),
        };
      }
    }
    if (fromProject.kind === "refused") {
      return {
        result: jsonResult(
          { error: "brief_schema_format_unsupported", reason: fromProject.reason, remedy: fromProject.remedy, skew: skewOf("project", pin) },
          true,
        ),
      };
    }
    note = fromProject.reason;
  }

  if (bundled.state !== "available") {
    return {
      result: jsonResult(
        {
          error: "brief_schema_unavailable",
          reason: bundled.reason,
          remedy: bundled.remedy,
          skew: skewOf("bundled", bundledVersion, note),
        },
        true,
      ),
    };
  }
  try {
    return {
      validate: compileBriefSchema(bundled.text),
      reference: referenceOf(bundledVersion),
      skew: skewOf("bundled", bundledVersion, note),
    };
  } catch (err) {
    return {
      result: jsonResult(
        {
          error: "brief_schema_unusable",
          reason:
            err instanceof UnknownReaderRequirementError
              ? `The bundled brief schema cannot be used: ${err.message}, and validating without it would call an invalid brief valid.`
              : "The bundled brief schema cannot be compiled as JSON Schema draft 2020-12.",
          remedy: "Upgrade @exeris/ai-bridge.",
          skew: skewOf("bundled", bundledVersion, note),
        },
        true,
      ),
    };
  }
}

/**
 * The `sdk-*` skew shape, computed from the SDK release of the schema actually
 * used against the release the project pins.
 */
function skewReport(
  resolution: SdkVersionResolution,
  pin: string | null,
  bundledVersion: string,
  source: SchemaSource,
  schemaSdkVersion: string,
  note: string | undefined,
): Record<string, unknown> {
  let status: "aligned" | "skew_detected" | "unknown";
  let reason: string | undefined;
  let warning: string | undefined;
  if (pin === null) {
    status = "unknown";
    reason = resolution.reason ?? "The project's pinned SDK version could not be read from its pom.xml.";
  } else if (versionCore(schemaSdkVersion) === null) {
    status = "unknown";
    reason = "The brief schema used does not state which SDK it came from.";
  } else if (sameVersion(pin, schemaSdkVersion)) {
    status = "aligned";
  } else {
    status = "skew_detected";
    warning =
      source === "bundled"
        ? `Project pins Exeris SDK ${pin}, but the brief schema used is the one bundled with this bridge, from ${schemaSdkVersion}.`
        : `Project pins Exeris SDK ${pin}, but the brief schema in its jar declares ${schemaSdkVersion}.`;
  }
  return {
    status,
    bundledSdkVersion: bundledVersion,
    ...(pin === null ? {} : { projectSdkVersion: pin }),
    ...(resolution.source === undefined ? {} : { source: resolution.source }),
    ...(resolution.coordinate === undefined ? {} : { sourceCoordinate: resolution.coordinate }),
    ...(reason === undefined ? {} : { reason }),
    ...(warning === undefined ? {} : { warning }),
    schemaSource: source,
    schemaSdkVersion,
    ...(note === undefined ? {} : { note }),
  };
}

type ProjectSchema =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string; readonly remedy: string };

/** The brief schema inside the pinned source-model jar in the local Maven repository; nothing is fetched. */
function projectSchema(pin: string, env: NodeJS.ProcessEnv): ProjectSchema {
  const repo = resolveLocalRepository(env);
  const jar = repo === null ? null : findArtifactJar(repo, SDK_SOURCE_MODEL, pin);
  if (jar === null) {
    return {
      kind: "absent",
      reason: `eu.exeris:exeris-sdk-source-model:${pin} is not in the local Maven repository, so the bundled brief schema was used. Run mvn once to populate it; the bridge never downloads.`,
    };
  }
  const read = readJarEntry(jar, SCHEMA_ENTRY, MAX_SCHEMA_BYTES);
  if (read.kind === "absent") {
    return {
      kind: "absent",
      reason: `eu.exeris:exeris-sdk-source-model:${pin} carries no ${SCHEMA_ENTRY}, so the bundled brief schema was used.`,
    };
  }
  if (read.kind === "failed") {
    return {
      kind: "absent",
      reason: `${SCHEMA_ENTRY} could not be read from eu.exeris:exeris-sdk-source-model:${pin}: ${read.reason}. The bundled brief schema was used.`,
    };
  }
  const text = read.bytes.toString("utf8");
  try {
    assertBriefSchemaFormat(text);
  } catch (err) {
    if (err instanceof BriefSchemaFormatError) {
      return {
        kind: "refused",
        reason: `The brief schema in the project's pinned SDK ${pin} cannot be used: ${err.message}.`,
        remedy: "Upgrade @exeris/ai-bridge to a release that reads this brief schema format.",
      };
    }
    throw err;
  }
  return { kind: "ok", text };
}

/** The SDK version a brief schema declares for itself. */
function schemaVersionOf(text: string): string | null {
  try {
    const v = (JSON.parse(text) as Record<string, unknown>).sdkVersion;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The bundled schema's own `sdkVersion`, else the version in the coordinate it was vendored from. */
function bundledSdkVersion(text: string, sourceArtifact: string): string {
  const declared = schemaVersionOf(text);
  if (declared !== null) return declared;
  const last = sourceArtifact.split(":").pop();
  return last !== undefined && versionCore(last) !== null ? last : "unknown";
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
