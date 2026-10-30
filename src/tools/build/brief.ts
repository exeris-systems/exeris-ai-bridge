import { createHash } from "node:crypto";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parseAllDocuments } from "yaml";

// The pure half of build-validate_brief: parse a brief, validate it against a
// brief schema, and restate the readiness gate of ADR-106 obligation 7. Nothing
// here touches the filesystem, the network or the project.
//
// The brief contract is owned by exeris-sdk. The schema does the validating;
// this file adds only what the schema cannot say: that a blocking question is
// still open, which questions were decided on credit, and which references to
// the source model resolve. EARS criteria are checked by the structure the
// schema states and never by their text.

/** Largest brief the tool reads, in bytes. */
export const MAX_BRIEF_BYTES = 256 * 1024;

/** Largest brief schema the tool compiles, in bytes. */
export const MAX_SCHEMA_BYTES = 1024 * 1024;

/** Alias expansion a brief may use; a brief has no need of more than a handful. */
export const MAX_YAML_ALIASES = 10;

/** Most validation errors reported for one brief. */
export const MAX_ERRORS = 100;

/** One constraint a brief does not meet, at the JSON pointer of the offending value. */
export interface BriefProblem {
  readonly path: string;
  readonly message: string;
}

/** A question decided on credit. */
export interface BriefAssumption {
  readonly questionId: string | null;
  readonly owner: string | null;
  readonly assumption: string | null;
}

/** A typed reference from a brief to a source element. */
export interface BriefReference {
  readonly kind: "entity" | "action" | "rule" | "saga";
  readonly ref: string;
}

export type ParsedBrief =
  | { readonly kind: "document"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid"; readonly errors: readonly BriefProblem[] };

/**
 * Parse one brief as a single YAML 1.2 core-schema document with no custom
 * tags and a bounded alias expansion; anything else yields problems, never a
 * throw.
 *
 * @param text - The brief's contents, already size-checked by the caller.
 */
export function parseBriefYaml(text: string): ParsedBrief {
  let documents;
  try {
    documents = parseAllDocuments(text, {
      version: "1.2",
      schema: "core",
      customTags: [],
      uniqueKeys: true,
      prettyErrors: false,
    });
  } catch (err) {
    return invalid(`is not readable YAML: ${errorText(err)}`);
  }
  const list = Array.isArray(documents) ? documents : [documents];
  if (list.length === 0) return invalid("no brief: an empty document is not a brief");
  if (list.length > 1) {
    return invalid("holds more than one YAML document; a brief is exactly one");
  }
  const doc = list[0];
  const faults = [...doc.errors, ...doc.warnings];
  if (faults.length > 0) {
    return {
      kind: "invalid",
      errors: faults.slice(0, MAX_ERRORS).map((f) => {
        const line = f.linePos ? ` (line ${f.linePos[0].line})` : "";
        return { path: "", message: `YAML: ${f.message.split("\n")[0]}${line}` };
      }),
    };
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch (err) {
    return invalid(`is not readable YAML: ${errorText(err)}`);
  }
  if (value === null || value === undefined) {
    return invalid("no brief: an empty document is not a brief");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalid("must be a mapping at the top level");
  }
  return { kind: "document", value: value as Record<string, unknown> };
}

function invalid(message: string): ParsedBrief {
  return { kind: "invalid", errors: [{ path: "", message }] };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/** A compiled brief schema. */
export type BriefValidator = (document: unknown) => BriefProblem[];

const MAX_COMPILED = 4;
const compiled = new Map<string, BriefValidator>();

/**
 * Compile a brief schema (JSON Schema draft 2020-12) once per distinct text
 * per process. Throws when the text is not a schema this validator can compile.
 *
 * @param schemaText - The raw `brief-schema.json`.
 */
export function compileBriefSchema(schemaText: string): BriefValidator {
  const key = createHash("sha256").update(schemaText).digest("hex");
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;

  // A fresh instance per schema: two schemas can share an $id, and one
  // instance refuses to hold both. Unknown keywords (the SDK's x-exeris-*
  // annotations) are ignored; nothing is fetched, so a remote $ref cannot load.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate: ValidateFunction = ajv.compile(JSON.parse(schemaText) as object);
  const validator: BriefValidator = (document) => {
    if (validate(document)) return [];
    return toProblems(validate.errors ?? []);
  };
  if (compiled.size >= MAX_COMPILED) {
    const oldest = compiled.keys().next();
    if (!oldest.done) compiled.delete(oldest.value);
  }
  compiled.set(key, validator);
  return validator;
}

/** ajv's error objects as pointer + sentence; the `if` bookkeeping keyword is not a finding. */
function toProblems(errors: readonly ErrorObject[]): BriefProblem[] {
  const seen = new Set<string>();
  const out: BriefProblem[] = [];
  for (const e of errors) {
    if (e.keyword === "if") continue;
    const params = e.params as Record<string, unknown>;
    let path = e.instancePath;
    let message = e.message ?? "is invalid";
    if (e.keyword === "required" && typeof params.missingProperty === "string") {
      path = `${path}/${escapePointer(params.missingProperty)}`;
      message = "is required";
    } else if (e.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
      path = `${path}/${escapePointer(params.additionalProperty)}`;
      message = "is not a property of the brief contract; a brief references the source model and never re-encodes it";
    }
    const key = `${path}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, message });
    if (out.length >= MAX_ERRORS) break;
  }
  return out;
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** The readiness facts the schema cannot state. */
export interface BriefFacts {
  /** A blocking question is still `open`. */
  readonly blockingOpen: boolean;
  /** Every question decided on credit, blocking or not. */
  readonly assumed: readonly BriefAssumption[];
  readonly references: readonly BriefReference[];
}

/**
 * Read the open questions and the source references out of a brief. Tolerates
 * any shape: what is not where the contract puts it contributes nothing, since
 * the schema reports it.
 *
 * @param document - The parsed brief.
 */
export function readBriefFacts(document: Record<string, unknown>): BriefFacts {
  let blockingOpen = false;
  const assumed: BriefAssumption[] = [];
  for (const q of objects(document.openQuestions)) {
    if (q.status === "assumed") {
      assumed.push({
        questionId: text(q.id),
        owner: text(q.owner),
        assumption: text(q.assumption),
      });
    } else if (q.status === "open" && q.blocking === true) {
      blockingOpen = true;
    }
  }

  const references: BriefReference[] = [];
  for (const term of objects(document.glossary)) {
    collectReferences(references, term.fulfilledBy, ["entity"]);
  }
  for (const workflow of objects(document.workflows)) {
    collectReferences(references, workflow.fulfilledBy, ["action", "rule", "saga"]);
  }
  return { blockingOpen, assumed, references };
}

const ENTITY_REF = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const MEMBER_REF = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*#[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A reference counts only when its position admits its kind and its text has that kind's shape. */
function collectReferences(
  into: BriefReference[],
  value: unknown,
  admitted: readonly BriefReference["kind"][],
): void {
  for (const r of objects(value)) {
    const kind = r.kind;
    const ref = r.ref;
    if (typeof kind !== "string" || typeof ref !== "string") continue;
    if (!(admitted as readonly string[]).includes(kind)) continue;
    if (!(kind === "entity" ? ENTITY_REF : MEMBER_REF).test(ref)) continue;
    into.push({ kind: kind as BriefReference["kind"], ref });
  }
}

function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v));
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The verdict on one brief, before skew is attached. */
export interface BriefVerdict {
  readonly valid: boolean;
  readonly ready: boolean;
  readonly errors: readonly BriefProblem[];
  readonly assumed: readonly BriefAssumption[];
  readonly unresolved: readonly BriefReference[];
  readonly unchecked: readonly BriefReference[];
}

/**
 * Restate ADR-106 obligation 7: valid when the schema passes; ready when valid
 * and no blocking question is `open`. A reference that resolves to nothing is
 * reported and does not change readiness.
 *
 * @param errors - What the schema reported; empty when the brief is valid.
 * @param facts - The open questions and references read from the brief.
 * @param source - The source elements the project's metadata declares, or null when it emitted none.
 */
export function judge(
  errors: readonly BriefProblem[],
  facts: BriefFacts,
  source: ReadonlySet<string> | null,
): BriefVerdict {
  const valid = errors.length === 0;
  const unresolved: BriefReference[] = [];
  const unchecked: BriefReference[] = [];
  for (const reference of facts.references) {
    if (source === null) unchecked.push(reference);
    else if (!source.has(referenceKey(reference))) unresolved.push(reference);
  }
  return {
    valid,
    ready: valid && !facts.blockingOpen,
    errors,
    assumed: facts.assumed,
    unresolved,
    unchecked,
  };
}

/** The key a source element and a reference to it share. */
export function referenceKey(reference: BriefReference): string {
  return `${reference.kind}\u0000${reference.ref}`;
}

/** A verdict for a brief that was never validated; it is neither valid nor ready. */
export function refused(message: string, path = ""): BriefVerdict {
  return { valid: false, ready: false, errors: [{ path, message }], assumed: [], unresolved: [], unchecked: [] };
}

/** `MAJOR.MINOR.PATCH` of a version, ignoring any qualifier; null for anything else. */
export function versionCore(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`; null when either is unreadable. */
export function compareCore(a: string, b: string): number | null {
  const x = versionCore(a);
  const y = versionCore(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
