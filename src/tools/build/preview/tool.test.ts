import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../../../config/env.js";
import { writeCatalogueBundle } from "../../../data/__tests__/generator-catalogue-fixture.js";
import { registerBuildTools } from "../index.js";
import { generatorEnv } from "./runner.js";
import type { GeneratorResolution } from "./resolve-generator.js";
import type { PreviewDeps } from "./tool.js";

// The generators are small Node scripts written into a scratch directory; they
// stand in for java / exeris-gen and mimic the one behaviour the tool depends
// on: a run reads the manifest its previous run left in the output root.

const MANIFEST = ".exeris-codegen-manifest";
const JAVA_L1 = "src/main/generated/java";
const TS_L1 = "src/app/generated";
const METADATA = "target/classes/exeris-metadata";

let scratch: string;
let project: string;
let tmpRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "exeris-preview-tool-"));
  project = join(scratch, "project");
  tmpRoot = join(scratch, "tmp");
  mkdirSync(join(project, METADATA), { recursive: true });
  mkdirSync(tmpRoot);
  writeFileSync(join(project, METADATA, "Station.json"), "{}");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function configFor(root: string | null): BridgeConfig {
  const na = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };
  return {
    mode: "app",
    modeSource: "default",
    ecosystemRoot: null,
    docs: na,
    lsp: na,
    kernel: na,
    project:
      root === null
        ? { state: "unavailable", reason: "no project root (test)", remedy: "set EXERIS_PROJECT_ROOT (test)" }
        : { state: "available", projectRoot: root, source: "env" },
  };
}

function toolFor(root: string | null, deps: PreviewDeps = {}) {
  const dir = mkdtempSync(join(scratch, "bundle-"));
  const tools = registerBuildTools(configFor(root), writeCatalogueBundle(dir), dir, { tmpRoot, ...deps });
  return tools.find((t) => t.definition.name === "build-preview_generation")!;
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

// Test-only: index the decoded payload directly.
function payload(res: CallToolResult): any {
  return JSON.parse(text(res));
}

/** A resolver whose launch runs `source` as a Node script with `(metadataDir, outputDir)` as arguments. */
function fake(name: string, source: string, kind: "java" | "typescript" = "java"): () => GeneratorResolution {
  const script = join(scratch, `${name}.mjs`);
  writeFileSync(script, source);
  return () => ({
    state: "available",
    kind,
    version: "0.10.0",
    source: kind === "java" ? "m2" : "node_modules",
    path: "fake/generator",
    launch: (metadataDir, workdir) => {
      const outputDir = join(workdir, "out");
      return {
        command: process.execPath,
        args: [script, metadataDir, outputDir],
        cwd: workdir,
        env: generatorEnv(process.env, workdir),
        outputDir,
      };
    },
  });
}

/**
 * Mimics a generator's manifest semantics: writes `A.java` and `seed.txt` (the
 * latter only when absent), deletes files the previous manifest lists that this
 * run does not produce, and records the new manifest.
 */
const MANIFEST_GENERATOR = `
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const out = process.argv[3];
const manifest = join(out, "${MANIFEST}");
const previous = existsSync(manifest)
  ? readFileSync(manifest, "utf8").split("\\n").filter((l) => l && !l.startsWith("#"))
  : [];
const produced = { "A.java": "class A {}\\n", "seed.txt": "default\\n" };
for (const [rel, body] of Object.entries(produced)) {
  const full = join(out, rel);
  if (rel === "seed.txt" && existsSync(full)) continue;
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}
for (const rel of previous) {
  if (!(rel in produced) && existsSync(join(out, rel))) unlinkSync(join(out, rel));
}
writeFileSync(manifest, "# manifest\\n" + Object.keys(produced).sort().join("\\n") + "\\n");
console.log("generated");
`;

function write(rel: string, body: string): void {
  const full = join(project, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

/** Every path, file content and link target under `root`, hashed: byte-for-byte, mtimes excluded. */
function hashTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = `${prefix}/${name}`;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) hash.update(`L ${rel} ${readlinkSync(full)}\n`);
      else if (st.isDirectory()) {
        hash.update(`D ${rel}\n`);
        walk(full, rel);
      } else hash.update(`F ${rel} ${createHash("sha256").update(readFileSync(full)).digest("hex")}\n`);
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

function workdirsLeft(): string[] {
  return readdirSync(tmpRoot);
}

test("the preview writes nothing into the project and leaves no scratch directory", async () => {
  write(`${JAVA_L1}/A.java`, "class A { int old; }\n");
  write(`${JAVA_L1}/seed.txt`, "mine\n");
  write(`${JAVA_L1}/Old.java`, "class Old {}\n");
  write(`${JAVA_L1}/${MANIFEST}`, "# manifest\nA.java\nOld.java\nseed.txt\n");
  write("pom.xml", "<project/>");
  const before = hashTree(project);

  const res = await toolFor(project, { resolveJava: fake("manifest", MANIFEST_GENERATOR) }).handler({
    target: "java",
  });

  assert.equal(res.isError, undefined, text(res));
  const out = payload(res);
  assert.equal(out.exitCode, 0);
  assert.equal(out.outcome, "generated");
  assert.deepEqual(out.generator, { kind: "java", version: "0.10.0", source: "m2", path: "fake/generator" });
  assert.deepEqual(out.files.changed.map((f: { path: string }) => f.path).sort(), [MANIFEST, "A.java"].sort());
  assert.match(out.files.changed.find((f: { path: string }) => f.path === "A.java").diff, /-class A \{ int old; \}/);
  assert.deepEqual(out.files.unchanged, ["seed.txt"]);
  assert.deepEqual(out.files.removed, ["Old.java"]);
  assert.deepEqual(out.files.added, []);
  assert.equal(hashTree(project), before);
  assert.deepEqual(workdirsLeft(), []);
});

test("a Java run starts from the project's L1 tree: a seed file and the manifest are kept and not reported as changed", async () => {
  write(`${JAVA_L1}/A.java`, "class A {}\n");
  write(`${JAVA_L1}/seed.txt`, "mine\n");
  write(`${JAVA_L1}/${MANIFEST}`, "# manifest\nA.java\nseed.txt\n");

  const res = await toolFor(project, { resolveJava: fake("manifest", MANIFEST_GENERATOR) }).handler({
    target: "java",
  });

  const out = payload(res);
  assert.deepEqual(out.files.changed, []);
  assert.deepEqual(out.files.added, []);
  assert.deepEqual(out.files.unchanged.sort(), [MANIFEST, "A.java", "seed.txt"].sort());
  assert.deepEqual(out.files.removed, []);
});

test("a TypeScript run starts from the project's L1 tree: a seed file and the manifest are kept and not reported as changed", async () => {
  write(`${TS_L1}/A.java`, "class A {}\n");
  write(`${TS_L1}/seed.txt`, "mine\n");
  write(`${TS_L1}/${MANIFEST}`, "# manifest\nA.java\nseed.txt\n");
  const before = hashTree(project);

  const res = await toolFor(project, { resolveTypeScript: fake("ts", MANIFEST_GENERATOR, "typescript") }).handler({
    target: "ts",
  });

  const out = payload(res);
  assert.equal(out.generator.kind, "typescript");
  assert.deepEqual(out.files.changed, []);
  assert.deepEqual(out.files.added, []);
  assert.deepEqual(out.files.unchanged.sort(), [MANIFEST, "A.java", "seed.txt"].sort());
  assert.equal(hashTree(project), before);
  assert.deepEqual(workdirsLeft(), []);
});

test("a TypeScript run into an empty project reports every produced file as added", async () => {
  const res = await toolFor(project, { resolveTypeScript: fake("ts", MANIFEST_GENERATOR, "typescript") }).handler({
    target: "ts",
  });
  const out = payload(res);
  assert.deepEqual(out.files.added.map((f: { path: string }) => f.path).sort(), [MANIFEST, "A.java", "seed.txt"].sort());
  assert.match(out.files.added[0].diff, /^--- \/dev\/null/m);
});

test("seeding skips a symlink in the L1 tree and never follows it out of L1", async () => {
  const outside = join(scratch, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  write(`${JAVA_L1}/A.java`, "class A {}\n");
  symlinkSync(join(outside, "secret.txt"), join(project, JAVA_L1, "link.txt"));
  symlinkSync(outside, join(project, JAVA_L1, "linkdir"));
  const lister = `
import { readdirSync } from "node:fs";
console.log(JSON.stringify(readdirSync(process.argv[3], { recursive: true })));
`;
  const res = await toolFor(project, { resolveJava: fake("lister", lister) }).handler({ target: "java" });
  const listed = JSON.parse(payload(res).stdout.trim()) as string[];
  assert.deepEqual(listed.sort(), ["A.java"]);
});

test("a L1 tree beyond the size cap is a files limit and nothing is run", async () => {
  write(`${JAVA_L1}/big.txt`, "x".repeat(100));
  const res = await toolFor(project, {
    resolveJava: fake("never", `process.exit(0);`),
    maxFilesBytes: 50,
  }).handler({ target: "java" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.equal(out.error, "limit_exceeded");
  assert.equal(out.limit.name, "files");
  assert.equal(out.limit.value, 50);
  assert.deepEqual(workdirsLeft(), []);
});

test("a Java resolution miss returns the structured reason and remedy", async () => {
  const res = await toolFor(project, {
    resolveJava: () => ({ state: "unavailable", reason: "no jar", remedy: "install the jar" }),
  }).handler({ target: "java" });
  assert.equal(res.isError, true);
  assert.deepEqual(payload(res), {
    error: "generator_unavailable",
    target: "java",
    reason: "no jar",
    remedy: "install the jar",
  });
  assert.deepEqual(workdirsLeft(), []);
});

test("a TypeScript resolution miss returns the structured reason and remedy", async () => {
  const res = await toolFor(project, {
    resolveTypeScript: () => ({ state: "unavailable", reason: "no gen", remedy: "npm install" }),
  }).handler({ target: "ts" });
  assert.equal(res.isError, true);
  assert.equal(payload(res).error, "generator_unavailable");
  assert.equal(payload(res).remedy, "npm install");
});

test("a missing metadata directory names the build as the remedy", async () => {
  rmSync(join(project, "target"), { recursive: true });
  const res = await toolFor(project, { resolveJava: fake("ok", `process.exit(0);`) }).handler({ target: "java" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.equal(out.error, "metadata_missing");
  assert.match(out.remedy, /mvn compile/);
  assert.deepEqual(workdirsLeft(), []);
});

test("a metadataDir that is not a directory in the project is reported missing", async () => {
  const res = await toolFor(project, { resolveJava: fake("ok", `process.exit(0);`) }).handler({
    target: "java",
    metadataDir: "target/nope",
  });
  assert.equal(payload(res).error, "metadata_missing");
});

test("a metadataDir that escapes the project root is refused, existing or not", async () => {
  mkdirSync(join(scratch, "elsewhere"));
  const tool = toolFor(project, { resolveJava: fake("ok", `process.exit(0);`) });
  for (const metadataDir of ["../elsewhere", "../nonexistent", "target/../../elsewhere"]) {
    const res = await tool.handler({ target: "java", metadataDir });
    assert.equal(res.isError, true, metadataDir);
    assert.match(text(res), /sandbox escape/, metadataDir);
  }
  symlinkSync(join(scratch, "elsewhere"), join(project, "target", "link"));
  const viaLink = await tool.handler({ target: "java", metadataDir: "target/link" });
  assert.match(text(viaLink), /sandbox escape/);
  const absolute = await tool.handler({ target: "java", metadataDir: join(scratch, "elsewhere") });
  assert.equal(absolute.isError, true);
});

test("a custom metadataDir inside the project is passed to the generator", async () => {
  mkdirSync(join(project, "custom"));
  const echo = `console.log("meta=" + process.argv[2]);`;
  const res = await toolFor(project, { resolveJava: fake("echo", echo) }).handler({
    target: "java",
    metadataDir: "custom",
  });
  assert.match(payload(res).stdout, /meta=<project>\/custom|meta=.*\/custom/);
});

test("exit 1 is a result, with the EXT- identifier decoded and the project and scratch paths scrubbed", async () => {
  const failing = `
console.error("[Exeris] EXT-PROC-1014: stream handler refused " + process.argv[2] + " " + process.argv[3]);
process.exit(1);
`;
  const res = await toolFor(project, { resolveJava: fake("fail", failing) }).handler({ target: "java" });
  assert.equal(res.isError, undefined);
  const out = payload(res);
  assert.equal(out.exitCode, 1);
  assert.equal(out.outcome, "refused_or_failed");
  assert.equal(out.files, null);
  assert.equal(out.diagnostics.matches[0].extId, "EXT-PROC-1014");
  assert.equal(out.diagnostics.matches[0].matchedBy, "identifier");
  assert.doesNotMatch(out.stderr, new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out.stderr, /<project>/);
  assert.match(out.stderr, /<preview>/);
  assert.deepEqual(workdirsLeft(), []);
});

test("an identifier without a catalogue entry is named, not dropped", async () => {
  const res = await toolFor(project, {
    resolveJava: fake("gap", `console.error("[Exeris] EXT-ZZZ-9999: something new"); process.exit(1);`),
  }).handler({ target: "java" });
  assert.deepEqual(payload(res).diagnostics.unrecognisedIds, ["EXT-ZZZ-9999"]);
});

test("exit 2 is reported as invalid arguments", async () => {
  const res = await toolFor(project, { resolveJava: fake("usage", `process.exit(2);`) }).handler({ target: "java" });
  assert.equal(res.isError, undefined);
  assert.equal(payload(res).outcome, "invalid_arguments");
});

test("a timeout is an error naming the limit and its value, and the scratch directory is gone", async () => {
  const res = await toolFor(project, {
    resolveJava: fake("hang", `setInterval(() => {}, 1000);`),
    timeoutMs: 300,
    graceMs: 100,
  }).handler({ target: "java" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.equal(out.error, "limit_exceeded");
  assert.deepEqual(out.limit, { name: "timeout", value: 300, unit: "ms" });
  assert.match(out.message, /300 ms/);
  assert.deepEqual(workdirsLeft(), []);
});

test("output over the cap is an error naming the limit and its value", async () => {
  const res = await toolFor(project, {
    resolveJava: fake("noisy", `process.stdout.write("x".repeat(5000)); setInterval(() => {}, 1000);`),
    maxOutputBytes: 1000,
    graceMs: 100,
  }).handler({ target: "java" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.deepEqual(out.limit, { name: "output", value: 1000, unit: "bytes" });
  assert.equal(out.stdout.length, 1000);
  assert.deepEqual(workdirsLeft(), []);
});

test("produced files over the size cap are a files limit", async () => {
  const res = await toolFor(project, {
    resolveJava: fake("big", `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[3] + "/big.txt", "x".repeat(500));`),
    maxFilesBytes: 100,
  }).handler({ target: "java" });
  assert.equal(res.isError, true);
  assert.deepEqual(payload(res).limit, { name: "files", value: 100, unit: "bytes" });
  assert.deepEqual(workdirsLeft(), []);
});

test("a generator that cannot start is a structured error", async () => {
  const unlaunchable = (): GeneratorResolution => ({
    state: "available",
    kind: "java",
    version: "0.10.0",
    source: "m2",
    path: "fake/generator",
    launch: (_m, workdir) => ({
      command: join(scratch, "no-such-binary"),
      args: [],
      cwd: workdir,
      env: generatorEnv(process.env, workdir),
      outputDir: join(workdir, "out"),
    }),
  });
  const res = await toolFor(project, { resolveJava: unlaunchable }).handler({ target: "java" });
  assert.equal(res.isError, true);
  assert.equal(payload(res).error, "generator_not_started");
  assert.deepEqual(workdirsLeft(), []);
});

test("target is required and checked", async () => {
  const tool = toolFor(project);
  for (const args of [{}, { target: "rust" }, { target: 3 }]) {
    const res = await tool.handler(args);
    assert.equal(res.isError, true);
    assert.match(text(res), /'target'/);
  }
  const bad = await tool.handler({ target: "java", metadataDir: "" });
  assert.match(text(bad), /'metadataDir'/);
});

test("the tool is unavailable without a project root", async () => {
  const res = await toolFor(null).handler({ target: "java" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.equal(out.error, "family_unavailable");
  assert.equal(out.family, "build");
  assert.equal(existsSync(join(tmpRoot, "x")), false);
});
