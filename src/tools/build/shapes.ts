// Shapes for the annotation-processor output the user's own build emits into
// `target/classes/exeris-metadata/`.
//
// SCOPE OF VALIDATION — the important decision in this file.
//
// The bridge validates the ENVELOPE and passes the AST body through verbatim.
// It does not re-declare `DomainMetadata` and its ~30 sibling records in
// TypeScript. That would be a second implementation of a contract the SDK
// already owns, and it would drift the first time a field moved: the record has
// 40+ components before the nested lists, and `@JsonInclude(NON_NULL)` means an
// absent key is normal rather than a defect, so a hand-written mirror would
// mostly encode guesses about optionality.
//
// The right source exists and is coming: `exeris-sdk` 0.12.0 emits
// `META-INF/exeris/ast-schema.json` (`AstSchemaProcessor`, `schemaFormat: 1`),
// which the bundle vendors at 0.7.0. When it lands, validation deepens from
// envelope to full without the tool surface changing. Until then, claiming to
// validate the AST would be claiming more than this repo can check.
//
// What IS checked is what the bridge itself depends on and what ADR-042 pins.

/**
 * The two fields `ExerisDomainProcessor.buildMetadataNode` stamps onto every
 * emitted file, on top of the serialized record.
 *
 * `sourceDigest` is deliberately optional. Per ADR-042 the stamping is done by
 * the annotation processor behind the javac Compiler Tree API, and where that
 * API is absent — some incremental and IDE builds — the digest is skipped and
 * only `schemaVersion` is written. The build degrades rather than failing, so a
 * digest-less baseline is a NORMAL file here and must not read as damaged.
 */
export interface MetadataEnvelope {
  schemaVersion: string;
  sourceDigest: string | null;
  entityName: string;
  packageName: string | null;
  /** The serialized DomainMetadata, verbatim. Not re-declared here — see above. */
  metadata: Record<string, unknown>;
}

/** What kind of declaration a file under exeris-metadata/ describes. */
export type MetadataKind = "domain" | "enum" | "capability" | "view";

export interface MetadataEntry {
  name: string;
  kind: MetadataKind;
}

/**
 * The processor writes four kinds of file into one flat directory, telling them
 * apart by a filename prefix — `enum_`, `capability_`, `view_`, and no prefix
 * at all for a domain entity. Nothing in the file itself records which kind it
 * is, so the filename IS the discriminator and this table is the whole of the
 * decoding.
 */
const KIND_PREFIXES: ReadonlyArray<readonly [MetadataKind, string]> = [
  ["enum", "enum_"],
  ["capability", "capability_"],
  ["view", "view_"],
];

export function prefixFor(kind: MetadataKind): string {
  return KIND_PREFIXES.find(([k]) => k === kind)?.[1] ?? "";
}

/**
 * Classify one `exeris-metadata/` filename.
 *
 * Returns null for anything that is not a `.json` file, so a stray README or a
 * subdirectory is skipped rather than reported as a nameless entry.
 */
export function classifyMetadataFile(fileName: string): MetadataEntry | null {
  if (!fileName.endsWith(".json")) return null;
  const stem = fileName.slice(0, -".json".length);
  if (stem.length === 0) return null;
  for (const [kind, prefix] of KIND_PREFIXES) {
    if (stem.startsWith(prefix)) {
      const name = stem.slice(prefix.length);
      return name.length === 0 ? null : { name, kind };
    }
  }
  return { name: stem, kind: "domain" };
}

export class MetadataShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataShapeError";
  }
}

/**
 * Validate the envelope of one emitted metadata file.
 *
 * Unknown keys are kept, not dropped — the opposite of the `kernel:*` and
 * `caps:*` parsers, and deliberately. Those mirror a contract this repo has
 * fully transcribed, so an unrecognised field there means drift worth
 * surfacing. Here the body IS the SDK's contract and this file only claims to
 * understand its wrapper; discarding the fields it does not know would throw
 * away most of the answer.
 */
export function parseMetadataEnvelope(value: unknown, fileName: string): MetadataEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetadataShapeError(`${fileName} must contain a JSON object`);
  }
  const o = value as Record<string, unknown>;

  const schemaVersion = o.schemaVersion;
  if (typeof schemaVersion !== "string") {
    throw new MetadataShapeError(
      `${fileName} has no string schemaVersion; it was not written by the Exeris annotation processor`,
    );
  }
  const entityName = o.entityName;
  if (typeof entityName !== "string") {
    throw new MetadataShapeError(`${fileName} has no string entityName`);
  }

  const sourceDigest = o.sourceDigest;
  if (sourceDigest !== undefined && typeof sourceDigest !== "string") {
    throw new MetadataShapeError(`${fileName} has a non-string sourceDigest`);
  }
  const packageName = o.packageName;
  if (packageName !== undefined && typeof packageName !== "string") {
    throw new MetadataShapeError(`${fileName} has a non-string packageName`);
  }

  return {
    schemaVersion,
    sourceDigest: typeof sourceDigest === "string" ? sourceDigest : null,
    entityName,
    packageName: typeof packageName === "string" ? packageName : null,
    metadata: o,
  };
}

/**
 * Java simple names only. The name reaches this file from the agent and is
 * concatenated into a filename, so it is checked against the grammar it is
 * supposed to satisfy BEFORE it touches the filesystem.
 *
 * The sandbox is still the boundary that decides — this is not a substitute for
 * it. It is here so that the common mistake gets a sentence about names instead
 * of a sentence about sandbox escapes, and so that a traversal attempt never
 * reaches path resolution at all.
 */
export function isJavaSimpleName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
