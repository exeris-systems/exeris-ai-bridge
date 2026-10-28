import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ProjectConfig, Unavailable } from "../../../config/env.js";
import type { CatalogueState } from "../../../data/generator-catalogue.js";
import { isInsideRealRoot } from "../../../fs/sandbox.js";
import type { RegisteredTool } from "../../types.js";
import { guard } from "../../unavailable.js";
import { scanDiagnostics } from "../diagnostics.js";
import { computeToolingSkew } from "../tooling-skew.js";
import { collectProduced, diffAgainstL1, javaL1Root, type FileDiff } from "./diff.js";
import {
  GENERATOR_EXIT,
  resolveJavaGenerator,
  resolveTypeScriptGenerator,
  type GeneratorResolution,
  type ResolvedGenerator,
} from "./resolve-generator.js";
import {
  DEFAULT_MAX_FILES_BYTES,
  runGenerator,
  type PreviewLimit,
  type RunResult,
} from "./runner.js";
import { seedFromL1 } from "./seed.js";
import { resolveTypeScriptL1 } from "./ts-config.js";
import { validateMetadata } from "./validate-metadata.js";
import { createOutputDir, withWorkdir } from "./workdir.js";

// build-preview_generation — runs the released generator over the project's
// emitted metadata into a scratch directory and reports what it produced
// against the project's L1 tree. The scratch directory is the only thing
// written (ADR-025, `build:*` preview amendment); the project is only read.

/** Stands in when a caller supplies no catalogue: the skew is then reported as unknown. */
const CATALOGUE_NOT_LOADED: CatalogueState = {
  state: "unavailable",
  reason: "No generator catalogue was loaded for this tool.",
  remedy: "Register the build tools through registerBuildTools.",
};

export const METADATA_DIR = "target/classes/exeris-metadata";

/** The ownership record both generators keep at the root of an output tree; bookkeeping, not output. */
const MANIFEST_NAME = ".exeris-codegen-manifest";

const TARGETS = ["java", "ts"] as const;
type Target = (typeof TARGETS)[number];

/** Characters of each of stdout and stderr returned; the end is kept, since a failure is printed last. */
export const OUTPUT_TAIL_CHARS = 8_000;

/** Injectable for tests; production resolves the real generators and uses the runner's own limits. */
export interface PreviewDeps {
  readonly resolveJava?: (projectRoot: string) => GeneratorResolution;
  readonly resolveTypeScript?: (projectRoot: string) => GeneratorResolution;
  readonly tmpRoot?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxFilesBytes?: number;
  readonly graceMs?: number;
}

type Handle = { readonly state: "available"; readonly project: ProjectConfig } | Unavailable;

export function previewGenerationTool(
  handle: Handle,
  ecosystemRoot: string | null,
  deps: PreviewDeps = {},
  catalogue: CatalogueState = CATALOGUE_NOT_LOADED,
): RegisteredTool {
  return {
    definition: {
      name: "build-preview_generation",
      description:
        "Preview what the code generator would write for this project's current metadata (target/classes/exeris-metadata), without writing anything into the project. It runs the project's own generator in a separate process — for 'ts' the @exeris/codegen-ts installed in the project's node_modules, confined by Node's permission model to write only its scratch directory; for 'java' the eu.exeris:exeris-codegen-cli jar from the local Maven repository at the version the project pins — never downloaded and never substituted; when none resolves, a structured generator_unavailable with a reason and remedy. Returns the files it produced as added, changed, unchanged and removed against the committed generated tree (src/main/generated/java for Java, the codegen outputPath for TypeScript), a unified diff for each added or changed file, and the run's diagnostics with every EXT- identifier decoded as build-explain_diagnostic does. 'unchanged' includes hand-written files already in the committed tree, which the run starts from; the generator's own manifest file is not listed. Unlike the present:false answers of the other build-* tools, this one cannot answer without metadata, so a project that has not been built returns the error metadata_missing: run the project build first (mvn compile). Metadata whose names could not be a Java identifier or a package are refused as metadata_invalid before any generator starts. Bounded by a timeout and by output and file-size caps; a run over one is stopped and the limit is named. Local only; the output exists in a temporary directory removed when the call returns.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [...TARGETS],
            description: "Which generator to run: 'java' (exeris-codegen-cli) or 'ts' (exeris-gen).",
          },
        },
        required: ["target"],
      },
    },
    handler: guard("build", handle, async ({ project }, args) => {
      const target = args.target;
      if (typeof target !== "string" || !TARGETS.includes(target as Target)) {
        return errorJson({
          error: "invalid_input",
          target: null,
          reason: `'target' is required and must be one of: ${TARGETS.join(", ")}.`,
          remedy: "Pass target 'java' or 'ts'.",
        });
      }
      if (Object.keys(args).some((key) => key !== "target")) {
        return errorJson({
          error: "invalid_input",
          target,
          reason: `Only 'target' is accepted; the metadata directory is always ${METADATA_DIR}.`,
          remedy: "Call again with just 'target'.",
        });
      }
      try {
        return await preview(project, ecosystemRoot, target as Target, deps, catalogue);
      } catch (err) {
        return failed(target, err, makeScrub(project.projectRoot, []));
      }
    }),
  };
}

async function preview(
  project: ProjectConfig,
  ecosystemRoot: string | null,
  target: Target,
  deps: PreviewDeps,
  catalogue: CatalogueState,
): Promise<CallToolResult> {
  const projectRoot = project.projectRoot;

  const metadata = resolveMetadata(projectRoot);
  if (metadata.kind === "escape") {
    return errorJson({
      error: "metadata_escape",
      target,
      reason: `${METADATA_DIR} resolves outside the project root (sandbox escape); refusing to read it.`,
      remedy: "Make target/classes a directory inside the project (not a link elsewhere), then rebuild.",
    });
  }
  if (metadata.kind === "unreadable") {
    return errorJson({
      error: "metadata_unreadable",
      target,
      code: metadata.code,
      reason: `${METADATA_DIR} could not be read (${metadata.code}).`,
      remedy: "Fix the permissions or the link on target/classes, then retry.",
    });
  }
  if (metadata.kind === "absent") {
    return errorJson({
      error: "metadata_missing",
      target,
      reason: `The project has no ${METADATA_DIR} directory, so there is nothing for the generator to read.`,
      remedy:
        "Run the project build first (for example `mvn compile`) so the annotation processor writes the metadata, then retry.",
    });
  }
  const problem = validateMetadata(metadata.path, METADATA_DIR);
  if (problem !== null) {
    return errorJson({
      error: "metadata_invalid",
      target,
      reason: problem.reason,
      remedy:
        "Fix the declaration the file was generated from (a name must be a Java identifier, a package a dotted one), rebuild, and retry. The preview does not run a generator over metadata it cannot vouch for.",
      file: problem.file,
    });
  }

  const generator =
    target === "java"
      ? (deps.resolveJava ?? ((root) => resolveJavaGenerator(root, { env: process.env })))(projectRoot)
      : (deps.resolveTypeScript ?? ((root) => resolveTypeScriptGenerator(root, process.env)))(projectRoot);
  if (generator.state === "unavailable") {
    return errorJson({
      error: "generator_unavailable",
      target,
      reason: generator.reason,
      remedy: generator.remedy,
    });
  }

  let l1Root: string;
  let l1Source: "default" | "config" = "default";
  if (target === "java") {
    l1Root = javaL1Root(projectRoot);
  } else {
    const l1 = resolveTypeScriptL1(projectRoot);
    if (l1.kind === "refused") {
      return errorJson({ error: l1.error, target, reason: l1.reason, remedy: l1.remedy });
    }
    l1Root = l1.root;
    l1Source = l1.source;
  }
  const maxFilesBytes = deps.maxFilesBytes ?? DEFAULT_MAX_FILES_BYTES;

  return withWorkdir({ protectedRoots: [projectRoot, ecosystemRoot], tmpRoot: deps.tmpRoot }, async (workdir) => {
    const scrub = makeScrub(projectRoot, [[workdir, "<preview>"], ...generatorPaths(generator)]);
    try {
      const launch = generator.launch(metadata.path, workdir);
      createOutputDir(workdir);

      // Both generators decide what to write from the manifest their previous run left in the
      // output root, so the run starts from the project's current L1 tree rather than from nothing.
      const seeded = seedFromL1(projectRoot, l1Root, launch.outputDir, maxFilesBytes);
      if (seeded.limit !== null) return limitResult(target, generator, seeded.limit, null, scrub);

      const run = await runGenerator({
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        timeoutMs: deps.timeoutMs,
        maxOutputBytes: deps.maxOutputBytes,
        graceMs: deps.graceMs,
      });
      if (run.spawnError !== null) {
        return errorJson({
          error: "generator_not_started",
          target,
          generator: describe(generator),
          reason: scrub(run.spawnError),
          remedy: "Check that the runtime the generator needs (java, node) is installed and on PATH, then retry.",
        });
      }
      if (run.limit !== null) return limitResult(target, generator, run.limit, run, scrub);
      if (run.exitCode === null) {
        return errorJson({
          error: "generator_killed",
          target,
          generator: describe(generator),
          reason: `The generator was terminated by signal ${run.signal ?? "unknown"} before it finished.`,
          remedy: "Run the generator yourself to see why it was killed (for example an out-of-memory kill), then retry.",
          ...tails(scrubbed(run, scrub)),
        });
      }

      const l1 = {
        root: relative(projectRoot, l1Root).split(sep).join("/"),
        source: l1Source,
        seeded: seeded.copied > 0,
      };
      const report = summarise(target, generator, run, l1, scrub, catalogue);
      if (run.exitCode !== GENERATOR_EXIT.ok) {
        return jsonResult({
          ...report,
          files: null,
          note: "The generator did not finish successfully, so its output is not compared with the project's generated tree. The diagnostics say why.",
        });
      }

      const produced = collectProduced(launch.outputDir, maxFilesBytes);
      if (produced.limit !== null) return limitResult(target, generator, produced.limit, run, scrub);
      const diff = diffAgainstL1(produced.files, projectRoot, l1Root, maxFilesBytes);
      if (diff.limit !== null) return limitResult(target, generator, diff.limit, run, scrub);

      return jsonResult({ ...report, files: group(diff.files, diff.removed) });
    } catch (err) {
      return failed(target, err, scrub);
    }
  });
}

function summarise(
  target: Target,
  generator: ResolvedGenerator,
  run: RunResult,
  l1: { root: string; source: "default" | "config"; seeded: boolean },
  scrub: Scrubber,
  catalogue: CatalogueState,
) {
  const text = scrubbed(run, scrub);
  const { matches, unrecognisedIds } = scanDiagnostics(`${text.stdout}\n${text.stderr}`);
  return {
    target,
    generator: describe(generator),
    // The generator that ran is the pinned one; the catalogue decoded its diagnostics.
    toolingSkew: computeToolingSkew(catalogue, {
      kind: "pinned",
      version: generator.version,
      source: generator.pinSource,
    }),
    exitCode: run.exitCode,
    outcome: outcomeOf(run.exitCode),
    l1,
    diagnostics: {
      matches,
      ...(unrecognisedIds.length === 0
        ? {}
        : {
            unrecognisedIds,
            gap: "These EXT- identifiers have no entry in this bridge's catalogue; the message text printed with each is the explanation.",
          }),
    },
    ...tails(text),
  };
}

function outcomeOf(exitCode: number | null): string {
  switch (exitCode) {
    case GENERATOR_EXIT.ok:
      return "generated";
    case GENERATOR_EXIT.failed:
      return "refused_or_failed";
    case GENERATOR_EXIT.invalidArguments:
      return "generator_rejected_arguments";
    default:
      return "unexpected_exit";
  }
}

function describe(generator: ResolvedGenerator) {
  return {
    kind: generator.kind,
    version: generator.version,
    source: generator.source,
    path: generator.path,
  };
}

function group(files: readonly FileDiff[], removed: readonly string[]) {
  const listed = files.filter((f) => f.path !== MANIFEST_NAME);
  const entry = (f: FileDiff) => ({
    path: f.path,
    diff: f.diff,
    ...(f.diffOmitted === undefined ? {} : { diffOmitted: f.diffOmitted }),
  });
  return {
    added: listed.filter((f) => f.status === "added").map(entry),
    changed: listed.filter((f) => f.status === "changed").map(entry),
    unchanged: listed.filter((f) => f.status === "unchanged").map((f) => f.path),
    removed: removed.filter((p) => p !== MANIFEST_NAME),
  };
}

const LIMIT_REMEDY: Record<PreviewLimit["name"], string> = {
  timeout: "The preview cannot run longer than this. Run the generator yourself (`mvn exeris:generate` or `exeris-gen generate`) if it needs more time.",
  output: "The generator printed more than the preview keeps. Run it yourself to read its full output.",
  files: "The generated tree or the produced files exceed what the preview compares. Run the generator yourself to see the full result.",
};

function limitResult(
  target: Target,
  generator: ResolvedGenerator,
  limit: PreviewLimit,
  run: RunResult | null,
  scrub: Scrubber,
): CallToolResult {
  return errorJson({
    error: "limit_exceeded",
    target,
    generator: describe(generator),
    limit: { name: limit.name, value: limit.value, unit: limit.unit },
    reason: limit.message,
    remedy: LIMIT_REMEDY[limit.name],
    ...(run === null ? {} : tails(scrubbed(run, scrub))),
  });
}

/** An error thrown while previewing: the code and a message with the bridge's own paths removed. */
function failed(target: string, err: unknown, scrub: Scrubber): CallToolResult {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return errorJson({
    error: "preview_failed",
    target,
    code: typeof code === "string" ? code : err instanceof Error ? err.name : "Error",
    reason: scrub(err instanceof Error ? err.message : String(err)),
    remedy:
      "Check that the project's metadata and generated tree are readable by this process and that the temporary directory is writable, then retry.",
  });
}

/** stdout and stderr with the bridge's own paths removed. */
function scrubbed(run: RunResult, scrub: Scrubber) {
  return { stdout: scrub(run.stdout), stderr: scrub(run.stderr) };
}

function tails(text: { stdout: string; stderr: string }) {
  const tail = (s: string): string => (s.length > OUTPUT_TAIL_CHARS ? s.slice(-OUTPUT_TAIL_CHARS) : s);
  return { stdout: tail(text.stdout), stderr: tail(text.stderr) };
}

type Scrubber = (text: string) => string;

function generatorPaths(generator: ResolvedGenerator): [string, string][] {
  return generator.privatePaths.map((p): [string, string] => [p, "<generator>"]);
}

/**
 * Generator output and runtime errors echo the paths they were given. None of the bridge's
 * own locations goes on the wire: the scratch directory, the project root, the generator's
 * files and repository, the Java and Node installations and the home directory, each also
 * in its `file:` URL form. Longer paths are replaced first, so a path inside another is
 * not left half-replaced.
 */
function makeScrub(projectRoot: string, extra: [string, string][]): Scrubber {
  const entries: [string, string][] = [[projectRoot, "<project>"], ...extra];
  const java = process.env.JAVA_HOME?.trim();
  if (java) entries.push([java, "<java-home>"]);
  entries.push([dirname(process.execPath), "<node>"]);
  entries.push([process.env.HOME?.trim() || homedir(), "~"]);

  const replacements: [string, string][] = [];
  for (const [path, placeholder] of entries) {
    if (path.length < 2 || path === sep) continue;
    for (const form of new Set([path, safeReal(path)])) {
      replacements.push([form, placeholder], [pathToFileURL(form).href, placeholder]);
    }
  }
  replacements.sort((a, b) => b[0].length - a[0].length);
  return (text) => replacements.reduce((acc, [from, to]) => acc.split(from).join(to), text);
}

function safeReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

type MetadataResolution =
  | { kind: "ok"; path: string }
  | { kind: "absent" }
  | { kind: "escape" }
  | { kind: "unreadable"; code: string };

/** A missing directory is absent; a link, a permission or a loop problem is not "does not exist". */
function resolveMetadata(projectRoot: string): MetadataResolution {
  let real: string;
  try {
    real = realpathSync(join(projectRoot, METADATA_DIR));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unreadable", code };
  }
  if (!isInsideRealRoot(realpathSync(projectRoot), real)) return { kind: "escape" };
  try {
    return statSync(real).isDirectory() ? { kind: "ok", path: real } : { kind: "absent" };
  } catch (err) {
    return { kind: "unreadable", code: (err as NodeJS.ErrnoException).code ?? "UNKNOWN" };
  }
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorJson(payload: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
