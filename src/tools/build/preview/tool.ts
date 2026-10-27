import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ProjectConfig, Unavailable } from "../../../config/env.js";
import { isInsideRealRoot, resolveInside, SandboxEscapeError } from "../../../fs/sandbox.js";
import type { RegisteredTool } from "../../types.js";
import { guard } from "../../unavailable.js";
import { scanDiagnostics } from "../diagnostics.js";
import { collectProduced, diffAgainstL1, javaL1Root, typescriptL1Root, type FileDiff } from "./diff.js";
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
import { createOutputDir, withWorkdir } from "./workdir.js";

// build-preview_generation — runs the released generator over the project's
// emitted metadata into a scratch directory and reports what it produced
// against the project's L1 tree. The scratch directory is the only thing
// written (ADR-025, `build:*` preview amendment); the project is only read.

export const METADATA_DIR = "target/classes/exeris-metadata";

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
): RegisteredTool {
  return {
    definition: {
      name: "build-preview_generation",
      description:
        "Run the generator this project pins over its emitted metadata (target/classes/exeris-metadata) and report what it WOULD write, without writing anything into the project: the files it produces (added, changed, unchanged, removed), a unified diff of each against the committed generated tree (src/main/generated/java for Java, the codegen output root for TypeScript), and the diagnostics the run printed, each EXT- identifier decoded as build-explain_diagnostic does. The generator is the version the project uses — eu.exeris:exeris-codegen-cli from the local Maven repository, or the installed @exeris/codegen-ts — never downloaded and never substituted; when none resolves, a structured reason and remedy. Run the project build first (mvn compile) so the metadata is current. Bounded by a timeout and by output and file-size caps; a run over one is stopped and the limit is named. Local only; the output exists in a temporary directory removed when the call returns.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [...TARGETS],
            description: "Which generator to run: 'java' (exeris-codegen-cli) or 'ts' (exeris-gen).",
          },
          metadataDir: {
            type: "string",
            description: `Metadata directory, relative to the project root. Defaults to ${METADATA_DIR}.`,
          },
        },
        required: ["target"],
      },
    },
    handler: guard("build", handle, async ({ project }, args) => {
      const target = args.target;
      if (typeof target !== "string" || !TARGETS.includes(target as Target)) {
        return errorText(`'target' is required and must be one of: ${TARGETS.join(", ")}.`);
      }
      const requested = args.metadataDir;
      if (requested !== undefined && (typeof requested !== "string" || requested.trim().length === 0)) {
        return errorText("'metadataDir' must be a non-empty path relative to the project root.");
      }
      const relativeDir = typeof requested === "string" ? requested.trim() : METADATA_DIR;
      if (isAbsolute(relativeDir)) {
        return errorText("'metadataDir' must be relative to the project root.");
      }
      return preview(project, ecosystemRoot, target as Target, relativeDir, deps);
    }),
  };
}

async function preview(
  project: ProjectConfig,
  ecosystemRoot: string | null,
  target: Target,
  relativeDir: string,
  deps: PreviewDeps,
): Promise<CallToolResult> {
  const projectRoot = project.projectRoot;

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

  const metadata = resolveMetadata(projectRoot, relativeDir);
  if (metadata.kind === "escape") {
    return errorText("'metadataDir' resolves outside the project root (sandbox escape); refusing to read it.");
  }
  if (metadata.kind === "absent") {
    return errorJson({
      error: "metadata_missing",
      target,
      reason: `The metadata directory '${relativeDir}' does not exist in the project, so there is nothing for the generator to read.`,
      remedy:
        "Run the project build first (for example `mvn compile`) so the annotation processor writes the metadata, then retry.",
    });
  }

  const l1Root = target === "java" ? javaL1Root(projectRoot) : typescriptL1Root(projectRoot);
  const maxFilesBytes = deps.maxFilesBytes ?? DEFAULT_MAX_FILES_BYTES;

  return withWorkdir({ protectedRoots: [projectRoot, ecosystemRoot], tmpRoot: deps.tmpRoot }, async (workdir) => {
    const launch = generator.launch(metadata.path, workdir);
    createOutputDir(workdir);

    // Both generators decide what to write from the manifest their previous run left in the
    // output root, so the run starts from the project's current L1 tree rather than from nothing.
    const seedLimit = seedFromL1(projectRoot, l1Root, launch.outputDir, maxFilesBytes);
    if (seedLimit !== null) return limitResult(target, generator, seedLimit, null, projectRoot, workdir);

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
        reason: scrub(run.spawnError, projectRoot, workdir),
        remedy: "Check that the runtime the generator needs (java, node) is installed and on PATH, then retry.",
      });
    }
    if (run.limit !== null) return limitResult(target, generator, run.limit, run, projectRoot, workdir);
    if (run.exitCode === null) {
      return errorJson({
        error: "generator_killed",
        target,
        generator: describe(generator),
        reason: `The generator was terminated by signal ${run.signal ?? "unknown"} before it finished.`,
        ...tails(scrubbed(run, projectRoot, workdir)),
      });
    }

    const report = summarise(target, generator, run, projectRoot, workdir);
    if (run.exitCode !== GENERATOR_EXIT.ok) {
      return jsonResult({
        ...report,
        files: null,
        note: "The generator did not finish successfully, so its output is not compared with the project's generated tree. The diagnostics say why.",
      });
    }

    const produced = collectProduced(launch.outputDir, maxFilesBytes);
    if (produced.limit !== null) return limitResult(target, generator, produced.limit, run, projectRoot, workdir);
    const diff = diffAgainstL1(produced.files, projectRoot, l1Root);
    if (diff.limit !== null) return limitResult(target, generator, diff.limit, run, projectRoot, workdir);

    return jsonResult({ ...report, files: group(diff.files, diff.removed) });
  });
}

function summarise(
  target: Target,
  generator: ResolvedGenerator,
  run: RunResult,
  projectRoot: string,
  workdir: string,
) {
  const text = scrubbed(run, projectRoot, workdir);
  const { matches, unrecognisedIds } = scanDiagnostics(`${text.stdout}\n${text.stderr}`);
  return {
    target,
    generator: describe(generator),
    exitCode: run.exitCode,
    outcome: outcomeOf(run.exitCode),
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
      return "invalid_arguments";
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
  const entry = (f: FileDiff) => ({
    path: f.path,
    diff: f.diff,
    ...(f.diffOmitted === undefined ? {} : { diffOmitted: f.diffOmitted }),
  });
  return {
    added: files.filter((f) => f.status === "added").map(entry),
    changed: files.filter((f) => f.status === "changed").map(entry),
    unchanged: files.filter((f) => f.status === "unchanged").map((f) => f.path),
    removed: [...removed],
  };
}

function limitResult(
  target: Target,
  generator: ResolvedGenerator,
  limit: PreviewLimit,
  run: RunResult | null,
  projectRoot: string,
  workdir: string,
): CallToolResult {
  return errorJson({
    error: "limit_exceeded",
    target,
    generator: describe(generator),
    limit: { name: limit.name, value: limit.value, unit: limit.unit },
    message: limit.message,
    ...(run === null ? {} : tails(scrubbed(run, projectRoot, workdir))),
  });
}

/** stdout and stderr with the bridge's own paths removed. */
function scrubbed(run: RunResult, projectRoot: string, workdir: string) {
  return {
    stdout: scrub(run.stdout, projectRoot, workdir),
    stderr: scrub(run.stderr, projectRoot, workdir),
  };
}

function tails(text: { stdout: string; stderr: string }) {
  const tail = (s: string): string => (s.length > OUTPUT_TAIL_CHARS ? s.slice(-OUTPUT_TAIL_CHARS) : s);
  return { stdout: tail(text.stdout), stderr: tail(text.stderr) };
}

/** Generator output echoes the paths it was given; neither the scratch directory nor the project root goes on the wire. */
function scrub(text: string, projectRoot: string, workdir: string): string {
  return text.split(workdir).join("<preview>").split(projectRoot).join("<project>");
}

type MetadataResolution =
  | { kind: "ok"; path: string }
  | { kind: "absent" }
  | { kind: "escape" };

function resolveMetadata(projectRoot: string, relativeDir: string): MetadataResolution {
  // A directory that does not exist cannot be proven inside by realpath, so the lexical form is judged too.
  if (!isInsideRealRoot(resolve(projectRoot), resolve(projectRoot, relativeDir))) return { kind: "escape" };
  try {
    const path = resolveInside(projectRoot, join(projectRoot, relativeDir));
    return statSync(path).isDirectory() ? { kind: "ok", path } : { kind: "absent" };
  } catch (err) {
    if (err instanceof SandboxEscapeError && err.resolved !== null) return { kind: "escape" };
    return { kind: "absent" };
  }
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorJson(payload: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorText(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
