// Wire shapes for cap-manifest.json, mirrored 1:1 from the authoritative record
// in exeris-sdk (eu.exeris.sdk.composition.CapManifest) and produced by
// exeris-tooling (CapabilityGraph.SCHEMA_VERSION = 2). The bridge validates the
// file against these shapes and re-emits ONLY the contract fields, so a renamed
// or added producer field surfaces as a clear error rather than silent drift.
//
// Read-only, and deliberately inert: nothing here re-resolves the
// `@Requires`→`@Provides` DAG. `initOrder` is transcribed exactly as the
// manifest states it. Re-deriving it would be a second implementation of a
// contract that exeris-tooling already validates and stamps, and the two would
// disagree the first time either changed.

/** One service a module declares it provides. */
export interface Provided {
  service: string;
  version: string;
}

export interface ModuleBody {
  provides: Provided[];
  // Null when the module owns no lifecycle. The producer normalises blank to
  // null, so an empty string never reaches here as a distinct third state.
  lifecycleOwner: string | null;
}

export interface CapModule {
  qualifiedName: string;
  module: ModuleBody;
}

/**
 * The validation stamp. `validated` is the gate the 2026-06-17 "Validation
 * Stamp Lifecycle" amendment describes: a manifest is only written once the
 * capability graph passes, and on failure the pipeline keeps the PRIOR
 * manifest — so a stale-but-valid file on disk is an expected state, and
 * `compositionVersion` plus `contentBinding` are how a reader tells which
 * build it describes.
 */
export interface CompositionStamp {
  validated: boolean;
  compositionVersion: string;
  contentBinding: string;
}

export interface CapManifest {
  schemaVersion: number;
  stamp: CompositionStamp;
  modules: CapModule[];
  initOrder: string[];
}

/** The schema major this bridge understands (exeris-tooling CapabilityGraph). */
const SUPPORTED_SCHEMA_VERSION = 2;

export class CapShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapShapeError";
  }
}

function fail(message: string): never {
  throw new CapShapeError(message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

/**
 * The manifest is versioned by a single integer, not by semver, so there is no
 * compatible-minor notion to be lenient about: a different number is a
 * different contract. Refusing it is the point — a v3 manifest read as v2 would
 * answer confidently from a shape nobody promised.
 */
function parseSchemaVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail("capManifest.schemaVersion must be an integer");
  }
  if (value !== SUPPORTED_SCHEMA_VERSION) {
    fail(
      `incompatible cap-manifest schemaVersion ${value}; this bridge supports ${SUPPORTED_SCHEMA_VERSION}`,
    );
  }
  return value;
}

function parseProvided(value: unknown, path: string): Provided {
  const o = asObject(value, path);
  return {
    service: asString(o.service, `${path}.service`),
    version: asString(o.version, `${path}.version`),
  };
}

function parseModule(value: unknown, path: string): CapModule {
  const o = asObject(value, path);
  const body = asObject(o.module, `${path}.module`);
  const lifecycleOwner = body.lifecycleOwner;
  return {
    qualifiedName: asString(o.qualifiedName, `${path}.qualifiedName`),
    module: {
      provides: asArray(body.provides, `${path}.module.provides`).map((p, i) =>
        parseProvided(p, `${path}.module.provides[${i}]`),
      ),
      lifecycleOwner:
        lifecycleOwner === undefined || lifecycleOwner === null
          ? null
          : asString(lifecycleOwner, `${path}.module.lifecycleOwner`),
    },
  };
}

function parseStamp(value: unknown): CompositionStamp {
  const o = asObject(value, "capManifest.stamp");
  return {
    validated: asBoolean(o.validated, "capManifest.stamp.validated"),
    compositionVersion: asString(o.compositionVersion, "capManifest.stamp.compositionVersion"),
    contentBinding: asString(o.contentBinding, "capManifest.stamp.contentBinding"),
  };
}

/** Validate a parsed cap-manifest.json into a canonical CapManifest. */
export function parseCapManifest(result: unknown): CapManifest {
  const o = asObject(result, "capManifest");
  return {
    schemaVersion: parseSchemaVersion(o.schemaVersion),
    stamp: parseStamp(o.stamp),
    modules: asArray(o.modules, "capManifest.modules").map((m, i) =>
      parseModule(m, `capManifest.modules[${i}]`),
    ),
    initOrder: asArray(o.initOrder, "capManifest.initOrder").map((n, i) =>
      asString(n, `capManifest.initOrder[${i}]`),
    ),
  };
}
