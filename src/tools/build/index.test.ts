import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "../../config/env.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerBuildTools } from "./index.js";

const METADATA_REL = "target/classes/exeris-metadata";

const STATION = {
  schemaVersion: "0.11.0",
  sourceDigest: "sha256:abcdef",
  entityName: "Station",
  packageName: "com.example.fleet",
  restApi: true,
  fields: [{ name: "backupStation", type: "java.lang.String" }],
};

const roots: string[] = [];

/** A project whose last build emitted the given metadata files. */
function projectWith(files: Record<string, string> | null): string {
  const root = mkdtempSync(join(tmpdir(), "exeris-build-"));
  roots.push(root);
  if (files !== null) {
    const dir = join(root, METADATA_REL);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  }
  return root;
}

process.on("exit", () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function configFor(root: string | null): BridgeConfig {
  const na = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };
  return {
    mode: "app",
    modeSource: "probe",
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

function toolsFor(root: string | null) {
  return new Map(registerBuildTools(configFor(root)).map((t) => [t.definition.name, t]));
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

const BUILT = {
  "Station.json": JSON.stringify(STATION),
  "Depot.json": JSON.stringify({ ...STATION, entityName: "Depot" }),
  "enum_Status.json": JSON.stringify({ ...STATION, entityName: "Status" }),
  "view_Dashboard.json": JSON.stringify({ ...STATION, entityName: "Dashboard" }),
  "README.md": "not metadata",
};

test("registerBuildTools registers exactly the two build-* tools", () => {
  const names = registerBuildTools(configFor(null))
    .map((t) => t.definition.name)
    .sort();
  assert.deepEqual(names, ["build-get_domain_metadata", "build-list_domains"]);
});

test("build-list_domains classifies every emitted file by kind and skips non-JSON", async () => {
  const res = await toolsFor(projectWith(BUILT)).get("build-list_domains")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.present, true);
  assert.deepEqual(payload.counts, { domain: 2, enum: 1, capability: 0, view: 1 });
  assert.equal(payload.entries.some((e: { name: string }) => e.name === "README"), false);
});

// "Not built yet" has an obvious next step, so it is state rather than failure.
// An agent that reads it as a broken server stops asking.
test("a project that has not been built answers present:false, not an error", async () => {
  const res = await toolsFor(projectWith(null)).get("build-list_domains")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.present, false);
  assert.match(payload.remedy, /mvn compile/);
});

test("build-get_domain_metadata returns the record verbatim under its envelope", async () => {
  const tools = toolsFor(projectWith(BUILT));
  const res = await tools.get("build-get_domain_metadata")!.handler({ name: "Station" });
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.name, "Station");
  assert.equal(payload.kind, "domain");
  assert.equal(payload.schemaVersion, "0.11.0");
  assert.equal(payload.sourceDigest, "sha256:abcdef");
  assert.deepEqual(payload.metadata, STATION);
});

test("kind selects the prefixed file", async () => {
  const tools = toolsFor(projectWith(BUILT));
  const res = await tools.get("build-get_domain_metadata")!.handler({ name: "Status", kind: "enum" });
  assert.ok(!res.isError, text(res));
  assert.equal(JSON.parse(text(res)).name, "Status");
});

// A miss should hand back what IS there — the agent has no other way to learn
// the names, since lsp-list_domains needs a platform LSP P2 does not have.
test("an unknown name reports the names that do exist", async () => {
  const tools = toolsFor(projectWith(BUILT));
  const res = await tools.get("build-get_domain_metadata")!.handler({ name: "Missing" });
  assert.equal(res.isError, true);
  assert.match(text(res), /Known domain names: Depot, Station\./);
  assert.match(text(res), /build-list_domains/);
});

test("a path-shaped name is refused with a sentence about names", async () => {
  const tools = toolsFor(projectWith(BUILT));
  for (const bad of ["../../../etc/passwd", "com.example.Station", "Station.json"]) {
    const res = await tools.get("build-get_domain_metadata")!.handler({ name: bad });
    assert.equal(res.isError, true, bad);
    assert.match(text(res), /is not a Java simple name/, bad);
  }
});

test("an unknown kind is refused, naming the accepted values", async () => {
  const tools = toolsFor(projectWith(BUILT));
  const res = await tools.get("build-get_domain_metadata")!.handler({ name: "Station", kind: "saga" });
  assert.equal(res.isError, true);
  assert.match(text(res), /'kind' must be one of: domain, enum, capability, view\./);
});

test("a metadata file that is not valid JSON says so", async () => {
  const tools = toolsFor(projectWith({ "Station.json": "{ nope" }));
  const res = await tools.get("build-get_domain_metadata")!.handler({ name: "Station" });
  assert.equal(res.isError, true);
  assert.match(text(res), /is not valid JSON/);
});

test("a JSON file that no processor wrote is rejected as such", async () => {
  const tools = toolsFor(projectWith({ "Station.json": JSON.stringify({ hello: "world" }) }));
  const res = await tools.get("build-get_domain_metadata")!.handler({ name: "Station" });
  assert.equal(res.isError, true);
  assert.match(text(res), /not written by the Exeris annotation processor/);
});

// target/ is build output and a build can be configured to symlink it, so the
// containment check has to hold for paths the bridge itself constructed.
test("a metadata file symlinked outside the project is refused", async () => {
  const outside = mkdtempSync(join(tmpdir(), "exeris-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "Station.json"), JSON.stringify(STATION));

  const root = projectWith({});
  symlinkSync(join(outside, "Station.json"), join(root, METADATA_REL, "Station.json"));

  const res = await toolsFor(root).get("build-get_domain_metadata")!.handler({ name: "Station" });
  assert.equal(res.isError, true);
  assert.match(text(res), /sandbox escape/);
});

// The directory itself is the other sandbox surface, and it is the one a real
// build is most likely to move: `target/` is output, and a build can be
// configured to put it elsewhere via a symlink. Both handlers resolve the
// directory, so both need the traversal case — the file-level test above only
// covers one of the two.
test("a metadata directory symlinked outside the project is refused by both tools", async () => {
  const outside = mkdtempSync(join(tmpdir(), "exeris-outside-dir-"));
  roots.push(outside);
  writeFileSync(join(outside, "Station.json"), JSON.stringify(STATION));

  const root = mkdtempSync(join(tmpdir(), "exeris-build-"));
  roots.push(root);
  mkdirSync(join(root, "target", "classes"), { recursive: true });
  symlinkSync(outside, join(root, METADATA_REL));

  const tools = toolsFor(root);
  for (const [name, args] of [
    ["build-list_domains", {}],
    ["build-get_domain_metadata", { name: "Station" }],
  ] as const) {
    const res = await tools.get(name)!.handler(args);
    assert.equal(res.isError, true, `${name} read through a directory symlink out of the project`);
    assert.match(text(res), /sandbox escape/, name);
  }
});

test("build-* is dark when no project root resolved", async () => {
  const tools = toolsFor(null);
  for (const name of ["build-list_domains", "build-get_domain_metadata"]) {
    const res = await tools.get(name)!.handler({ name: "Station" });
    assert.equal(res.isError, true, name);
    const payload = JSON.parse(text(res));
    assert.equal(payload.error, "family_unavailable");
    assert.equal(payload.family, "build");
  }
});
