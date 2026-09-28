import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Strips XML comments iteratively until fixed-point, guaranteeing that no
 * comment sequence survives in the output.
 */
export function stripXmlComments(raw: string): string {
  let prev = raw;
  while (true) {
    const stripped = prev.replace(/<!--[\s\S]*?-->/g, "");
    if (stripped === prev) return stripped;
    prev = stripped;
  }
}

/**
 * Parse <localRepository> from a Maven settings.xml string, expanding ${user.home}.
 */
export function parseLocalRepository(settingsXml: string, home: string): string | null {
  const cleaned = stripXmlComments(settingsXml);
  const match = /<localRepository>([^<]*)<\/localRepository>/.exec(cleaned);
  if (match && match[1].trim().length > 0) {
    const val = match[1].trim().replace(/\$\{user\.home\}/g, home);
    return val;
  }
  return null;
}

export interface ResolveMavenRepoOptions {
  envRepo?: string;
  settingsPath?: string;
  defaultM2Repo?: string;
  fallbackFixturesDir?: string;
  home?: string;
  explicitVersion?: string;
  allowSnapshots?: boolean;
  minVersion?: string;
  checkArtifacts?: string[];
  existsFn?: (p: string) => boolean;
  readFn?: (p: string) => string;
}

/**
 * Locate the local Maven repository, in standard order of precedence:
 *   1. EXERIS_MAVEN_REPO
 *   2. <localRepository> in ~/.m2/settings.xml
 *   3. ~/.m2/repository
 *   4. Fallback fixtures repository (if present, e.g. for CI / zero-checkout)
 *
 * When checkArtifacts is specified, candidate repos are verified to contain
 * usable jars before being selected.
 */
export function resolveMavenRepo(options: ResolveMavenRepoOptions = {}): string | null {
  const existsFn = options.existsFn ?? existsSync;
  const readFn = options.readFn ?? ((p: string) => readFileSync(p, "utf8"));
  const home = options.home ?? (process.env.HOME?.trim() || homedir());

  const candidateDirs: string[] = [];

  // 1. Explicit override
  const override = options.envRepo ?? process.env.EXERIS_MAVEN_REPO?.trim();
  if (override) candidateDirs.push(override);

  // 2. ~/.m2/settings.xml
  const settingsPath = options.settingsPath ?? join(home, ".m2", "settings.xml");
  if (existsFn(settingsPath)) {
    try {
      const raw = readFn(settingsPath);
      const customLocal = parseLocalRepository(raw, home);
      if (customLocal) candidateDirs.push(customLocal);
    } catch {
      // settings.xml parse failure falls back to default
    }
  }

  // 3. ~/.m2/repository
  candidateDirs.push(options.defaultM2Repo ?? join(home, ".m2", "repository"));

  // 4. Fallback fixtures repo
  if (options.fallbackFixturesDir) {
    candidateDirs.push(options.fallbackFixturesDir);
  }

  const checkArtifacts = options.checkArtifacts;
  for (const dir of candidateDirs) {
    if (!existsFn(dir)) continue;
    if (checkArtifacts && checkArtifacts.length > 0) {
      const hasAll = checkArtifacts.every((art) =>
        Boolean(
          findArtifactJar(dir, art, options.explicitVersion, {
            allowSnapshots: options.allowSnapshots,
            minVersion: options.minVersion,
            existsFn,
          }),
        ),
      );
      if (!hasAll) continue;
    }
    return dir;
  }

  return null;
}

interface ParsedVersion {
  parts: number[];
  qualifier?: string;
  isSnapshot: boolean;
}

function parseVersion(v: string): ParsedVersion {
  const isSnapshot = /-SNAPSHOT$/i.test(v);
  const dashIndex = v.indexOf("-");
  let core = dashIndex === -1 ? v : v.slice(0, dashIndex);
  let qualifier = dashIndex === -1 ? undefined : v.slice(dashIndex + 1);

  // If there was no dash, check if the last dot-separated part has non-numeric characters (e.g. 0.12.0.RC1)
  if (!qualifier) {
    const lastDot = core.lastIndexOf(".");
    if (lastDot !== -1) {
      const lastSegment = core.slice(lastDot + 1);
      if (!/^\d+$/.test(lastSegment)) {
        qualifier = lastSegment;
        core = core.slice(0, lastDot);
      }
    }
  }

  const parts = core.split(".").map((x) => {
    const num = parseInt(x, 10);
    return isNaN(num) ? 0 : num;
  });

  return { parts, qualifier, isSnapshot };
}

/**
 * Compares two Maven / SemVer versions.
 * Rules:
 *   - Numeric segments are compared in order (e.g. 0.12.0 > 0.11.0)
 *   - For the same base version, a release (no qualifier) outranks any qualified pre-release (e.g. 0.12.0 > 0.12.0-rc1)
 *   - A pre-release outranks a SNAPSHOT (e.g. 0.12.0-rc1 > 0.12.0-SNAPSHOT)
 *   - Pre-release qualifiers compare lexically (e.g. 0.12.0-rc2 > 0.12.0-rc1)
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const aParsed = parseVersion(a);
  const bParsed = parseVersion(b);

  const maxLen = Math.max(aParsed.parts.length, bParsed.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const aNum = aParsed.parts[i] ?? 0;
    const bNum = bParsed.parts[i] ?? 0;
    if (aNum !== bNum) {
      return aNum - bNum;
    }
  }

  // Numeric cores are equal:
  // A release (no qualifier) outranks a pre-release (with qualifier)
  if (!aParsed.qualifier && bParsed.qualifier) return 1;
  if (aParsed.qualifier && !bParsed.qualifier) return -1;
  if (!aParsed.qualifier && !bParsed.qualifier) return 0;

  // Both have qualifiers:
  if (!aParsed.isSnapshot && bParsed.isSnapshot) return 1;
  if (aParsed.isSnapshot && !bParsed.isSnapshot) return -1;

  return aParsed.qualifier!.localeCompare(bParsed.qualifier!);
}

export interface FindArtifactJarOptions {
  allowSnapshots?: boolean;
  minVersion?: string;
  existsFn?: (p: string) => boolean;
  readdirFn?: (p: string) => string[];
}

/**
 * Find the latest jar for a coordinate under <repo>/eu/exeris/<artifactId>.
 * When version is specified, requires that version.
 * When version is not specified, skips -SNAPSHOT versions unless allowSnapshots is true,
 * and skips versions below minVersion if specified.
 */
export function findArtifactJar(
  repo: string,
  artifactId: string,
  explicitVersion?: string,
  options: FindArtifactJarOptions = {},
): { jar: string; version: string } | null {
  const existsFn = options.existsFn ?? existsSync;
  const readdirFn = options.readdirFn ?? readdirSync;
  const dir = join(repo, "eu", "exeris", artifactId);
  if (!existsFn(dir)) return null;

  if (explicitVersion) {
    const jar = join(dir, explicitVersion, `${artifactId}-${explicitVersion}.jar`);
    return existsFn(jar) ? { jar, version: explicitVersion } : null;
  }

  let candidates: string[];
  try {
    candidates = readdirFn(dir).filter((e) =>
      existsFn(join(dir, e, `${artifactId}-${e}.jar`)),
    );
  } catch {
    return null;
  }

  if (!options.allowSnapshots) {
    candidates = candidates.filter((v) => !/-SNAPSHOT$/i.test(v));
  }

  if (options.minVersion) {
    candidates = candidates.filter((v) => compareVersions(v, options.minVersion!) >= 0);
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => compareVersions(b, a));
  const chosen = candidates[0];
  return { jar: join(dir, chosen, `${artifactId}-${chosen}.jar`), version: chosen };
}

/**
 * Locates the unzip binary using standard fixed system directories to avoid PATH manipulation.
 */
export function findUnzipBinary(
  candidates = ["/usr/bin/unzip", "/bin/unzip"],
  existsFn: (p: string) => boolean = existsSync,
): string {
  for (const c of candidates) {
    if (existsFn(c)) return c;
  }
  return "unzip";
}

export interface ExtractOptions {
  unzipBin?: string;
  execFileFn?: typeof execFileSync;
  existsFn?: (p: string) => boolean;
}

/**
 * Extract a resource from a jar archive using unzip -p with fixed PATH.
 */
export function extractFromJar(
  jarPath: string,
  entryPath: string,
  options: ExtractOptions = {},
): Buffer {
  const existsFn = options.existsFn ?? existsSync;
  const unzipBin = options.unzipBin ?? findUnzipBinary(["/usr/bin/unzip", "/bin/unzip"], existsFn);
  const execFn = options.execFileFn ?? execFileSync;

  try {
    return execFn(unzipBin, ["-p", jarPath, entryPath], {
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === "ENOENT") {
      throw new Error(
        `System 'unzip' binary is required to extract reference data but was not found: ${error.message}`,
        { cause: err },
      );
    }
    throw new Error(`Failed to extract ${entryPath} from ${jarPath}: ${error.message}`, {
      cause: err,
    });
  }
}

export interface SourceEntry {
  id: string;
  bytes: Buffer;
  sourceArtifact: string;
}

export interface CollectSourcesOptions {
  repo?: string | null;
  explicitVersion?: string;
  strict?: boolean;
  allowSnapshots?: boolean;
  findJarFn?: typeof findArtifactJar;
  extractFn?: typeof extractFromJar;
  warnFn?: (msg: string) => void;
  failFn?: (msg: string) => never;
}

/**
 * Collect reference data sources (annotation-catalog and ast-schema).
 */
export function collectSources(options: CollectSourcesOptions = {}): SourceEntry[] {
  const warnFn = options.warnFn ?? console.warn;
  const failFn =
    options.failFn ??
    ((msg: string) => {
      throw new Error(`[vendor-reference-data] ${msg}`);
    });
  const findJar = options.findJarFn ?? findArtifactJar;
  const extract = options.extractFn ?? extractFromJar;
  const allowSnapshots = Boolean(options.explicitVersion || options.allowSnapshots);

  const repo = options.repo;
  if (!repo) {
    if (options.strict) {
      failFn("No local Maven repository found. Set EXERIS_MAVEN_REPO or ensure ~/.m2/repository exists.");
    }
    warnFn("[vendor-reference-data] No local Maven repository found; emitting empty bundle.");
    return [];
  }

  const explicitVersion = options.explicitVersion;
  const ann = findJar(repo, "exeris-sdk-annotations", explicitVersion, { allowSnapshots, minVersion: "0.12.0" });
  const model = findJar(repo, "exeris-sdk-source-model", explicitVersion, { allowSnapshots, minVersion: "0.12.0" });

  if (!ann || !model) {
    if (options.strict) {
      failFn(
        `Could not find required Exeris SDK jars in ${repo}. annotations=${Boolean(ann)}, source-model=${Boolean(model)}`,
      );
    }
    warnFn(
      `[vendor-reference-data] Exeris SDK jars not found in ${repo} (annotations: ${ann ? ann.version : "missing"}, source-model: ${model ? model.version : "missing"}). Emitting empty bundle.`,
    );
    return [];
  }

  const catalogBytes = extract(ann.jar, "META-INF/exeris/annotation-catalog.json");
  const schemaBytes = extract(model.jar, "META-INF/exeris/ast-schema.json");

  return [
    {
      id: "annotation-catalog",
      bytes: catalogBytes,
      sourceArtifact: `eu.exeris:exeris-sdk-annotations:${ann.version}`,
    },
    {
      id: "ast-schema",
      bytes: schemaBytes,
      sourceArtifact: `eu.exeris:exeris-sdk-source-model:${model.version}`,
    },
  ];
}
