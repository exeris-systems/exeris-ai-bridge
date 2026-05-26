import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, test } from "node:test";

import { resolveInside, SandboxEscapeError } from "./sandbox.js";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "exeris-sbx-"));
  root = join(base, "inside");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("resolveInside accepts a relative file that exists under root", () => {
  const file = join(root, "ok.txt");
  writeFileSync(file, "x");
  assert.equal(resolveInside(root, "ok.txt"), file);
});

test("resolveInside accepts a nested relative file", () => {
  mkdirSync(join(root, "a", "b"), { recursive: true });
  const file = join(root, "a", "b", "deep.txt");
  writeFileSync(file, "x");
  assert.equal(resolveInside(root, join("a", "b", "deep.txt")), file);
});

test("resolveInside accepts root itself (empty/dot candidate)", () => {
  assert.equal(resolveInside(root, "."), root);
});

test("resolveInside accepts an absolute path that lies inside root", () => {
  const file = join(root, "abs.txt");
  writeFileSync(file, "x");
  assert.equal(resolveInside(root, file), file);
});

test("resolveInside rejects ../ traversal even if the target exists", () => {
  const target = join(outside, "escape.txt");
  writeFileSync(target, "x");
  assert.throws(
    () => resolveInside(root, join("..", "outside", "escape.txt")),
    SandboxEscapeError,
  );
});

test("resolveInside rejects an absolute path outside root", () => {
  const target = join(outside, "abs.txt");
  writeFileSync(target, "x");
  assert.throws(() => resolveInside(root, target), SandboxEscapeError);
});

test("resolveInside rejects a missing file (treated as out-of-sandbox)", () => {
  assert.throws(
    () => resolveInside(root, "no-such-file.txt"),
    SandboxEscapeError,
  );
});

test("resolveInside follows a symlink that points to a target inside root", () => {
  const target = join(root, "real.txt");
  writeFileSync(target, "x");
  const link = join(root, "link.txt");
  try {
    symlinkSync(target, link);
  } catch {
    return;
  }
  assert.equal(resolveInside(root, "link.txt"), target);
});

test("resolveInside rejects a symlink whose target lies outside root", () => {
  const target = join(outside, "secret.txt");
  writeFileSync(target, "x");
  const link = join(root, "escape-link.txt");
  try {
    symlinkSync(target, link);
  } catch {
    return;
  }
  assert.throws(
    () => resolveInside(root, "escape-link.txt"),
    SandboxEscapeError,
  );
});

test("SandboxEscapeError carries root, candidate, and resolved fields", () => {
  try {
    resolveInside(root, join("..", "outside"));
    assert.fail("expected SandboxEscapeError");
  } catch (err) {
    assert.ok(err instanceof SandboxEscapeError);
    assert.equal(err.candidate, join("..", "outside"));
    assert.ok(typeof err.root === "string" && err.root.length > 0);
  }
});

test("SandboxEscapeError for a missing file has resolved=null", () => {
  try {
    resolveInside(root, "missing.txt");
    assert.fail("expected SandboxEscapeError");
  } catch (err) {
    assert.ok(err instanceof SandboxEscapeError);
    assert.equal(err.resolved, null);
  }
});
