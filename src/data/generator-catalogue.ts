import type { Unavailable } from "../config/env.js";
import { readBundleEntry, type BundleState } from "./bundle.js";

// The generator catalogue: the codegen pipeline's own table of which generator
// writes which path shape (`META-INF/exeris/generator-catalogue.json`, shipped
// in `eu.exeris:exeris-codegen-java`). The bridge vendors it at pack time and
// reads it here; it keeps no table of its own.
//
// The pin is `catalogueFormat`, not the tooling version. The format is the
// publisher's statement that an existing key has not been removed or changed
// meaning or type; every other change (rows, wording, new keys) is additive and
// is read as it comes. A format this build does not know is refused rather than
// half-read, both when the catalogue is vendored and when it is loaded.

/** The only `catalogueFormat` this build understands. */
export const SUPPORTED_CATALOGUE_FORMAT = 1;

/** Bundle entry id the catalogue is vendored under. */
export const GENERATOR_CATALOGUE_ENTRY = "generator-catalogue";

export interface GeneratorRow {
  readonly id: string;
  readonly generator: string;
  readonly artefact: string;
  readonly outputRoot: "main" | "test";
  readonly pathPattern: string;
  readonly pathTemplate: string;
  readonly scope: "entity" | "project";
  readonly cardinality: string;
  readonly condition: string;
  readonly ambiguousWith: readonly string[];
  readonly adr: string | null;
  /** Compiled `pathPattern`. Anchored by the publisher; used as written. */
  readonly pattern: RegExp;
}

export interface GeneratorCatalogue {
  readonly catalogueFormat: number;
  /** In catalogue order, which is the matching order. */
  readonly rows: readonly GeneratorRow[];
}

export class CatalogueFormatError extends Error {}

/**
 * Parse and validate a catalogue. Throws {@link CatalogueFormatError} on an
 * unknown `catalogueFormat` or a row this build cannot use.
 *
 * Unknown keys are ignored, as the publisher requires of consumers. Rows whose
 * `outputRoot` is neither `main` nor `test` (`ts` is reserved for a catalogue
 * this bridge does not read) are skipped: they describe a tree no manifest this
 * tool reads sits in.
 */
export function parseGeneratorCatalogue(text: string): GeneratorCatalogue {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogueFormatError("the generator catalogue is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new CatalogueFormatError("the generator catalogue is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.catalogueFormat !== SUPPORTED_CATALOGUE_FORMAT) {
    throw new CatalogueFormatError(
      `the generator catalogue declares catalogueFormat ${JSON.stringify(obj.catalogueFormat)}; this bridge reads format ${SUPPORTED_CATALOGUE_FORMAT}`,
    );
  }
  if (!Array.isArray(obj.rows)) {
    throw new CatalogueFormatError("the generator catalogue has no rows array");
  }

  const rows: GeneratorRow[] = [];
  for (const candidate of obj.rows) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new CatalogueFormatError("a generator catalogue row is not an object");
    }
    const r = candidate as Record<string, unknown>;
    if (r.outputRoot !== "main" && r.outputRoot !== "test") continue;
    const id = typeof r.id === "string" ? r.id : "<no id>";
    if (
      typeof r.id !== "string" ||
      typeof r.generator !== "string" ||
      typeof r.artefact !== "string" ||
      typeof r.pathPattern !== "string" ||
      typeof r.pathTemplate !== "string" ||
      (r.scope !== "entity" && r.scope !== "project") ||
      typeof r.cardinality !== "string" ||
      typeof r.condition !== "string" ||
      !Array.isArray(r.ambiguousWith) ||
      !r.ambiguousWith.every((a) => typeof a === "string") ||
      (r.adr !== null && typeof r.adr !== "string")
    ) {
      throw new CatalogueFormatError(`generator catalogue row '${id}' does not have the format-1 shape`);
    }
    const violation = patternViolation(r.pathPattern);
    if (violation !== null) {
      throw new CatalogueFormatError(
        `generator catalogue row '${id}' has a pathPattern outside the portable subset: ${violation}`,
      );
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(r.pathPattern);
    } catch {
      throw new CatalogueFormatError(`generator catalogue row '${id}' has a pathPattern that is not a regular expression`);
    }
    rows.push({
      id: r.id,
      generator: r.generator,
      artefact: r.artefact,
      outputRoot: r.outputRoot,
      pathPattern: r.pathPattern,
      pathTemplate: r.pathTemplate,
      scope: r.scope,
      cardinality: r.cardinality,
      condition: r.condition,
      ambiguousWith: r.ambiguousWith,
      adr: r.adr,
      pattern,
    });
  }
  if (rows.length === 0) throw new CatalogueFormatError("the generator catalogue has no usable rows");
  return { catalogueFormat: SUPPORTED_CATALOGUE_FORMAT, rows };
}

/**
 * Why a `pathPattern` falls outside the subset ADR-097 allows, or null.
 *
 * The publisher fixes one subset that Java's `java.util.regex` and ECMAScript
 * read the same way: an anchored pattern of literals, `.`, bracket classes,
 * `?`, `*`, `+`, `{n}`, non-capturing groups and alternation. A pattern outside
 * it could match different paths here than it does upstream, so it is refused
 * rather than run. Escapes are limited to punctuation, which rules out the
 * shorthand and Unicode property classes and backreferences in one step.
 */
export function patternViolation(pattern: string): string | null {
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) {
    return "it is not anchored with ^ and $";
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "\\") {
      const next = pattern.charAt(i + 1);
      if (next === "" || /[A-Za-z0-9]/.test(next)) return `the escape \\${next} is not a punctuation literal`;
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if (c === "[") return "a nested bracket class";
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(" && !pattern.startsWith("(?:", i)) return "a group other than a non-capturing group";
    else if (c === "{" && !/^\{[0-9]+\}/.test(pattern.slice(i))) return "a quantifier other than {n}";
  }
  return inClass ? "an unterminated bracket class" : null;
}

export interface AvailableCatalogue {
  readonly state: "available";
  readonly catalogue: GeneratorCatalogue;
  /** Maven coordinate the catalogue was vendored from. */
  readonly sourceArtifact: string;
}

export type CatalogueState = AvailableCatalogue | Unavailable;

/**
 * Load the vendored catalogue from the bundle. Never throws: every failure is
 * a state with a reason and a remedy.
 */
export function loadGeneratorCatalogue(bundle: BundleState, rootOverride?: string): CatalogueState {
  if (bundle.state === "unavailable") return bundle;
  const entry = bundle.entries.find((e) => e.id === GENERATOR_CATALOGUE_ENTRY);
  if (entry === undefined) {
    return {
      state: "unavailable",
      reason: "The bundled reference data carries no generator catalogue.",
      remedy: "Install a published @exeris/ai-bridge, or run npm run vendor:data with EXERIS_TOOLING_VERSION set.",
    };
  }
  const read = readBundleEntry(bundle, GENERATOR_CATALOGUE_ENTRY, rootOverride);
  if (read.state === "unavailable") return read;
  try {
    return {
      state: "available",
      catalogue: parseGeneratorCatalogue(read.text),
      sourceArtifact: entry.sourceArtifact,
    };
  } catch (err) {
    if (err instanceof CatalogueFormatError) {
      return {
        state: "unavailable",
        reason: `The bundled generator catalogue cannot be used: ${err.message}.`,
        remedy: "Upgrade @exeris/ai-bridge to a release that reads this catalogue format.",
      };
    }
    throw err;
  }
}
