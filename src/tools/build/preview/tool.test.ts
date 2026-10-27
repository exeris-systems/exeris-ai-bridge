import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    pinSource: kind === "java" ? "app-parent" : "node-modules",
    path: "fake/generator",
    privatePaths: [],
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
  assert.deepEqual(out.files.changed.map((f: { path: string }) => f.path), ["A.java"]);
  assert.deepEqual(out.l1, { root: JAVA_L1, source: "default", seeded: true });
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
  assert.deepEqual(out.files.unchanged.sort(), ["A.java", "seed.txt"]);
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
  assert.deepEqual(out.files.unchanged.sort(), ["A.java", "seed.txt"]);
  assert.equal(hashTree(project), before);
  assert.deepEqual(workdirsLeft(), []);
});

test("a TypeScript run into an empty project reports every produced file as added", async () => {
  const res = await toolFor(project, { resolveTypeScript: fake("ts", MANIFEST_GENERATOR, "typescript") }).handler({
    target: "ts",
  });
  const out = payload(res);
  assert.deepEqual(out.files.added.map((f: { path: string }) => f.path).sort(), ["A.java", "seed.txt"]);
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
  assert.equal(payload(res).outcome, "generator_rejected_arguments");
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
  assert.match(out.reason, /300 ms/);
  assert.match(out.remedy, /exeris-gen generate/);
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
    pinSource: "app-parent",
    path: "fake/generator",
    privatePaths: [],
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
  const bad = await tool.handler({ target: "java", metadataDir: "custom" });
  assert.match(text(bad), /Only .target. is accepted/);
});

test("the tool is unavailable without a project root", async () => {
  const res = await toolFor(null).handler({ target: "java" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.equal(out.error, "family_unavailable");
  assert.equal(out.family, "build");
  assert.deepEqual(workdirsLeft(), []);
});

// ---------------------------------------------------------------------------
// Input handling, metadata validation and error shape.
// ---------------------------------------------------------------------------

const META_ABS = () => join(project, METADATA);

/** A resolver that fails the test if the generator is ever resolved. */
function neverResolved(): () => GeneratorResolution {
  return () => {
    throw new Error("the generator must not be resolved");
  };
}

test("metadata is checked before the generator is resolved, existence first and then content", async () => {
  const unavailable = (): GeneratorResolution => ({ state: "unavailable", reason: "no jar", remedy: "install" });
  const tool = toolFor(project, { resolveJava: unavailable });

  writeFileSync(join(META_ABS(), "Evil.json"), JSON.stringify({ entityName: "../../x" }));
  assert.equal(payload(await tool.handler({ target: "java" })).error, "metadata_invalid");

  rmSync(join(project, "target"), { recursive: true });
  assert.equal(payload(await tool.handler({ target: "java" })).error, "metadata_missing");
});

test("metadata whose names could leave the output directory is refused before any generator starts", async () => {
  const cases: Record<string, unknown> = {
    "traversing entityName": { entityName: "../../../../x", packageName: "com.example" },
    "separator in entityName": { entityName: "a/b" },
    "non-string entityName": { entityName: 3 },
    "slash in packageName": { entityName: "Ok", packageName: "com/example" },
    "dotted-segment packageName": { entityName: "Ok", packageName: "com..example" },
    "nested name key": { entityName: "Ok", sagas: [{ sagaName: "../up" }] },
    "nested module": { entityName: "Ok", module: "a/b" },
    "nested package key": { entityName: "Ok", views: [{ viewPackage: "x/y" }] },
    "control character": { entityName: "Ok", name: "a\u0000b" },
  };
  const tool = toolFor(project, { resolveJava: neverResolved() });
  for (const [label, body] of Object.entries(cases)) {
    writeFileSync(join(META_ABS(), "Case.json"), JSON.stringify(body));
    const res = await tool.handler({ target: "java" });
    assert.equal(res.isError, true, label);
    const out = payload(res);
    assert.equal(out.error, "metadata_invalid", label);
    assert.equal(out.target, "java");
    assert.equal(out.file, `${METADATA}/Case.json`, label);
    assert.ok(out.reason.length > 0 && out.remedy.length > 0, label);
  }
  assert.deepEqual(workdirsLeft(), []);
});

test("unparseable, non-object and linked metadata files are refused", async () => {
  const tool = toolFor(project, { resolveJava: neverResolved() });
  writeFileSync(join(META_ABS(), "Bad.json"), "{ not json");
  assert.match(payload(await tool.handler({ target: "java" })).reason, /not valid JSON/);
  writeFileSync(join(META_ABS(), "Bad.json"), "[]");
  assert.match(payload(await tool.handler({ target: "java" })).reason, /JSON object/);
  rmSync(join(META_ABS(), "Bad.json"));
  symlinkSync(join(META_ABS(), "Station.json"), join(META_ABS(), "Link.json"));
  assert.match(payload(await tool.handler({ target: "java" })).reason, /symbolic link/);
});

test("ordinary names, display names and nested directories pass validation", async () => {
  mkdirSync(join(META_ABS(), "nested"));
  writeFileSync(
    join(META_ABS(), "nested", "Order.json"),
    JSON.stringify({
      entityName: "Order",
      packageName: "com.example.orders.domain",
      displayName: "Purchase Order",
      module: "orders",
      name: "Purchase Order",
      fields: [{ name: "id", type: "java.util.UUID" }],
    }),
  );
  const res = await toolFor(project, { resolveJava: fake("ok", `process.exit(0);`) }).handler({ target: "java" });
  assert.equal(res.isError, undefined, text(res));
});

test("the metadata directory is fixed: a metadataDir argument is refused, a link out of the project is refused", async () => {
  const tool = toolFor(project, { resolveJava: neverResolved() });
  const arg = await tool.handler({ target: "java", metadataDir: "../elsewhere" });
  assert.equal(payload(arg).error, "invalid_input");
  assert.match(payload(arg).reason, /Only 'target' is accepted/);
  assert.equal(
    (tool.definition.inputSchema as { properties: Record<string, unknown> }).properties.metadataDir,
    undefined,
  );

  mkdirSync(join(scratch, "elsewhere"));
  rmSync(join(project, "target"), { recursive: true });
  mkdirSync(join(project, "target", "classes"), { recursive: true });
  symlinkSync(join(scratch, "elsewhere"), join(project, METADATA));
  const escaped = payload(await tool.handler({ target: "java" }));
  assert.equal(escaped.error, "metadata_escape");
  assert.equal(JSON.stringify(escaped).includes(scratch), false);
});

test("every error is {error, target, reason, remedy}", async () => {
  const tool = toolFor(project, { resolveJava: fake("ok", `process.exit(0);`) });
  const results = [
    await tool.handler({}),
    await tool.handler({ target: "java", extra: 1 }),
  ];
  for (const res of results) {
    const out = payload(res);
    for (const key of ["error", "target", "reason", "remedy"]) assert.ok(key in out, `${key} in ${text(res)}`);
  }
  const killed = await toolFor(project, {
    resolveJava: fake("selfkill", `process.kill(process.pid, "SIGKILL"); setInterval(() => {}, 1000);`),
  }).handler({ target: "java" });
  const out = payload(killed);
  assert.equal(out.error, "generator_killed");
  assert.ok(out.reason && out.remedy);
});

test("an unreadable file in L1 is a structured, path-free preview_failed", { skip: process.getuid?.() === 0 }, async () => {
  write(`${JAVA_L1}/A.java`, "class A {}\n");
  const locked = join(project, JAVA_L1, "A.java");
  chmodSync(locked, 0o000);
  try {
    const res = await toolFor(project, { resolveJava: fake("ok", `process.exit(0);`) }).handler({ target: "java" });
    assert.equal(res.isError, true);
    const out = payload(res);
    assert.equal(out.error, "preview_failed");
    assert.equal(out.code, "EACCES");
    assert.equal(out.target, "java");
    assert.ok(out.remedy.length > 0);
    for (const secret of [scratch, tmpRoot, project]) assert.equal(text(res).includes(secret), false, secret);
    assert.deepEqual(workdirsLeft(), []);
  } finally {
    chmodSync(locked, 0o644);
  }
});

test("an unreadable metadata parent is not reported as missing", { skip: process.getuid?.() === 0 }, async () => {
  const classes = join(project, "target", "classes");
  chmodSync(classes, 0o000);
  try {
    const out = payload(await toolFor(project, { resolveJava: neverResolved() }).handler({ target: "java" }));
    assert.equal(out.error, "metadata_unreadable");
    assert.equal(out.code, "EACCES");
  } finally {
    chmodSync(classes, 0o755);
  }
});

test("paths of the generator's runtime, the project and the scratch directory are scrubbed, including as file URLs", async () => {
  const noisy = `
import { pathToFileURL } from "node:url";
console.log("exec=" + process.execPath);
console.log("meta=" + process.argv[2] + " url=" + pathToFileURL(process.argv[2]).href);
console.error("home=" + (process.env.HOME || "") + "/x");
`;
  const res = await toolFor(project, { resolveJava: fake("noisy", noisy) }).handler({ target: "java" });
  const out = payload(res);
  assert.doesNotMatch(out.stdout, /\/tmp\/|file:\/\/\/tmp/);
  assert.match(out.stdout, /exec=<node>\//);
  assert.match(out.stdout, /meta=<project>\//);
  assert.match(out.stdout, /url=<project>\//);
});

// ---------------------------------------------------------------------------
// The TypeScript launch as production does it: a package in node_modules, its
// config in the project root, Node's permission model around the child.
// ---------------------------------------------------------------------------

function installFakeCodegenTs(binSource: string): void {
  const dir = join(project, "node_modules", "@exeris", "codegen-ts");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@exeris/codegen-ts", version: "0.10.0", bin: { "exeris-gen": "./dist/index.js" } }),
  );
  writeFileSync(join(dir, "dist", "index.js"), binSource);
}

const HOSTILE_TS_BIN = `
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--output") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "ok.ts"), "export {};\\n");
const attempts = {};
for (const [name, target] of [
  ["cwd", path.join(process.cwd(), "pwned.txt")],
  ["traversal", path.join(out, "..", "..", "escape.txt")],
]) {
  try {
    fs.writeFileSync(target, "x");
    attempts[name] = "written";
  } catch (err) {
    attempts[name] = err.code;
  }
}
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), attempts }));
`;

test("the TypeScript generator is launched from node_modules in the project root, writes only under the scratch directory, and is denied everywhere else", async () => {
  installFakeCodegenTs(HOSTILE_TS_BIN);
  write("exeris-codegen.json", JSON.stringify({ outputPath: "gen/out" }));
  const before = hashTree(project);

  const res = await toolFor(project).handler({ target: "ts" });

  assert.equal(res.isError, undefined, text(res));
  const out = payload(res);
  assert.equal(out.generator.kind, "typescript");
  assert.equal(out.generator.source, "node_modules");
  assert.equal(out.generator.path, "node_modules/@exeris/codegen-ts/dist/index.js");
  assert.deepEqual(out.l1, { root: "gen/out", source: "config", seeded: false });
  const seen = JSON.parse(out.stdout.trim());
  assert.equal(seen.cwd, "<project>");
  assert.deepEqual(seen.argv, [
    "generate",
    "--input",
    `<project>/${METADATA}`,
    "--output",
    "<preview>/out",
  ]);
  assert.deepEqual(seen.attempts, { cwd: "ERR_ACCESS_DENIED", traversal: "ERR_ACCESS_DENIED" });
  assert.deepEqual(out.files.added.map((f: { path: string }) => f.path), ["ok.ts"]);
  assert.equal(hashTree(project), before);
  assert.deepEqual(workdirsLeft(), []);
});

test("a codegen config the generator would read above the project root is refused", async () => {
  writeFileSync(join(scratch, "exeris-codegen.json"), "{}");
  const res = await toolFor(project, { resolveTypeScript: fake("ok", `process.exit(0);`, "typescript") }).handler({ target: "ts" });
  assert.equal(payload(res).error, "ts_config_outside_project");
  assert.doesNotMatch(text(res), new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a codegen config with dryRun, or an outputPath outside the project, is refused", async () => {
  const tool = toolFor(project, { resolveTypeScript: fake("ok", `process.exit(0);`, "typescript") });

  write("exeris-codegen.json", JSON.stringify({ dryRun: true }));
  assert.equal(payload(await tool.handler({ target: "ts" })).error, "ts_config_dry_run");

  write("exeris-codegen.json", JSON.stringify({ outputPath: "../out" }));
  assert.equal(payload(await tool.handler({ target: "ts" })).error, "ts_output_outside_project");

  mkdirSync(join(scratch, "elsewhere"));
  symlinkSync(join(scratch, "elsewhere"), join(project, "linked"));
  write("exeris-codegen.json", JSON.stringify({ outputPath: "linked" }));
  assert.equal(payload(await tool.handler({ target: "ts" })).error, "ts_output_outside_project");

  write("exeris-codegen.json", JSON.stringify({ outputPath: "src/gen" }));
  const ok = payload(await tool.handler({ target: "ts" }));
  assert.deepEqual(ok.l1, { root: "src/gen", source: "config", seeded: false });
});

test("the preview reports the pinned generator's release against the catalogue that decodes its diagnostics", async () => {
  const aligned = payload(
    await toolFor(project, { resolveJava: fake("manifest", MANIFEST_GENERATOR) }).handler({ target: "java" }),
  );
  assert.deepEqual(aligned.toolingSkew, {
    status: "aligned",
    bundledToolingVersion: "0.10.0",
    projectToolingVersion: "0.10.0",
    source: "app-parent",
  });

  const older = fake("manifest-older", MANIFEST_GENERATOR);
  const skewed = payload(
    await toolFor(project, {
      resolveJava: () => ({ ...(older() as object), version: "0.9.1" }) as GeneratorResolution,
    }).handler({ target: "java" }),
  );
  assert.equal(skewed.toolingSkew.status, "skew_detected");
  assert.equal(skewed.toolingSkew.projectToolingVersion, "0.9.1");
});

test("a TypeScript preview names the installed package as the pin's source", async () => {
  const out = payload(
    await toolFor(project, { resolveTypeScript: fake("manifest-ts", MANIFEST_GENERATOR, "typescript") }).handler({
      target: "ts",
    }),
  );
  assert.equal(out.toolingSkew.source, "node-modules");
  assert.equal(out.toolingSkew.status, "aligned");
});
