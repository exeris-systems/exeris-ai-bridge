// Decoding of the codegen output tree the user's own project carries —
// `src/main/generated/java` (L1) and its test-side twin.
//
// THE DECISION IN THIS FILE: this reads what the pipeline emitted; it does not
// predict what the pipeline would emit.
//
// Predicting looks tempting — every generator has a condition. But most of them
// state it nowhere a mirror could read: they decide by returning a null
// sentinel from inside `generate(...)`, on `hasEvents()`, `hasGraphMetadata()`,
// `isSaga()`, `versioned()` and so on. A TypeScript prediction would therefore
// be a second implementation of every generator's internal guards, wrong the
// first time any of them moved — the same trap `caps:*` refuses for the
// @Requires→@Provides DAG and `build-get_domain_metadata` refuses for the AST.
//
// The producer already writes the answer down. `OutputWriter` records every
// path it emits into `.exeris-codegen-manifest` at the root of each output
// tree, sorted, precisely so the next run knows which files it owns. That file
// is the pipeline's own statement of ownership, so it is what this module
// reads.
//
// The EXPLANATION attached to an observed path is the pipeline's too: the
// generator catalogue that exeris-tooling publishes with its codegen jar (ADR-097)
// and this package vendors. This module holds no table of generators, so a
// generator added, renamed or reshaped upstream reaches the answer by
// re-vendoring, not by an edit here.

import type { GeneratorCatalogue, GeneratorRow } from "../../data/generator-catalogue.js";

/** Root of the L1 tree, relative to the project root (`exeris.outputDir`). */
export const GENERATED_ROOT = "src/main/generated/java";

/**
 * The second output root, where the generated tests go (ADR-058). It is written
 * when test generation is on (`exeris.tests`), which an Initializr project sets
 * in its POM; a project that does not set it has no such tree.
 */
export const TEST_GENERATED_ROOT = "src/test/generated/java";

/** Where `exeris:detach` promotes L1 files to (`exeris.targetDir`). */
export const OWNED_ROOT = "src/main/java";

/** `OutputWriter.MANIFEST_NAME` — one per output tree, at its root. */
export const MANIFEST_NAME = ".exeris-codegen-manifest";

/** `DetachMojo.ignoreEntry` default — the line detach strips once the tree is owned. */
export const GITIGNORE_ENTRY = "src/main/generated";

/** Which output tree a manifest sits in; the catalogue's `outputRoot`. */
export type OutputRoot = "main" | "test";

export interface ArtefactCandidate {
  readonly id: string;
  readonly generator: string;
  readonly artefact: string;
  readonly condition: string;
}

export interface ArtefactExplanation {
  /** Path relative to the output root, as the manifest records it, without a leading `./`. */
  readonly path: string;
  readonly artefact: string;
  /** One generator's class name, only when exactly one catalogue row matches; null for no match or an ambiguous one. */
  readonly generator: string | null;
  readonly driver: string;
  /** The row's scope; null when the file is unknown, or the candidates disagree. */
  readonly scope: "entity" | "project" | null;
  /** `id` of the matching row, only when exactly one matches. */
  readonly catalogueId: string | null;
  /** The matching row's `pathTemplate`, when exactly one matches. */
  readonly pathTemplate: string | null;
  /** The matching row's `cardinality`, when exactly one matches. */
  readonly cardinality: string | null;
  /** The ADR that fixes the artefact's shape, when the single matching row names one. */
  readonly adr: string | null;
  /**
   * Every row that can have written this path, the catalogue's first match at
   * index 0. Empty: unrecognised (or no catalogue). One: unambiguous. Several:
   * ambiguous.
   */
  readonly candidates: readonly ArtefactCandidate[];
}

/**
 * Parse one `.exeris-codegen-manifest`.
 *
 * Format, from `OutputWriter`: a `#` header line, then one forward-slash
 * relative path per line, sorted. Blank lines and `#` lines are skipped on
 * read, so they are skipped here too.
 *
 * Entries are filtered, not trusted. This is a file in the USER'S project, not
 * one this server wrote, and a path that climbs out of the output root would be
 * echoed to the agent as "an artefact of your build" — so anything absolute,
 * backslash-separated, or carrying a `..` segment is dropped. Nothing here
 * opens these paths; the drop is about not making a false statement.
 */
export function parseCodegenManifest(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = stripLeadingDotSlash(line.trim());
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (!isSafeManifestEntry(trimmed)) continue;
    seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** A leading `./` names the same path; the catalogue's patterns are anchored without it. */
function stripLeadingDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function isSafeManifestEntry(entry: string): boolean {
  if (entry.startsWith("/") || entry.includes("\\") || /^[A-Za-z]:/.test(entry)) return false;
  return entry.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Explain one emitted path against the generator catalogue.
 *
 * The rule is the publisher's own: take the first row, in catalogue order,
 * whose `outputRoot` is the tree the manifest sits in and whose `pathPattern`
 * matches the path with a leading `./` removed. Nothing else decides — not the
 * package, not the file suffix, not the entity names on disk.
 *
 * Where the path's shape cannot separate generators, the first row lists the
 * others in `ambiguousWith`. Those candidates are REPORTED, not resolved:
 * resolving them from entity names would be a second implementation of the
 * pipeline's naming. A candidate is reported only when its own pattern also
 * matches this path — the reading ADR-097 gives a consumer ("the row whose
 * pattern also matches the path") — because `ambiguousWith` states which
 * shapes overlap in general, not that this path is one of them.
 *
 * `candidates` is the answer's one statement of who wrote the file: empty when
 * nothing matches, one row when the match is unambiguous, several when the
 * catalogue admits that the path cannot say. `generator` and the row-derived
 * fields are set only for a single candidate, so no field claims more than the
 * catalogue does. `condition` is never evaluated; it is prose for a person, and
 * evaluating it would be predicting emission.
 *
 * With no catalogue the path is still listed, and the answer says the catalogue
 * is what is missing — a different fact from the catalogue not knowing the path.
 */
export function explainArtefact(
  relPath: string,
  catalogue: GeneratorCatalogue | null,
  root: OutputRoot = "main",
): ArtefactExplanation {
  const path = stripLeadingDotSlash(relPath);
  if (catalogue === null) return { path, ...NO_CATALOGUE };

  const rows = catalogue.rows.filter((row) => row.outputRoot === root);
  const first = rows.find((row) => row.pattern.test(path));
  if (first === undefined) return { path, ...UNRECOGNISED };

  const others = first.ambiguousWith
    .map((id) => rows.find((row) => row.id === id))
    .filter((row): row is GeneratorRow => row !== undefined && row.pattern.test(path));
  const matched = [first, ...others];
  const candidates = matched.map((row) => ({
    id: row.id,
    generator: row.generator,
    artefact: row.artefact,
    condition: row.condition,
  }));

  if (others.length === 0) {
    const adrText = first.adr === null ? "" : ` Shape fixed by ${first.adr}.`;
    return {
      path,
      artefact: first.artefact,
      generator: first.generator,
      driver: `Emitted when: ${first.condition}.${adrText}`,
      scope: first.scope,
      catalogueId: first.id,
      pathTemplate: first.pathTemplate,
      cardinality: first.cardinality,
      adr: first.adr,
      candidates,
    };
  }

  const scopes = new Set(matched.map((row) => row.scope));
  return {
    path,
    artefact: "Generated file — the path shape fits several generators",
    generator: null,
    driver: `The generator catalogue lists ${matched.length} rows whose pattern matches this path (${matched
      .map((row) => `'${row.id}'`)
      .join(", ")}), and the path alone cannot say which wrote it. See \`candidates\`, first match first; each carries its own condition.`,
    scope: scopes.size === 1 ? first.scope : null,
    catalogueId: null,
    pathTemplate: null,
    cardinality: null,
    adr: null,
    candidates,
  };
}

type Body = Omit<ArtefactExplanation, "path">;

const NO_CATALOGUE: Body = {
  artefact: "Generated file (generator catalogue unavailable)",
  generator: null,
  driver:
    "The codegen manifest lists this path, so the pipeline owns it and will rewrite it — do not hand-edit it. This bridge has no generator catalogue loaded, so it cannot say which generator wrote it; see `catalogue` in this answer.",
  scope: null,
  catalogueId: null,
  pathTemplate: null,
  cardinality: null,
  adr: null,
  candidates: [],
};

const UNRECOGNISED: Body = {
  artefact: "Unrecognised generated file",
  generator: null,
  driver:
    "The codegen manifest lists this path, so the pipeline owns it and will rewrite it — but it matches no row of the generator catalogue this bridge carries. That is a gap in the catalogue, or a pipeline newer than the catalogue. Treat it as generated, and do not hand-edit it.",
  scope: null,
  catalogueId: null,
  pathTemplate: null,
  cardinality: null,
  adr: null,
  candidates: [],
};

/**
 * Does this path look like it belongs to `entity`?
 *
 * A MATCH, not a resolution, and named that way on purpose. The class-name
 * artefacts carry the entity name literally, but a Flyway migration is named
 * after the SQL TABLE — snake-cased and naively pluralised, or an explicit
 * @ExerisDomain(tableName) override that need not resemble the entity at all.
 * Reproducing that derivation here would be another second implementation for
 * the sake of a filter, so instead separators and case are dropped from both
 * sides and the comparison is a containment test.
 *
 * Containment errs towards INCLUDING too much — asking for `Station` also
 * matches `BackupStationHandler` — and that is the direction to err in. An
 * over-match hands the agent a file it can see is not the one it wanted; an
 * under-match hides the generated migration, which is the exact failure this
 * tool exists to prevent. An explicit @ExerisDomain(tableName) override can
 * still miss, and the unfiltered call always shows everything.
 */
export function matchesEntity(relPath: string, entity: string): boolean {
  const file = relPath.split("/").pop() ?? relPath;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return squash(stem).includes(squash(entity));
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[_\-.]/g, "");
}
