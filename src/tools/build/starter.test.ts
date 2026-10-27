import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fixtureAppStarter, writeAppStarterBundle } from "../../data/__tests__/app-starter-fixture.js";
import { loadAppStarter } from "../../data/app-starter.js";
import type { BundleState } from "../../data/bundle.js";
import { getStarterTool } from "./starter.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exeris-getstarter-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function call(bundle: BundleState, args: Record<string, unknown>) {
  return getStarterTool(loadAppStarter(bundle, dir)).handler(args);
}

function payload(res: CallToolResult) {
  return JSON.parse((res.content[0] as { text: string }).text);
}

const hasName = (pattern: RegExp) => (s: { name: string }) => pattern.test(s.name);

test("backend returns a pom.xml on exeris-app-parent that depends on exeris-app-starter", async () => {
  const res = await call(writeAppStarterBundle(dir), { variant: "backend" });
  assert.ok(!res.isError);
  const out = payload(res);
  assert.equal(out.variant, "backend");
  assert.equal(out.bomVersion, "0.10.0");
  assert.deepEqual(out.triple, { tooling: "0.10.0", kernel: "0.12.0", sdk: "0.12.0" });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].path, "pom.xml");
  const pom: string = out.files[0].content;
  assert.match(
    pom,
    /<parent>\s*<groupId>eu\.exeris<\/groupId>\s*<artifactId>exeris-app-parent<\/artifactId>\s*<version>0\.10\.0<\/version>/,
  );
  assert.match(pom, /<artifactId>exeris-app-starter<\/artifactId>\s*<type>pom<\/type>/);
  // The tooling version is stated once, in <parent>; the starter dependency carries none.
  assert.equal(pom.match(/0\.10\.0/g)?.length, 1);
  // The consumer blanks the publication metadata it would otherwise inherit.
  assert.match(pom, /<url\/>\s*<licenses>\s*<license\/>/);
  assert.ok(out.supplied.some(hasName(/JDBC/)));
});

test("frontend returns a package.json with @exeris/codegen-ts and its exeris-gen command", async () => {
  const res = await call(writeAppStarterBundle(dir), { variant: "frontend" });
  assert.ok(!res.isError);
  const out = payload(res);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].path, "package.json");
  const manifest = JSON.parse(out.files[0].content);
  assert.equal(manifest.devDependencies["@exeris/codegen-ts"], "0.10.0");
  assert.match(
    manifest.scripts.generate,
    /^exeris-gen generate --input \.\.\/backend\/target\/classes\/exeris-metadata /,
  );
  assert.ok(!out.supplied.some(hasName(/JDBC/)));
  assert.ok(out.supplied.some(hasName(/DomainMetadata/)));
});

test("both returns the two, with the backend beside the frontend that generates from it", async () => {
  const res = await call(writeAppStarterBundle(dir), { variant: "both" });
  assert.ok(!res.isError);
  const out = payload(res);
  assert.deepEqual(
    out.files.map((f: { path: string }) => f.path),
    ["backend/pom.xml", "frontend/package.json"],
  );
  assert.ok(out.supplied.some(hasName(/JDBC/)));
  assert.ok(!out.supplied.some(hasName(/DomainMetadata/)));
});

test("every version comes from the vendored entry", async () => {
  const other = { tooling: "7.8.9", kernel: "4.5.6", sdk: "1.2.3" };
  const res = await call(writeAppStarterBundle(dir, JSON.stringify(fixtureAppStarter(other))), { variant: "both" });
  const out = payload(res);
  assert.equal(out.bomVersion, "7.8.9");
  assert.deepEqual(out.triple, other);
  const [pom, pkg] = out.files.map((f: { content: string }) => f.content);
  assert.match(pom, /<version>7\.8\.9<\/version>/);
  assert.doesNotMatch(pom, /0\.10\.0/);
  assert.equal(JSON.parse(pkg).devDependencies["@exeris/codegen-ts"], "7.8.9");
  assert.doesNotMatch(pkg, /0\.10\.0/);
});

test("an unknown or missing variant is an error naming the choices", async () => {
  for (const args of [{}, { variant: "mobile" }, { variant: 3 }]) {
    const res = await call(writeAppStarterBundle(dir), args);
    assert.equal(res.isError, true);
    assert.match((res.content[0] as { text: string }).text, /backend, frontend, both/);
  }
});

test("no bundle is a structured unavailable, not a failure", async () => {
  const absent = {
    state: "unavailable" as const,
    reason: "No bundled reference data is present.",
    remedy: "Install the published package.",
  };
  const res = await call(absent, { variant: "backend" });
  assert.equal(res.isError, true);
  const out = payload(res);
  assert.equal(out.error, "family_unavailable");
  assert.equal(out.family, "build");
  assert.equal(out.reason, absent.reason);
  assert.equal(out.remedy, absent.remedy);
});
