// Wire shapes and parser validation for the sdk:* tool family.
// Sourced from bundled reference data (annotation-catalog.json and ast-schema.json).

export interface AnnotationAttribute {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly default?: string;
  readonly purpose?: string;
  readonly description?: string;
  readonly deprecated?: {
    readonly forRemoval: boolean;
    readonly since: string;
    readonly replacement?: string;
  };
}

export interface AnnotationSummary {
  readonly name: string;
  readonly qualifiedName: string;
  readonly package: string;
  readonly nested: boolean;
  readonly targets: readonly string[];
  readonly memberValueOnly: boolean;
  readonly retention: string;
  readonly purpose: string;
}

export interface AnnotationDetail extends AnnotationSummary {
  readonly description?: string;
  readonly attributes: readonly AnnotationAttribute[];
  readonly deprecated?: {
    readonly forRemoval: boolean;
    readonly since: string;
    readonly replacement?: string;
  };
}

export interface PackageSummary {
  readonly name: string;
  readonly purpose: string;
  readonly description?: string;
}

export interface AnnotationCatalog {
  readonly catalogFormat: number;
  readonly sdkVersion: string;
  readonly annotationCount: number;
  readonly annotations: readonly AnnotationDetail[];
  readonly packages: readonly PackageSummary[];
}

export interface AstSchemaDefinition {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

export interface AstSchemaEnvelope {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly schemaFormat: number;
  readonly sdkVersion: string;
  readonly astSchemaVersion: string;
  readonly definitionCount: number;
  readonly definitions: readonly string[];
  readonly "x-exeris-reader-requirements"?: readonly unknown[];
}

export interface ParsedAstSchema {
  readonly envelope: AstSchemaEnvelope;
  readonly definitions: Record<string, AstSchemaDefinition>;
  readonly raw: Record<string, unknown>;
}

function asString(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

export function parseAnnotationCatalog(raw: unknown): AnnotationCatalog {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("annotation-catalog must be a non-null object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.catalogFormat !== "number" || obj.catalogFormat !== 1) {
    throw new Error(`Unsupported or missing catalogFormat: ${String(obj.catalogFormat)}; expected 1`);
  }
  if (typeof obj.sdkVersion !== "string" || obj.sdkVersion.trim().length === 0) {
    throw new Error("Missing or invalid sdkVersion in annotation-catalog");
  }
  if (!Array.isArray(obj.annotations)) {
    throw new Error("Missing or invalid annotations array in annotation-catalog");
  }

  const annotations: AnnotationDetail[] = obj.annotations.map((entry, idx) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Annotation entry at index ${idx} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim()) {
      throw new Error(`Annotation entry at index ${idx} is missing required 'name'`);
    }
    if (typeof e.qualifiedName !== "string" || !e.qualifiedName.trim()) {
      throw new Error(`Annotation entry at index ${idx} is missing required 'qualifiedName'`);
    }
    if (typeof e.package !== "string" || !e.package.trim()) {
      throw new Error(`Annotation entry at index ${idx} is missing required 'package'`);
    }

    const name = e.name.trim();
    const qualifiedName = e.qualifiedName.trim();
    const pkg = e.package.trim();
    const purpose = asString(e.purpose);
    const retention = asString(e.retention, "SOURCE");
    const targets = Array.isArray(e.targets)
      ? e.targets.filter((t): t is string => typeof t === "string")
      : [];
    const nested = Boolean(e.nested);
    const memberValueOnly = Boolean(e.memberValueOnly);
    const description = typeof e.description === "string" ? e.description : undefined;

    let deprecated: AnnotationDetail["deprecated"] = undefined;
    if (typeof e.deprecated === "object" && e.deprecated !== null) {
      const dep = e.deprecated as Record<string, unknown>;
      deprecated = {
        forRemoval: Boolean(dep.forRemoval),
        since: asString(dep.since),
        replacement: typeof dep.replacement === "string" ? dep.replacement : undefined,
      };
    }

    const rawAttributes = Array.isArray(e.attributes) ? e.attributes : [];
    const attributes: AnnotationAttribute[] = rawAttributes.map((attr) => {
      const a = (attr ?? {}) as Record<string, unknown>;
      if (typeof a.name !== "string" || !a.name.trim()) {
        throw new Error(`Attribute in annotation '${name}' is missing required 'name'`);
      }
      if (typeof a.type !== "string" || !a.type.trim()) {
        throw new Error(`Attribute in annotation '${name}' is missing required 'type'`);
      }
      let attrDep: AnnotationAttribute["deprecated"] = undefined;
      if (typeof a.deprecated === "object" && a.deprecated !== null) {
        const dep = a.deprecated as Record<string, unknown>;
        attrDep = {
          forRemoval: Boolean(dep.forRemoval),
          since: asString(dep.since),
          replacement: typeof dep.replacement === "string" ? dep.replacement : undefined,
        };
      }
      return {
        name: a.name.trim(),
        type: a.type.trim(),
        required: Boolean(a.required),
        default: typeof a.default === "string" ? a.default : undefined,
        purpose: typeof a.purpose === "string" ? a.purpose : undefined,
        description: typeof a.description === "string" ? a.description : undefined,
        deprecated: attrDep,
      };
    });

    return {
      name,
      qualifiedName,
      package: pkg,
      nested,
      targets,
      memberValueOnly,
      retention,
      purpose,
      description,
      attributes,
      deprecated,
    };
  });

  const rawPackages = Array.isArray(obj.packages) ? obj.packages : [];
  const packages: PackageSummary[] = rawPackages.map((p) => {
    const pkg = (p ?? {}) as Record<string, unknown>;
    return {
      name: asString(pkg.name),
      purpose: asString(pkg.purpose),
      description: typeof pkg.description === "string" ? pkg.description : undefined,
    };
  });

  return {
    catalogFormat: obj.catalogFormat,
    sdkVersion: obj.sdkVersion,
    annotationCount: typeof obj.annotationCount === "number" ? obj.annotationCount : annotations.length,
    annotations,
    packages,
  };
}

export function parseAstSchema(raw: unknown): ParsedAstSchema {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ast-schema must be a non-null object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.schemaFormat !== "number" || obj.schemaFormat !== 1) {
    throw new Error(`Unsupported or missing schemaFormat: ${String(obj.schemaFormat)}; expected 1`);
  }
  if (typeof obj.sdkVersion !== "string" || !obj.sdkVersion.trim()) {
    throw new Error("Missing or invalid sdkVersion in ast-schema");
  }
  if (typeof obj.astSchemaVersion !== "string" || !obj.astSchemaVersion.trim()) {
    throw new Error("Missing or invalid astSchemaVersion in ast-schema");
  }

  const defsRaw = (obj.$defs ?? obj.definitions ?? {}) as Record<string, unknown>;
  const definitions: Record<string, AstSchemaDefinition> = Object.create(null) as Record<
    string,
    AstSchemaDefinition
  >;
  for (const [key, value] of Object.entries(defsRaw)) {
    if (typeof value === "object" && value !== null) {
      definitions[key] = value as AstSchemaDefinition;
    }
  }

  const defKeys = Object.keys(definitions).sort((a, b) => a.localeCompare(b));

  const envelope: AstSchemaEnvelope = {
    $schema: typeof obj.$schema === "string" ? obj.$schema : undefined,
    $id: typeof obj.$id === "string" ? obj.$id : undefined,
    title: typeof obj.title === "string" ? obj.title : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
    schemaFormat: obj.schemaFormat,
    sdkVersion: asString(obj.sdkVersion),
    astSchemaVersion: asString(obj.astSchemaVersion),
    definitionCount: typeof obj.definitionCount === "number" ? obj.definitionCount : defKeys.length,
    definitions: defKeys,
    "x-exeris-reader-requirements": Array.isArray(obj["x-exeris-reader-requirements"])
      ? obj["x-exeris-reader-requirements"]
      : undefined,
  };

  return {
    envelope,
    definitions,
    raw: obj,
  };
}
