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

test("getServerVersion returns a canonical-semver-shaped string", () => {
  // Canonical regex from https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
  // Rejects leading zeros (01.02.03) and multiple build-meta segments (1.2.3-a+b+c).
  const SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
  assert.match(getServerVersion(), SEMVER);
});
