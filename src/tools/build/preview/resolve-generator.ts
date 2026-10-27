import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Unavailable } from "../../../config/env.js";
import { findArtifactJar, resolveLocalRepository } from "../../../config/maven.js";
import { isInsideRealRoot, resolveInside } from "../../../fs/sandbox.js";
import { generatorEnv } from "./runner.js";
import { OUTPUT_SUBDIR } from "./workdir.js";
import {
  readInstalledCodegenTs,
  resolveJavaToolingPin,
  type ToolingVersionSource,
} from "../../../config/tooling-pin.js";

// Finds the generator the PROJECT pins, locally, and refuses to guess.
//
// Two rules hold for both generators. Nothing is downloaded: every lookup reads
// a directory or a manifest. And there is no fallback to another version: a
// generator of a different release answers for a contract the project does not
// use, so "not found" is a structured reason and remedy, never a near miss.

export type GeneratorKind = "java" | "typescript";

/**
 * The launch of one resolved generator over a metadata directory.
 *
 * The generator is confined to the scratch directory: its output goes to a
 * subdirectory of it (`outputDir`), and its environment is the fixed allowlist
 * of generatorEnv(), so a variable such as JAVA_TOOL_OPTIONS cannot redirect a
 * dump or a log elsewhere.
 */
export interface GeneratorLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory the generator runs in. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Where the generator writes the files it produces; the only directory that is listed and diffed. */
  readonly outputDir: string;
}

export interface ResolvedGenerator {
  readonly state: "available";
  readonly kind: GeneratorKind;
  /** The version the project pins (Java) or has installed (TypeScript). */
  readonly version: string;
  /** Where it was found: the local Maven repository (Java) or the project's `node_modules` (TypeScript). */
  readonly source: "m2" | "node_modules";
  /** Where the project's pin of `version` was read from; the tooling-skew report names it. */
  readonly pinSource: ToolingVersionSource;
  /**
   * The launched artefact relative to the local Maven repository or the project root, `/`-separated,
   * so it is safe to show an agent.
   */
  readonly path: string;
  /** Absolute paths the generator's output may echo (the artefact and the repository holding it); they never go on the wire. */
  readonly privatePaths: readonly string[];
  /** Build the launch for one run inside the bridge's scratch directory. */
  launch(metadataDir: string, workdir: string): GeneratorLaunch;
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

/** A Maven version as a single path segment: no separator, no `..`. */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeVersion(version: string): boolean {
  return SAFE_VERSION.test(version) && !version.includes("..");
}

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
  const pinned = resolveJavaToolingPin(projectRoot);
  if (pinned.kind === "none") {
    return unavailable(
      pinned.reason,
      "Build the project on exeris-app-parent (or declare exeris-codegen-maven-plugin with a version) so the tooling version is pinned, then retry.",
    );
  }
  const version = pinned.version;
  if (!isSafeVersion(version)) {
    return unavailable(
      "The tooling version pinned in pom.xml is not a plain Maven version, so no generator is resolved for it.",
      "Pin a release version such as 0.10.0 on exeris-app-parent or exeris-codegen-maven-plugin, then retry.",
    );
  }

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

  if (!isInsideLocalRepository(repo, jar)) {
    return unavailable(
      `eu.exeris:exeris-codegen-cli:${version} resolves outside the local Maven repository, so it is not launched.`,
      "Reinstall the artifact into the local Maven repository, then retry.",
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

  // Invariant: the JVM has no write confinement. What keeps a crafted metadata name from
  // placing a file outside the scratch directory is the corpus check that runs before the
  // launch (validate-metadata.ts); there is no runtime sandbox for Java to rely on.
  const command = javaCommand(deps.env);
  const baseEnv = deps.env;
  return {
    state: "available",
    kind: "java",
    version,
    source: "m2",
    pinSource: pinned.source,
    path: relative(repo, jar).split(sep).join("/"),
    privatePaths: [jar, repo],
    launch: (metadataDir, workdir) => {
      const outputDir = join(workdir, OUTPUT_SUBDIR);
      return {
        command,
        // The crash log is directed into the scratch directory, outside outputDir:
        // the JVM would otherwise write hs_err_pid*.log into its working directory.
        args: [
          // No hsperfdata file: the JVM would otherwise create /tmp/hsperfdata_<user> outside the scratch directory.
          "-XX:-UsePerfData",
          `-XX:ErrorFile=${join(workdir, "hs_err_pid%p.log")}`,
          "-jar",
          jar,
          `--metadata-dir=${metadataDir}`,
          `--output-dir=${outputDir}`,
        ],
        cwd: workdir,
        env: generatorEnv(baseEnv, workdir),
        outputDir,
      };
    },
  };
}

function isInsideLocalRepository(repo: string, jar: string): boolean {
  try {
    return isInsideRealRoot(realpathSync.native(repo), realpathSync.native(jar));
  } catch {
    return false;
  }
}

function javaCommand(env: NodeJS.ProcessEnv): string {
  const home = env.JAVA_HOME?.trim();
  if (home !== undefined && home.length > 0) {
    return join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
  }
  return "java";
}

/**
 * Major version printed by `java -version`, or null when it cannot be run.
 * `java -version` exits 0 and writes to stderr, so stderr is read on success too.
 */
export function probeJavaMajor(env: NodeJS.ProcessEnv): number | null {
  const probe = spawnSync(javaCommand(env), ["-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (probe.error !== undefined) return null;
  return parseJavaMajor(`${probe.stderr ?? ""}\n${probe.stdout ?? ""}`);
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

const BIN_NAME = "exeris-gen";

/**
 * Resolve the `exeris-gen` entry point of the project's installed
 * `@exeris/codegen-ts`. The installed package IS the pinned version.
 *
 * Launch: `node <bin> generate --input <metadataDir> --output <outputDir>`.
 * Flags per `exeris-codegen-ts/src/index.ts` (`generate`: `-i, --input <path>`,
 * `-o, --output <path>`); the run's other settings come from the project's
 * `exeris-codegen.json`, which the generator reads from its working directory.
 */
export function resolveTypeScriptGenerator(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): GeneratorResolution {
  const absent = unavailable(
    "@exeris/codegen-ts was not found in the project's own node_modules (a workspace-hoisted install is not followed), so there is no TypeScript generator at the project's version.",
    "Run 'npm install' in the project (with @exeris/codegen-ts as a dependency), then retry. The bridge does not download it.",
  );

  const installed = readInstalledCodegenTs(projectRoot);
  if (installed === null) return absent;
  const { pkgDir, manifest } = installed;

  const version = typeof manifest.version === "string" ? manifest.version : null;
  const binRelative = binEntry(manifest.bin);
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
    source: "node_modules",
    pinSource: "node-modules",
    path: relative(projectRoot, bin).split(sep).join("/"),
    privatePaths: [pkgDir],
    launch: (metadataDir, workdir) => {
      const outputDir = join(workdir, OUTPUT_SUBDIR);
      return {
        command: process.execPath,
        // The generator writes wherever the metadata's names lead, and exeris-gen has no write
        // containment of its own. Node's permission model is the containment: reads are open (the
        // package, the project's config and metadata), writes are limited to the scratch directory,
        // and child processes, workers and addons stay denied because they are not granted.
        args: [...nodePermissionFlags(workdir), bin, "generate", "--input", metadataDir, "--output", outputDir],
        // The project root, not the scratch directory: exeris-gen finds exeris-codegen.json from
        // its working directory and has no --config flag. Every path it writes is absolute and
        // inside the scratch directory.
        cwd: projectRoot,
        env: generatorEnv(env, workdir),
        outputDir,
      };
    },
  };
}

/**
 * The flag that turns the permission model on: `--permission` from Node 22.13 and 23.5 (where it
 * became stable), `--experimental-permission` before that (Node 20 and 21, and 22 before 22.13).
 */
export function nodePermissionFlag(nodeVersion: string = process.versions.node): string {
  const [major = 0, minor = 0] = nodeVersion.split(".").map((part) => Number.parseInt(part, 10));
  const stable = major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
  return stable ? "--permission" : "--experimental-permission";
}

/** Read anywhere, write only under `workdir`; nothing else is granted. */
export function nodePermissionFlags(workdir: string, nodeVersion?: string): string[] {
  return [nodePermissionFlag(nodeVersion), "--allow-fs-read=*", `--allow-fs-write=${workdir}`];
}

/** The `exeris-gen` path from a package.json `bin` field (a string, or a name -> path map). */
function binEntry(bin: unknown): unknown {
  if (typeof bin === "string") return bin;
  if (typeof bin === "object" && bin !== null) return (bin as Record<string, unknown>)[BIN_NAME];
  return undefined;
}
