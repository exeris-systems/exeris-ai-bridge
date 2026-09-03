// Decoding of the codegen output tree the user's own project carries —
// `src/main/generated/java` (L1) and its test-side twin.
//
// THE DECISION IN THIS FILE: this reads what the pipeline emitted; it does not
// predict what the pipeline would emit.
//
// Predicting looks tempting — there are thirteen registered generators and each
// one has a condition. But only two of them state that condition where a mirror
// could read it (`supports()`, on the stream-handler pair). The other eleven
// decide by returning a null sentinel from inside `generate(...)`, on
// `hasEvents()`, `hasGraphMetadata()`, `isSaga()`, `versioned()` and so on. A
// TypeScript prediction would therefore be a second implementation of eleven
// generators' internal guards, wrong the first time any of them moved — the
// same trap `caps:*` refuses for the @Requires→@Provides DAG and
// `build-get_domain_metadata` refuses for the AST.
//
// The producer already writes the answer down. `OutputWriter` records every
// path it emits into `.exeris-codegen-manifest` at the root of each output
// tree, sorted, precisely so the next run knows which files it owns. That file
// is the pipeline's own statement of ownership, so it is what this module
// reads. What is hand-maintained here is only the EXPLANATION attached to an
// observed path — which generator produced this shape and what drives it —
// and a stale explanation misleads where a stale prediction would lie.

/** Root of the L1 tree, relative to the project root (`exeris.outputDir`). */
export const GENERATED_ROOT = "src/main/generated/java";

/** The second output root, written only under `-Dexeris.tests=true` (ADR-058). */
export const TEST_GENERATED_ROOT = "src/test/generated/java";

/** Where `exeris:detach` promotes L1 files to (`exeris.targetDir`). */
export const OWNED_ROOT = "src/main/java";

/** `OutputWriter.MANIFEST_NAME` — one per output tree, at its root. */
export const MANIFEST_NAME = ".exeris-codegen-manifest";

/** `DetachMojo.ignoreEntry` default — the line detach strips once the tree is owned. */
export const GITIGNORE_ENTRY = "src/main/generated";

export interface ArtefactExplanation {
  /** Path relative to the output root, exactly as the manifest records it. */
  readonly path: string;
  readonly artefact: string;
  /** Null when the shape matches no generator this bridge knows. */
  readonly generator: string | null;
  readonly driver: string;
  readonly scope: "entity" | "project";
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
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (!isSafeManifestEntry(trimmed)) continue;
    seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function isSafeManifestEntry(entry: string): boolean {
  if (entry.startsWith("/") || entry.includes("\\") || /^[A-Za-z]:/.test(entry)) return false;
  return entry.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Explain one emitted path.
 *
 * `knownEntities` comes from the metadata directory and is used for exactly one
 * distinction the path alone cannot make: an entity-level SSE handler
 * (`<Entity>StreamHandler`) and a per-action one (`<Entity><Action>StreamHandler`)
 * differ only by whether the stem is an entity name plus the suffix. With no
 * metadata on disk the two stay merged and the answer says so, rather than
 * picking one.
 *
 * `isTestRoot` is the second output root (ADR-058). It is not a hint to weigh
 * against the path: nothing a test generator emits ever lands in src/main, and
 * the generated tests reuse the very package names the main artefacts use — so
 * the root decides, and the package dispatch never sees these paths.
 */
export function explainArtefact(
  relPath: string,
  knownEntities: readonly string[] = [],
  isTestRoot = false,
): ArtefactExplanation {
  const segments = relPath.split("/");
  const file = segments[segments.length - 1] ?? relPath;
  const pkg = segments.length > 1 ? (segments[segments.length - 2] ?? "") : "";
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1) : "";

  const built = isTestRoot ? TEST_ARTEFACT : classify(relPath, file, pkg, stem, ext, knownEntities);
  return { path: relPath, ...built };
}

type Body = Omit<ArtefactExplanation, "path">;

function classify(
  relPath: string,
  file: string,
  pkg: string,
  stem: string,
  ext: string,
  knownEntities: readonly string[],
): Body {
  if (file === "cap-manifest.json" && !relPath.includes("/")) {
    return {
      artefact: "Capability composition manifest",
      generator: "CodegenPipeline",
      driver:
        "Written whenever the project composes capabilities. Read it with caps-list_capabilities rather than by hand.",
      scope: "project",
    };
  }

  if (ext === "sql") {
    if (stem.endsWith("__foreign_keys")) {
      return {
        artefact: "Flyway migration — cross-table foreign keys",
        generator: "KernelApplicationGenerator",
        driver:
          "One trailing migration carrying every cross-table FOREIGN KEY, emitted after the per-entity tables so no creation order can fail.",
        scope: "project",
      };
    }
    return {
      artefact: "Flyway migration — CREATE TABLE",
      generator: "KernelFlywayGenerator",
      driver:
        "Emitted for every entity. Carries the column list, CHECK constraints, indexes, and an RLS policy when the entity is tenant-partitioned. This file is the schema the build produces — column names are snake_case, so a hand-written DDL alongside it will disagree.",
      scope: "entity",
    };
  }

  if (ext === "yaml" || ext === "yml") {
    return {
      artefact: "OpenAPI 3.1 specification",
      generator: "KernelOpenApiGenerator",
      driver: "Emitted for every entity.",
      scope: "entity",
    };
  }

  if (ext === "java") {
    const project = PROJECT_WIDE_TYPES.get(stem);
    if (project) return project;

    const byPackage = classifyJavaByPackage(pkg, stem, knownEntities);
    if (byPackage) return byPackage;
  }

  return UNRECOGNISED;
}

const TEST_ARTEFACT: Body = {
  artefact: "Generated test",
  generator: "one of the Kernel*TestGenerator family (KernelTestSupportGenerator for shared scaffolding)",
  driver:
    "Emitted only under -Dexeris.tests=true, into the second output root src/test/generated/java (ADR-058), which is why the root and not the class name identifies it. It never lands in src/main.",
  scope: "entity",
};

const PROJECT_WIDE_TYPES = new Map<string, Body>([
  [
    "Application",
    {
      artefact: "Application bootstrap",
      generator: "KernelApplicationGenerator",
      driver:
        "Project-wide: emitted once from the full domain list, not per entity, so it is written after the per-entity loop.",
      scope: "project",
    },
  ],
  [
    "RuntimeComponents",
    {
      artefact: "Runtime component wiring",
      generator: "KernelApplicationGenerator",
      driver: "Project-wide: the composition root's open half, emitted once from the full domain list.",
      scope: "project",
    },
  ],
  [
    "RuntimeLifecycle",
    {
      artefact: "Runtime lifecycle",
      generator: "KernelApplicationGenerator",
      driver: "Project-wide: composes the per-entity Repository → Service → Handler chain, emitted once.",
      scope: "project",
    },
  ],
]);

/**
 * The generators derive their target package from the entity's own, by
 * substituting the `.domain` suffix — `.repository`, `.service`, `.handler`,
 * `.event`, `.graph`, `.saga`, `.client`. So the last path segment identifies
 * the generator far more reliably than the class-name suffix alone, and the
 * suffix only has to separate the artefacts that share a package.
 */
function classifyJavaByPackage(
  pkg: string,
  stem: string,
  knownEntities: readonly string[],
): Body | null {
  switch (pkg) {
    case "repository":
      if (stem.endsWith("VersionConflictException")) {
        return {
          artefact: "Domain error — version conflict",
          generator: "KernelErrorGenerator",
          driver:
            "Emitted only for a versioned entity, @ExerisDomain(versioned = true). Raised by the repository and mapped to 409 by the handler (ADR-076).",
          scope: "entity",
        };
      }
      if (stem.endsWith("NotFoundException")) {
        return {
          artefact: "Domain error — not found",
          generator: "KernelErrorGenerator",
          driver: "Emitted for every entity. Raised by the repository and mapped to 404 by the handler (ADR-076).",
          scope: "entity",
        };
      }
      return {
        artefact: "Repository",
        generator: "KernelRepositoryGenerator",
        driver: "Emitted for every entity, against the persistence SPI.",
        scope: "entity",
      };
    case "service":
      return {
        artefact: "Domain service",
        generator: "KernelServiceGenerator",
        driver: "Emitted for every entity. A POJO delegating to the repository; it touches no kernel API directly.",
        scope: "entity",
      };
    case "handler":
      if (stem.endsWith("StreamHandler")) return streamHandler(stem, knownEntities);
      return {
        artefact: "HTTP handler",
        generator: "KernelHandlerGenerator",
        driver: "Emitted for every entity, against the HTTP SPI.",
        scope: "entity",
      };
    case "event":
      if (stem.endsWith("EventSubscriber")) {
        return {
          artefact: "Domain-event subscriber",
          generator: "KernelEventHandlerGenerator",
          driver: "Emitted only when the entity declares events.",
          scope: "entity",
        };
      }
      return {
        artefact: "Domain-event publisher",
        generator: "KernelEventGenerator",
        driver: "Emitted only when the entity declares events.",
        scope: "entity",
      };
    case "graph":
      return {
        artefact: "Graph-sync projection",
        generator: "KernelGraphSyncGenerator",
        driver: "Emitted only when the entity carries graph metadata.",
        scope: "entity",
      };
    case "saga":
      return {
        artefact: "Saga skeleton",
        generator: "KernelSagaGenerator",
        driver:
          "Emitted only for a saga entity. The class name is the declared saga name, given a Flow suffix unless it already ends in one — so it need not match the entity name.",
        scope: "entity",
      };
    case "client":
      return {
        artefact: "Service-to-service HTTP client",
        generator: "KernelClientGenerator",
        driver: "Emitted for every entity, against the tier-neutral KernelWebClient facade (ADR-034).",
        scope: "entity",
      };
    default:
      return null;
  }
}

function streamHandler(stem: string, knownEntities: readonly string[]): Body {
  const entityLevel = knownEntities.some((e) => stem === `${e}StreamHandler`);
  if (entityLevel) {
    return {
      artefact: "SSE live-view stream handler (entity-level)",
      generator: "KernelStreamHandlerGenerator",
      driver: "Emitted only for @ExerisDomain(realTimeApi = true) (ADR-043).",
      scope: "entity",
    };
  }
  if (knownEntities.length > 0) {
    return {
      artefact: "SSE stream handler (per action)",
      generator: "KernelActionStreamHandlerGenerator",
      driver: "One per @Action(streaming = true); the stem is the entity name followed by the action name (ADR-044).",
      scope: "entity",
    };
  }
  return {
    artefact: "SSE stream handler",
    generator: "KernelStreamHandlerGenerator or KernelActionStreamHandlerGenerator",
    driver:
      "Either entity-level, from @ExerisDomain(realTimeApi = true), or one per @Action(streaming = true). Telling them apart needs the entity names, which come from target/classes/exeris-metadata — build the project and ask again for the exact one.",
    scope: "entity",
  };
}

const UNRECOGNISED: Body = {
  artefact: "Unrecognised generated file",
  generator: null,
  driver:
    "The codegen manifest lists this path, so the pipeline owns it and will rewrite it — but its shape matches no generator this bridge knows. Treat it as generated, and do not hand-edit it.",
  scope: "entity",
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
