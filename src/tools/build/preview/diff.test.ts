import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  JAVA_L1_ROOT,
  MAX_LISTED_ENTRIES,
  MAX_LIST_DEPTH,
  TYPESCRIPT_L1_ROOT,
  collectProduced,
  diffAgainstL1,
  javaL1Root,
  typescriptL1Root,
} from "./diff.js";
import { OUTPUT_SUBDIR, createOutputDir } from "./workdir.js";

let work: string;
let project: string;
let produced: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-diff-"));
  project = join(work, "project");
  produced = join(work, "produced");
  mkdirSync(project);
  mkdirSync(produced);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function put(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("added, changed, unchanged and removed files are told apart", () => {
  const l1 = javaL1Root(project);
  put(l1, "p/Same.java", "class Same {}\n");
  put(l1, "p/Edit.java", "class Edit {\n  int a;\n}\n");
  put(l1, "p/Gone.java", "class Gone {}\n");
  put(produced, "p/Same.java", "class Same {}\n");
  put(produced, "p/Edit.java", "class Edit {\n  int a;\n  int b;\n}\n");
  put(produced, "p/New.java", "class New {}\n");

  const { files, limit } = collectProduced(produced);
  assert.equal(limit, null);
  const report = diffAgainstL1(files, project, l1);

  assert.deepEqual(
    report.files.map((f) => [f.path, f.status]),
    [
      ["p/Edit.java", "changed"],
      ["p/New.java", "added"],
      ["p/Same.java", "unchanged"],
    ],
  );
  assert.deepEqual(report.removed, ["p/Gone.java"]);

  const changed = report.files[0].diff;
  assert.match(changed, /^--- a\/p\/Edit\.java/m);
  assert.match(changed, /^\+\+\+ b\/p\/Edit\.java/m);
  assert.match(changed, /^\+ {2}int b;$/m);

  const added = report.files[1].diff;
  assert.match(added, /^--- \/dev\/null/m);
  assert.match(added, /^\+class New \{\}$/m);

  assert.equal(report.files[2].diff, "");
});

test("a project without an L1 tree reports every produced file as added", () => {
  put(produced, "p/A.java", "class A {}\n");
  const report = diffAgainstL1(collectProduced(produced).files, project, javaL1Root(project));
  assert.deepEqual(report.files.map((f) => f.status), ["added"]);
  assert.deepEqual(report.removed, []);
});

test("an L1 root that is a link out of the project reads as empty", () => {
  const outside = join(work, "outside");
  put(outside, "p/Secret.java", "secret\n");
  const l1 = javaL1Root(project);
  mkdirSync(dirname(l1), { recursive: true });
  symlinkSync(outside, l1);
  put(produced, "p/Secret.java", "class A {}\n");
  const report = diffAgainstL1(collectProduced(produced).files, project, l1);
  assert.deepEqual(report.files.map((f) => f.status), ["added"]);
  assert.deepEqual(report.removed, []);
});

test("a symlink the generator placed in its output is not followed", () => {
  const secret = join(work, "secret.txt");
  writeFileSync(secret, "do not read");
  put(produced, "p/A.java", "class A {}\n");
  symlinkSync(secret, join(produced, "p", "link.txt"));
  assert.deepEqual([...collectProduced(produced).files.keys()], ["p/A.java"]);
});

test("produced files over the size cap are refused before they are read", () => {
  put(produced, "big.txt", "x".repeat(50));
  const result = collectProduced(produced, 10);
  assert.equal(result.limit?.name, "files");
  assert.equal(result.limit?.value, 10);
  assert.equal(result.files.size, 0);
  assert.equal(result.totalBytes, 50);
});

test("committed files to be compared over the size cap are a files limit and nothing is reported", () => {
  const l1 = javaL1Root(project);
  put(l1, "p/A.java", "x".repeat(50));
  put(l1, "Other.java", "y".repeat(500));
  put(produced, "p/A.java", "x");
  const files = collectProduced(produced).files;
  const report = diffAgainstL1(files, project, l1, 10);
  assert.equal(report.limit?.name, "files");
  assert.equal(report.limit?.value, 10);
  assert.equal(report.limit?.unit, "bytes");
  assert.deepEqual(report.files, []);
  assert.deepEqual(report.removed, []);
});

test("committed files the run does not produce do not count against the size cap", () => {
  const l1 = javaL1Root(project);
  put(l1, "p/A.java", "x".repeat(5));
  put(l1, "Other.java", "y".repeat(500));
  put(produced, "p/A.java", "x");
  const report = diffAgainstL1(collectProduced(produced).files, project, l1, 10);
  assert.equal(report.limit, null);
  assert.equal(report.files[0].status, "changed");
  assert.deepEqual(report.removed, ["Other.java"]);
});

test("the L1 roots are the Java tree and the TypeScript output path", () => {
  assert.equal(javaL1Root(project), join(project, JAVA_L1_ROOT));
  assert.equal(JAVA_L1_ROOT, join("src", "main", "generated", "java"));
  assert.equal(typescriptL1Root(project), join(project, TYPESCRIPT_L1_ROOT));
  assert.equal(TYPESCRIPT_L1_ROOT, join("src", "app", "generated"));
});

test("typescriptL1Root honours outputPath from exeris-codegen.json when it is inside the project", () => {
  mkdirSync(join(project, "web", "gen"), { recursive: true });
  writeFileSync(join(project, "exeris-codegen.json"), JSON.stringify({ outputPath: "web/gen" }));
  assert.equal(typescriptL1Root(project), join(project, "web", "gen"));
});

test("typescriptL1Root ignores an outputPath that leaves the project", () => {
  writeFileSync(join(project, "exeris-codegen.json"), JSON.stringify({ outputPath: "../elsewhere" }));
  assert.equal(typescriptL1Root(project), join(project, TYPESCRIPT_L1_ROOT));
});

test("typescriptL1Root reads the config file names in the generator's order", () => {
  writeFileSync(join(project, ".exerisrc.json"), JSON.stringify({ outputPath: "c" }));
  mkdirSync(join(project, "c"));
  assert.equal(typescriptL1Root(project), join(project, "c"));
  writeFileSync(join(project, "exeris-codegen.config.json"), JSON.stringify({ outputPath: "b" }));
  mkdirSync(join(project, "b"));
  assert.equal(typescriptL1Root(project), join(project, "b"));
  writeFileSync(join(project, "exeris-codegen.json"), JSON.stringify({ outputPath: "a" }));
  mkdirSync(join(project, "a"));
  assert.equal(typescriptL1Root(project), join(project, "a"));
});

test("typescriptL1Root walks up from a subdirectory but stops at the project root", () => {
  const sub = join(project, "frontend", "app");
  mkdirSync(sub, { recursive: true });
  mkdirSync(join(project, "gen"));
  writeFileSync(join(project, "exeris-codegen.json"), JSON.stringify({ outputPath: "gen" }));
  assert.equal(typescriptL1Root(project, sub), join(project, "gen"));

  // A config above the project root is not the project's.
  rmSync(join(project, "exeris-codegen.json"));
  writeFileSync(join(work, "exeris-codegen.json"), JSON.stringify({ outputPath: "gen" }));
  assert.equal(typescriptL1Root(project, sub), join(project, TYPESCRIPT_L1_ROOT));
});

test("a changed file whose diff exceeds the diff budget is reported changed, diff too large", () => {
  const lines = (prefix: string): string => Array.from({ length: 15_000 }, (_, i) => `${prefix}${i}`).join("\n");
  const l1 = javaL1Root(project);
  put(l1, "Big.java", lines("old"));
  put(produced, "Big.java", lines("new"));
  const report = diffAgainstL1(collectProduced(produced).files, project, l1);
  assert.equal(report.files[0].status, "changed");
  assert.equal(report.files[0].diff, "");
  assert.equal(report.files[0].diffOmitted, "too_large");
});

test("a tree with more files than the listing cap reports a files limit", () => {
  for (let i = 0; i <= MAX_LISTED_ENTRIES; i++) put(produced, `f${i}.txt`, "x");
  const result = collectProduced(produced);
  assert.equal(result.limit?.name, "files");
  assert.equal(result.limit?.value, MAX_LISTED_ENTRIES);
  assert.equal(result.files.size, 0);
});

test("a tree nested deeper than the depth cap reports a files limit", () => {
  const deep = Array.from({ length: MAX_LIST_DEPTH + 2 }, () => "d").join("/");
  put(produced, `${deep}/f.txt`, "x");
  const result = collectProduced(produced);
  assert.equal(result.limit?.name, "files");
  assert.equal(result.limit?.value, MAX_LIST_DEPTH);
});

test("paths are sorted with a locale-aware comparator, stable across runs", () => {
  put(produced, "b/B.java", "b\n");
  put(produced, "a/A.java", "a\n");
  put(produced, "a/B.java", "ab\n");
  const report = diffAgainstL1(collectProduced(produced).files, project, javaL1Root(project));
  assert.deepEqual(report.files.map((f) => f.path), ["a/A.java", "a/B.java", "b/B.java"]);
});

test("only the output subdirectory is listed: a crash log beside it is never a produced file", () => {
  const out = createOutputDir(produced);
  assert.equal(out, join(produced, OUTPUT_SUBDIR));
  put(out, "p/A.java", "class A {}\n");
  put(produced, "hs_err_pid42.log", "crash");
  assert.deepEqual([...collectProduced(out).files.keys()], ["p/A.java"]);
});
