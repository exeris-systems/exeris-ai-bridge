import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { getServerVersion } from "./version.js";

test("getServerVersion returns the package.json version verbatim", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

  assert.equal(getServerVersion(), pkg.version);
});

test("getServerVersion returns a non-empty string", () => {
  const version = getServerVersion();
  assert.equal(typeof version, "string");
  assert.ok(version.length > 0);
});

test("getServerVersion returns a semver-shaped string", () => {
  // Permissive shape: major.minor.patch[-prerelease][+build]
  assert.match(getServerVersion(), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/);
});
