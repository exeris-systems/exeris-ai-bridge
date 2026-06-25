// Wire shapes for the read-only KernelDiagnostics NDJSON contract, mirrored 1:1
// from the authoritative records in exeris-kernel-spi
// (eu.exeris.kernel.spi.diagnostics.*, schemaVersion "1.0", ADR-033). The
// adapter returns a raw response object; the bridge validates it against these
// shapes and re-emits ONLY the contract fields in canonical order, so the
// agent-facing output is pinned to the documented surface (extra/renamed kernel
// fields surface as a clear shape error, not silent drift).
//
// Cap-blind by construction (ADR-024 / ADR-025): these are runtime-state
// records only — provider registry, bootstrap/subsystem DAG. There is no
// capability-composition shape here, and none may be added.

/** One SPI provider registered with the running kernel. */
export interface ProviderDescriptor {
  providerName: string;
  spiType: string;
  priority: number;
  // displayName is nullable in the source record (serialized as JSON null, not
  // an absent key); the bridge normalizes both "null" and "absent" to null.
  displayName: string | null;
}

export interface ProvidersSnapshot {
  schemaVersion: string;
  capturedAt: string;
  providers: ProviderDescriptor[];
}

/** One node in the bootstrap dependency DAG. */
export interface DagNode {
  name: string;
  phase: string;
  dependsOn: string[];
  running: boolean;
  optional: boolean;
}

export interface BootstrapDagSnapshot {
  schemaVersion: string;
  capturedAt: string;
  nodes: DagNode[];
}

/** Detail for a single subsystem (same fields as a DAG node). */
export interface SubsystemDescriptor {
  name: string;
  phase: string;
  dependsOn: string[];
  running: boolean;
  optional: boolean;
}

export interface SubsystemSnapshot {
  schemaVersion: string;
  capturedAt: string;
  requestedName: string;
  // null when no subsystem with the requested name exists — a normal "not
  // found" answer, not an error.
  subsystem: SubsystemDescriptor | null;
}

/**
 * Thrown when a diagnostics response does not match the contract above. The
 * caller maps this onto an `isError` tool result rather than letting a
 * malformed payload crash the handler.
 */
export class KernelShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelShapeError";
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KernelShapeError(`${path} must be an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new KernelShapeError(`${path} must be an array, got ${describe(value)}`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new KernelShapeError(`${path} must be a string, got ${describe(value)}`);
  }
  return value;
}

/** A string, or null when the field is absent/JSON-null (Jackson emits null). */
function asNullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return asString(value, path);
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KernelShapeError(`${path} must be a finite number, got ${describe(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new KernelShapeError(`${path} must be a boolean, got ${describe(value)}`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((s, i) => asString(s, `${path}[${i}]`));
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseProvider(value: unknown, path: string): ProviderDescriptor {
  const o = asObject(value, path);
  return {
    providerName: asString(o.providerName, `${path}.providerName`),
    spiType: asString(o.spiType, `${path}.spiType`),
    priority: asNumber(o.priority, `${path}.priority`),
    displayName: asNullableString(o.displayName, `${path}.displayName`),
  };
}

/** Validate a `listProviders` response into a canonical ProvidersSnapshot. */
export function parseProvidersSnapshot(result: unknown): ProvidersSnapshot {
  const o = asObject(result, "providersSnapshot");
  return {
    schemaVersion: asString(o.schemaVersion, "providersSnapshot.schemaVersion"),
    capturedAt: asString(o.capturedAt, "providersSnapshot.capturedAt"),
    providers: asArray(o.providers, "providersSnapshot.providers").map((p, i) =>
      parseProvider(p, `providersSnapshot.providers[${i}]`),
    ),
  };
}

function parseDagNode(value: unknown, path: string): DagNode {
  const o = asObject(value, path);
  return {
    name: asString(o.name, `${path}.name`),
    phase: asString(o.phase, `${path}.phase`),
    dependsOn: asStringArray(o.dependsOn, `${path}.dependsOn`),
    running: asBoolean(o.running, `${path}.running`),
    optional: asBoolean(o.optional, `${path}.optional`),
  };
}

/** Validate a `getBootstrapDag` response into a canonical BootstrapDagSnapshot. */
export function parseBootstrapDagSnapshot(result: unknown): BootstrapDagSnapshot {
  const o = asObject(result, "bootstrapDagSnapshot");
  return {
    schemaVersion: asString(o.schemaVersion, "bootstrapDagSnapshot.schemaVersion"),
    capturedAt: asString(o.capturedAt, "bootstrapDagSnapshot.capturedAt"),
    nodes: asArray(o.nodes, "bootstrapDagSnapshot.nodes").map((n, i) =>
      parseDagNode(n, `bootstrapDagSnapshot.nodes[${i}]`),
    ),
  };
}

/** Validate a `describeSubsystem` response into a canonical SubsystemSnapshot. */
export function parseSubsystemSnapshot(result: unknown): SubsystemSnapshot {
  const o = asObject(result, "subsystemSnapshot");
  const subsystem = o.subsystem;
  return {
    schemaVersion: asString(o.schemaVersion, "subsystemSnapshot.schemaVersion"),
    capturedAt: asString(o.capturedAt, "subsystemSnapshot.capturedAt"),
    requestedName: asString(o.requestedName, "subsystemSnapshot.requestedName"),
    subsystem:
      subsystem === undefined || subsystem === null
        ? null
        : parseSubsystemDescriptor(subsystem, "subsystemSnapshot.subsystem"),
  };
}

function parseSubsystemDescriptor(value: unknown, path: string): SubsystemDescriptor {
  const o = asObject(value, path);
  return {
    name: asString(o.name, `${path}.name`),
    phase: asString(o.phase, `${path}.phase`),
    dependsOn: asStringArray(o.dependsOn, `${path}.dependsOn`),
    running: asBoolean(o.running, `${path}.running`),
    optional: asBoolean(o.optional, `${path}.optional`),
  };
}
