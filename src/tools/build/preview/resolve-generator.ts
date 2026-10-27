import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Unavailable } from "../../../config/env.js";
import { findArtifactJar, resolveLocalRepository } from "../../../config/maven.js";
import { resolveInside } from "../../../fs/sandbox.js";
import { APP_GROUP_IDS, parsePom, readBounded, resolveValue } from "../../../config/pom.js";

// Finds the generator the PROJECT pins, locally, and refuses to guess.
//
// Two rules hold for both generators. Nothing is downloaded: every lookup reads
// a directory or a manifest. And there is no fallback to another version: a
// generator of a different release answers for a contract the project does not
// use, so "not found" is a structured reason and remedy, never a near miss.

export type GeneratorKind = "java" | "typescript";

/** The launch of one resolved generator over a metadata directory into an output directory. */
export interface GeneratorLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory the generator runs in. */
  readonly cwd: string;
}

export interface ResolvedGenerator {
  readonly state: "available";
  readonly kind: GeneratorKind;
  /** The version the project pins (Java) or has installed (TypeScript). */
  readonly version: string;
  /** Build the launch for one run. The output directory is the bridge's scratch directory. */
  launch(metadataDir: string, outputDir: string): GeneratorLaunch;
}

export type GeneratorResolution = ResolvedGenerator | Unavailable;

/**
 * Exit statuses of the Java generator (ADR-097): 0 generated, 1 generation
 * refused or failed (an `[Exeris] EXT-…` line names why), 2 invalid arguments.
 * The TypeScript generator exits 0 on success and 1 on any error.
 */
export const GENERATOR_EXIT = { ok: 0, failed: 1, invalidArguments: 2 } as const;

/** The first Java major that runs the released `exeris-codegen-cli`. */
export const MIN_JAVA_MAJOR = 25;

const CODEGEN_CLI = { groupId: "eu.exeris", artifactId: "exeris-codegen-cli" } as const;
const CODEGEN_PLUGIN = "exeris-codegen-maven-plugin";

function unavailable(reason: string, remedy: string): Unavailable {
  return { state: "unavailable", reason, remedy };
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

export interface JavaResolveDeps {
  readonly env: NodeJS.ProcessEnv;
  /** Major version of the `java` that would run the jar, or null when none runs. Injected by tests. */
  readonly javaMajor?: () => number | null;
}

/**
 * Resolve `eu.exeris:exeris-codegen-cli:<pinned version>` from the local Maven
 * repository. The pinned version is the project's `exeris-app-parent` parent
 * version, else its `exeris-codegen-maven-plugin` version; both are read from
 * the project's own `pom.xml`.
 *
 * Launch: `java -jar <jar> --metadata-dir=<dir> --output-dir=<dir>` (ADR-097).
 */
export function resolveJavaGenerator(projectRoot: string, deps: JavaResolveDeps): GeneratorResolution {
  const pinned = pinnedToolingVersion(projectRoot);
  if (pinned.kind === "none") {
    return unavailable(
      pinned.reason,
      "Build the project on exeris-app-parent (or declare exeris-codegen-maven-plugin with a version) so the tooling version is pinned, then retry.",
    );
  }
  const version = pinned.version;

  const repo = resolveLocalRepository(deps.env);
  if (repo === null) {
    return unavailable(
      "No local Maven repository was found, so the project's pinned generator cannot be resolved.",
      `Run a Maven build of the project once so eu.exeris:exeris-codegen-cli:${version} is installed locally, or set EXERIS_MAVEN_REPO.`,
    );
  }
  const jar = findArtifactJar(repo, CODEGEN_CLI, version);
  if (jar === null) {
    return unavailable(
      `eu.exeris:exeris-codegen-cli:${version} is not in the local Maven repository. The bridge does not download it and does not substitute another version.`,
      `Run 'mvn dependency:get -Dartifact=eu.exeris:exeris-codegen-cli:${version}' (or a build of the project) to install it, then retry.`,
    );
  }

  const major = (deps.javaMajor ?? (() => probeJavaMajor(deps.env)))();
  if (major === null) {
    return unavailable(
      "No 'java' executable could be run, and the Java generator is a Java program.",
      `Install a JDK ${MIN_JAVA_MAJOR} or newer and put it on PATH (or set JAVA_HOME).`,
    );
  }
  if (major < MIN_JAVA_MAJOR) {
    return unavailable(
      `The Java generator needs Java ${MIN_JAVA_MAJOR} or newer; the 'java' found is version ${major}.`,
      `Install a JDK ${MIN_JAVA_MAJOR} or newer and put it first on PATH (or set JAVA_HOME).`,
    );
  }

  const command = javaCommand(deps.env);
  return {
    state: "available",
    kind: "java",
    version,
    launch: (metadataDir, outputDir) => ({
      command,
      args: ["-jar", jar, `--metadata-dir=${metadataDir}`, `--output-dir=${outputDir}`],
      cwd: projectRoot,
    }),
  };
}

type PinnedVersion =
  | { readonly kind: "pinned"; readonly version: string }
  | { readonly kind: "none"; readonly reason: string };

/** The project's pinned tooling version: the app-parent version first, else the codegen plugin's. */
function pinnedToolingVersion(projectRoot: string): PinnedVersion {
  const content = readBounded(projectRoot, join(projectRoot, "pom.xml"));
  if (content === null) {
    return { kind: "none", reason: "The project has no readable pom.xml, so its pinned tooling version is unknown." };
  }
  const model = parsePom(content);

  const parent = model.parent;
  if (
    parent !== undefined &&
    APP_GROUP_IDS.includes(parent.groupId) &&
    parent.artifactId === "exeris-app-parent"
  ) {
    const version = resolveValue(parent.version, model.properties);
    return version === null
      ? { kind: "none", reason: `pom.xml parents on exeris-app-parent at "${parent.version}", which is not a concrete version the bridge can resolve.` }
      : { kind: "pinned", version };
  }

  const pluginVersion = codegenPluginVersion(model.body, model.properties);
  if (pluginVersion !== null) return { kind: "pinned", version: pluginVersion };
  return {
    kind: "none",
    reason: `pom.xml neither parents on exeris-app-parent nor declares ${CODEGEN_PLUGIN} with a concrete version, so no tooling version is pinned.`,
  };
}

function codegenPluginVersion(body: string, properties: Map<string, string>): string | null {
  const pluginRegex = /<plugin>([\s\S]*?)<\/plugin>/gi;
  let match: RegExpExecArray | null;
  while ((match = pluginRegex.exec(body)) !== null) {
    const block = match[1];
    if (!new RegExp(`<artifactId>\\s*${CODEGEN_PLUGIN}\\s*</artifactId>`, "i").test(block)) continue;
    const raw = /<version>\s*([^<\s]+)\s*<\/version>/i.exec(block);
    if (raw === null) continue;
    const resolved = resolveValue(raw[1], properties);
    if (resolved !== null) return resolved;
  }
  return null;
}

function javaCommand(env: NodeJS.ProcessEnv): string {
  const home = env.JAVA_HOME?.trim();
  if (home !== undefined && home.length > 0) {
    return join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
  }
  return "java";
}

/** Major version printed by `java -version` (it writes to stderr), or null when it cannot be run. */
function probeJavaMajor(env: NodeJS.ProcessEnv): number | null {
  try {
    const out = execFileSync(javaCommand(env), ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return parseJavaMajor(out);
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    return typeof stderr === "string" ? parseJavaMajor(stderr) : null;
  }
}

/** `version "26"` -> 26, `version "25.0.1"` -> 25, legacy `version "1.8.0_402"` -> 8. */
export function parseJavaMajor(output: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (m === null) return null;
  const first = Number(m[1]);
  return first === 1 && m[2] !== undefined ? Number(m[2]) : first;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

const CODEGEN_TS_PACKAGE_DIR = ["node_modules", "@exeris", "codegen-ts"] as const;
const BIN_NAME = "exeris-gen";
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Resolve the `exeris-gen` entry point of the project's installed
 * `@exeris/codegen-ts`. The installed package IS the pinned version.
 *
 * Launch: `node <bin> generate --input <metadataDir> --output <outputDir>`.
 * Flags per `exeris-codegen-ts/src/index.ts` (`generate`: `-i, --input <path>`,
 * `-o, --output <path>`); the run's other settings come from the project's
 * `exeris-codegen.json`, which the generator reads from its working directory.
 */
export function resolveTypeScriptGenerator(projectRoot: string): GeneratorResolution {
  const absent = unavailable(
    "@exeris/codegen-ts is not installed in the project's node_modules, so there is no TypeScript generator at the project's version.",
    "Run 'npm install' in the project (with @exeris/codegen-ts as a dependency), then retry. The bridge does not download it.",
  );

  let pkgDir: string;
  let manifest: { version?: unknown; bin?: unknown };
  try {
    pkgDir = resolveInside(projectRoot, join(projectRoot, ...CODEGEN_TS_PACKAGE_DIR));
    const manifestPath = resolveInside(pkgDir, join(pkgDir, "package.json"));
    if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) return absent;
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; bin?: unknown };
  } catch {
    return absent;
  }

  const version = typeof manifest.version === "string" ? manifest.version : null;
  const binRelative =
    typeof manifest.bin === "string"
      ? manifest.bin
      : typeof manifest.bin === "object" && manifest.bin !== null
        ? (manifest.bin as Record<string, unknown>)[BIN_NAME]
        : undefined;
  if (version === null || typeof binRelative !== "string") {
    return unavailable(
      `The installed @exeris/codegen-ts has no ${BIN_NAME} entry in its package.json.`,
      "Reinstall @exeris/codegen-ts in the project, then retry.",
    );
  }

  let bin: string;
  try {
    // The bin path comes from a manifest; it must stay inside the package.
    bin = resolveInside(pkgDir, join(pkgDir, binRelative));
  } catch {
    return unavailable(
      `The installed @exeris/codegen-ts declares a ${BIN_NAME} entry that is missing or outside the package.`,
      "Reinstall @exeris/codegen-ts in the project, then retry.",
    );
  }

  return {
    state: "available",
    kind: "typescript",
    version,
    launch: (metadataDir, outputDir) => ({
      command: process.execPath,
      args: [bin, "generate", "--input", metadataDir, "--output", outputDir],
      cwd: projectRoot,
    }),
  };
}
