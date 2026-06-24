// Wire shapes for the read-only `exeris/*` LSP slice, mirrored 1:1 from the
// authoritative records in exeris-platform-lsp
// (eu.exeris.platform.lsp.ExerisProtocolExtensions, projected by
// ProtocolProjections). The bridge validates the server's JSON-RPC result
// against these shapes and re-emits ONLY the contract fields in canonical
// order, so the agent-facing output is pinned to the documented surface
// (extra/renamed server fields surface as a clear shape error, not silent
// drift). Source: exeris-platform `feat/lsp-readonly-slice`.

export interface ParamSummary {
  name: string;
  type: string;
  required: boolean;
}

export interface FieldDescription {
  name: string;
  type: string;
  required: boolean;
}

export interface ActionDescription {
  name: string;
  httpMethod: string;
  resultType: string;
  params: ParamSummary[];
}

/** Returned by `exeris/actions` — an action with its owning domain. */
export interface ActionSummary {
  owningDomain: string;
  name: string;
  httpMethod: string;
  resultType: string;
  params: ParamSummary[];
}

/** Returned by `exeris/domains` — one-line identity of a domain. */
export interface DomainSummary {
  qualifiedName: string;
  simpleName: string;
  packageName: string;
  sourcePath: string;
}

/** Returned by `exeris/domainDescribe` — full read-only view of one domain. */
export interface DomainDescription extends DomainSummary {
  fields: FieldDescription[];
  actions: ActionDescription[];
  artefacts: string[];
}

/**
 * Thrown when an `exeris/*` result does not match the contract above. The
 * caller maps this onto an `isError` tool result rather than letting a
 * malformed payload crash the handler.
 */
export class LspShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspShapeError";
  }
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LspShapeError(`${path} must be an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new LspShapeError(`${path} must be an array, got ${describe(value)}`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new LspShapeError(`${path} must be a string, got ${describe(value)}`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new LspShapeError(`${path} must be a boolean, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseParam(value: unknown, path: string): ParamSummary {
  const o = asObject(value, path);
  return {
    name: asString(o.name, `${path}.name`),
    type: asString(o.type, `${path}.type`),
    required: asBoolean(o.required, `${path}.required`),
  };
}

function parseParams(value: unknown, path: string): ParamSummary[] {
  return asArray(value, path).map((p, i) => parseParam(p, `${path}[${i}]`));
}

function parseField(value: unknown, path: string): FieldDescription {
  const o = asObject(value, path);
  return {
    name: asString(o.name, `${path}.name`),
    type: asString(o.type, `${path}.type`),
    required: asBoolean(o.required, `${path}.required`),
  };
}

function parseAction(value: unknown, path: string): ActionDescription {
  const o = asObject(value, path);
  return {
    name: asString(o.name, `${path}.name`),
    httpMethod: asString(o.httpMethod, `${path}.httpMethod`),
    resultType: asString(o.resultType, `${path}.resultType`),
    params: parseParams(o.params, `${path}.params`),
  };
}

function parseDomainSummary(value: unknown, path: string): DomainSummary {
  const o = asObject(value, path);
  return {
    qualifiedName: asString(o.qualifiedName, `${path}.qualifiedName`),
    simpleName: asString(o.simpleName, `${path}.simpleName`),
    packageName: asString(o.packageName, `${path}.packageName`),
    sourcePath: asString(o.sourcePath, `${path}.sourcePath`),
  };
}

/** Validate an `exeris/domains` result into a canonical `DomainSummary[]`. */
export function parseDomainSummaries(result: unknown): DomainSummary[] {
  return asArray(result, "domains").map((d, i) => parseDomainSummary(d, `domains[${i}]`));
}

/** Validate an `exeris/domainDescribe` result into a canonical `DomainDescription`. */
export function parseDomainDescription(result: unknown): DomainDescription {
  const o = asObject(result, "domain");
  const summary = parseDomainSummary(o, "domain");
  return {
    ...summary,
    fields: asArray(o.fields, "domain.fields").map((f, i) => parseField(f, `domain.fields[${i}]`)),
    actions: asArray(o.actions, "domain.actions").map((a, i) => parseAction(a, `domain.actions[${i}]`)),
    artefacts: asArray(o.artefacts, "domain.artefacts").map((a, i) =>
      asString(a, `domain.artefacts[${i}]`),
    ),
  };
}

/** Validate an `exeris/actions` result into a canonical `ActionSummary[]`. */
export function parseActionSummaries(result: unknown): ActionSummary[] {
  return asArray(result, "actions").map((a, i) => {
    const o = asObject(a, `actions[${i}]`);
    return {
      owningDomain: asString(o.owningDomain, `actions[${i}].owningDomain`),
      name: asString(o.name, `actions[${i}].name`),
      httpMethod: asString(o.httpMethod, `actions[${i}].httpMethod`),
      resultType: asString(o.resultType, `actions[${i}].resultType`),
      params: parseParams(o.params, `actions[${i}].params`),
    };
  });
}
