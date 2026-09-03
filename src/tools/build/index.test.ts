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

test("registerBuildTools registers exactly the four build-* tools", () => {
  const names = registerBuildTools(configFor(null))
    .map((t) => t.definition.name)
    .sort();
  assert.deepEqual(names, [
    "build-explain_artefacts",
    "build-get_detach_state",
    "build-get_domain_metadata",
    "build-list_domains",
  ]);
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
  for (const name of [
    "build-list_domains",
    "build-get_domain_metadata",
    "build-explain_artefacts",
    "build-get_detach_state",
  ]) {
    const res = await tools.get(name)!.handler({ name: "Station" });
    assert.equal(res.isError, true, name);
    const payload = JSON.parse(text(res));
    assert.equal(payload.error, "family_unavailable");
    assert.equal(payload.family, "build");
  }
});

// ---------------------------------------------------------------------------
// Slice 6c — the generated tree: what is in it, and who owns it.
// ---------------------------------------------------------------------------

const PKG = "com/example/fleet";

const L1_FILES = [
  `${PKG}/handler/StationHandler.java`,
  `${PKG}/service/StationService.java`,
  `${PKG}/repository/StationRepository.java`,
  `${PKG}/repository/StationNotFoundException.java`,
  "db/migration/V3__create_stations.sql",
  "openapi/station-api.yaml",
  `${PKG}/handler/DepotHandler.java`,
  "com/example/Application.java",
];

function manifestBody(paths: readonly string[]): string {
  return ["# Exeris Tooling generated-output manifest - DO NOT EDIT MANUALLY", ...paths].join("\n") + "\n";
}

/** Write an output tree under `root`: its manifest plus the files it lists. */
function writeTree(root: string, treeRoot: string, paths: readonly string[]): void {
  mkdirSync(join(root, treeRoot), { recursive: true });
  writeFileSync(join(root, treeRoot, ".exeris-codegen-manifest"), manifestBody(paths));
  for (const rel of paths) {
    const abs = join(root, treeRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "// generated\n");
  }
}

/** A project that has run codegen: metadata emitted AND an L1 tree on disk. */
function generatedProject(paths: readonly string[] = L1_FILES): string {
  const root = projectWith(BUILT);
  writeTree(root, "src/main/generated/java", paths);
  return root;
}

test("build-explain_artefacts explains every emitted path", async () => {
  const res = await toolsFor(generatedProject()).get("build-explain_artefacts")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.present, true);
  assert.equal(payload.total, L1_FILES.length);
  assert.deepEqual(payload.roots, [{ root: "src/main/generated/java", generatedFiles: L1_FILES.length }]);

  type Explained = { path: string; generator: string | null; scope: string };
  const byPath = new Map<string, Explained>(
    (payload.artefacts as Explained[]).map((a) => [a.path, a]),
  );
  assert.equal(byPath.get("db/migration/V3__create_stations.sql")?.generator, "KernelFlywayGenerator");
  assert.equal(byPath.get("com/example/Application.java")?.scope, "project");
});

// The tool exists because a generated CREATE TABLE was not discoverable from
// inside an agent's session, and it hand-wrote a conflicting one instead. The
// SQL has to be findable from the entity name, which is all the agent has.
test("the migration for an entity is findable by the entity name", async () => {
  const tools = toolsFor(generatedProject());
  const res = await tools.get("build-explain_artefacts")!.handler({ entity: "Station" });
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));

  const paths = payload.artefacts.map((a: { path: string }) => a.path);
  assert.ok(paths.includes("db/migration/V3__create_stations.sql"));
  assert.ok(!paths.includes(`${PKG}/handler/DepotHandler.java`));
  assert.equal(payload.filter, "Station");
  assert.equal(payload.total, L1_FILES.length);
});

// A filter that hid the project-wide files would answer "nothing else exists"
// to an agent that only asked to narrow.
test("filtering by entity still returns the project-wide artefacts", async () => {
  const tools = toolsFor(generatedProject());
  const res = await tools.get("build-explain_artefacts")!.handler({ entity: "Station" });
  const paths = JSON.parse(text(res)).artefacts.map((a: { path: string }) => a.path);
  assert.ok(paths.includes("com/example/Application.java"));
});

test("the generated-test root is reported alongside the main one", async () => {
  const root = generatedProject();
  writeTree(root, "src/test/generated/java", [`${PKG}/handler/StationHandlerTest.java`]);
  const res = await toolsFor(root).get("build-explain_artefacts")!.handler({});
  const payload = JSON.parse(text(res));
  assert.equal(payload.roots.length, 2);
  const test = payload.artefacts.find((a: { root: string }) => a.root === "src/test/generated/java");
  assert.equal(test.artefact, "Generated test");
});

test("a manifest path that is gone from disk is reported rather than implied", async () => {
  const root = projectWith(BUILT);
  mkdirSync(join(root, "src/main/generated/java"), { recursive: true });
  writeFileSync(
    join(root, "src/main/generated/java/.exeris-codegen-manifest"),
    manifestBody([`${PKG}/handler/StationHandler.java`]),
  );
  const res = await toolsFor(root).get("build-explain_artefacts")!.handler({});
  const payload = JSON.parse(text(res));
  assert.deepEqual(payload.missingOnDisk, [`src/main/generated/java/${PKG}/handler/StationHandler.java`]);
});

test("a project that has not run codegen answers present:false, not an error", async () => {
  const res = await toolsFor(projectWith(BUILT)).get("build-explain_artefacts")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.present, false);
  assert.match(payload.remedy, /mvn exeris:generate/);
  assert.match(payload.remedy, /build-get_detach_state/);
});

test("build-explain_artefacts refuses a path-shaped entity", async () => {
  const tools = toolsFor(generatedProject());
  const res = await tools.get("build-explain_artefacts")!.handler({ entity: "../../../etc" });
  assert.equal(res.isError, true);
  assert.match(text(res), /Java simple name/);
});

test("an L1 manifest means the pipeline owns the tree", async () => {
  const res = await toolsFor(generatedProject()).get("build-get_detach_state")!.handler({});
  assert.ok(!res.isError, text(res));
  const payload = JSON.parse(text(res));
  assert.equal(payload.state, "l1_generated");
  assert.deepEqual(payload.roots, [
    { root: "src/main/generated/java", layer: "L1", ownedByPipeline: L1_FILES.length },
  ]);
  assert.match(payload.guidance, /mvn exeris:detach/);
});

// Detach moves every regular file out of the generated root, and the manifest
// sits at that root — so the promoted copy under src/main/java is the evidence
// that survives the move.
test("a promoted manifest under the owned root reads as detached", async () => {
  const root = projectWith(BUILT);
  mkdirSync(join(root, "src/main/java"), { recursive: true });
  writeFileSync(join(root, "src/main/java/.exeris-codegen-manifest"), manifestBody(L1_FILES));

  const res = await toolsFor(root).get("build-get_detach_state")!.handler({});
  const payload = JSON.parse(text(res));
  assert.equal(payload.state, "l2_detached");
  assert.deepEqual(payload.roots, [{ root: "src/main/java", layer: "L2", ownedByPipeline: 0 }]);
  assert.match(payload.guidance, /safe and permanent/);
});

// Nothing in the build ever ADDS the .gitignore entry — only detach removes it.
// So its presence rules a detach out and its absence proves nothing, and the
// evidence has to say which of the two it is.
test("the .gitignore entry is reported as one-directional evidence", async () => {
  const withEntry = generatedProject();
  writeFileSync(join(withEntry, ".gitignore"), "target/\n/src/main/generated/\n");
  const present = JSON.parse(
    text(await toolsFor(withEntry).get("build-get_detach_state")!.handler({})),
  );
  assert.ok(present.evidence.some((e: string) => /has not detached/.test(e)));

  const withoutEntry = generatedProject();
  writeFileSync(join(withoutEntry, ".gitignore"), "target/\n");
  const absent = JSON.parse(
    text(await toolsFor(withoutEntry).get("build-get_detach_state")!.handler({})),
  );
  assert.ok(absent.evidence.some((e: string) => /not evidence either way/.test(e)));
});

test("no generated tree at all is its own state, with the command that makes one", async () => {
  const res = await toolsFor(projectWith(BUILT)).get("build-get_detach_state")!.handler({});
  const payload = JSON.parse(text(res));
  assert.equal(payload.state, "not_generated");
  assert.deepEqual(payload.roots, []);
  assert.match(payload.guidance, /mvn exeris:generate/);
});

test("a generated root symlinked outside the project is refused", async () => {
  const outside = mkdtempSync(join(tmpdir(), "exeris-outside-gen-"));
  roots.push(outside);
  writeFileSync(join(outside, ".exeris-codegen-manifest"), manifestBody(L1_FILES));

  const root = projectWith(BUILT);
  mkdirSync(join(root, "src/main"), { recursive: true });
  mkdirSync(join(root, "src/main/generated"), { recursive: true });
  symlinkSync(outside, join(root, "src/main/generated/java"));

  const tools = toolsFor(root);
  for (const name of ["build-explain_artefacts", "build-get_detach_state"]) {
    const res = await tools.get(name)!.handler({});
    assert.equal(res.isError, true, name);
    assert.match(text(res), /sandbox escape/, name);
  }
});
