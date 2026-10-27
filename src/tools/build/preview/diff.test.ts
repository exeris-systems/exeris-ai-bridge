import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  JAVA_L1_ROOT,
  TYPESCRIPT_L1_ROOT,
  collectProduced,
  diffAgainstL1,
  javaL1Root,
  typescriptL1Root,
} from "./diff.js";

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
