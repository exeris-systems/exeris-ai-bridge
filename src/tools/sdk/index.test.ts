import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BundleState } from "../../data/bundle.js";
import { registerSdkTools, resolveSdkHandle } from "./index.js";

const SAMPLE_CATALOG = {
  catalogFormat: 1,
  sdkVersion: "0.12.0-SNAPSHOT",
  annotationCount: 3,
  packages: [
    { name: "eu.exeris.sdk.annotation", purpose: "Core annotations" },
    { name: "eu.exeris.sdk.annotation.system", purpose: "System field markers" },
  ],
  annotations: [
    {
      name: "Action",
      qualifiedName: "eu.exeris.sdk.annotation.Action",
      package: "eu.exeris.sdk.annotation",
      nested: false,
      targets: ["METHOD"],
      memberValueOnly: false,
      retention: "SOURCE",
      purpose: "Exposes domain methods as API endpoints",
      attributes: [],
    },
    {
      name: "ExerisDomain",
      qualifiedName: "eu.exeris.sdk.annotation.ExerisDomain",
      package: "eu.exeris.sdk.annotation",
      nested: false,
      targets: ["TYPE"],
      memberValueOnly: false,
      retention: "SOURCE",
      purpose: "Marks an entity-first domain aggregate",
      attributes: [],
    },
    {
      name: "TenantId",
      qualifiedName: "eu.exeris.sdk.annotation.system.TenantId",
      package: "eu.exeris.sdk.annotation.system",
      nested: false,
      targets: ["FIELD"],
      memberValueOnly: false,
      retention: "SOURCE",
      purpose: "Names the tenancy discriminator field",
      attributes: [],
    },
  ],
};

const SAMPLE_AST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://exeris.eu/schema/sdk/ast/0.12.0.json",
  title: "Exeris SDK AST",
  schemaFormat: 1,
  sdkVersion: "0.12.0-SNAPSHOT",
  astSchemaVersion: "0.12.0",
  definitionCount: 2,
  "x-exeris-reader-requirements": [
    { id: "FAIL_ON_NULL_FOR_PRIMITIVES", statement: "Must be false in Jackson" },
  ],
  $defs: {
    DomainMetadata: {
      type: "object",
      description: "Root metadata record",
    },
    ActionMetadata: {
      type: "object",
      description: "Action metadata record",
    },
  },
};

let work: string;
let root: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-sdk-test-"));
  root = join(work, "data");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function writeEntry(id: string, text: string) {
  const path = `${id}.json`;
  writeFileSync(join(root, path), text, "utf8");
  return {
    id,
    path,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
    sourceArtifact: `eu.exeris:${id}:0.12.0-SNAPSHOT`,
  };
}

function createBundle(withEntries = true): BundleState {
  if (!withEntries) {
    return {
      state: "available",
      generatedAt: new Date().toISOString(),
      bridgeVersion: "0.7.0",
      entries: [],
    };
  }
  const e1 = writeEntry("annotation-catalog", JSON.stringify(SAMPLE_CATALOG));
  const e2 = writeEntry("ast-schema", JSON.stringify(SAMPLE_AST_SCHEMA));
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    bridgeVersion: "0.7.0",
    entries: [e1, e2],
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest), "utf8");
  return {
    state: "available",
    generatedAt: manifest.generatedAt,
    bridgeVersion: manifest.bridgeVersion,
    entries: manifest.entries,
  };
}

function payload(res: CallToolResult): any {
  return JSON.parse((res.content[0] as { text: string }).text);
}

test("resolveSdkHandle reports unavailable when bundle is unavailable", () => {
  const handle = resolveSdkHandle({
    state: "unavailable",
    reason: "no bundle",
    remedy: "vendor data",
  });
  assert.equal(handle.state, "unavailable");
});

test("resolveSdkHandle reports unavailable when bundle has no annotation-catalog entry", () => {
  const handle = resolveSdkHandle(createBundle(false));
  assert.equal(handle.state, "unavailable");
  assert.match((handle as any).reason, /no annotation catalog/);
});

test("registerSdkTools registers sdk-list_annotations and sdk-get_ast_schema", () => {
  const bundle = createBundle(true);
  const tools = registerSdkTools(bundle, root);
  const names = tools.map((t) => t.definition.name).sort();
  assert.deepEqual(names, ["sdk-get_ast_schema", "sdk-list_annotations"]);
});

test("sdk-list_annotations returns all annotations with no filters", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-list_annotations")!;
  const res = await tool.handler({});
  assert.ok(!res.isError);
  const data = payload(res);
  assert.equal(data.totalInCatalog, 3);
  assert.equal(data.matched, 3);
  assert.equal(data.annotations.length, 3);
});

test("sdk-list_annotations filters by package", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-list_annotations")!;
  const res = await tool.handler({ package: "system" });
  assert.ok(!res.isError);
  const data = payload(res);
  assert.equal(data.matched, 1);
  assert.equal(data.annotations[0].name, "TenantId");
});

test("sdk-list_annotations filters by target", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-list_annotations")!;
  const res = await tool.handler({ target: "TYPE" });
  assert.ok(!res.isError);
  const data = payload(res);
  assert.equal(data.matched, 1);
  assert.equal(data.annotations[0].name, "ExerisDomain");
});

test("sdk-list_annotations filters by query search", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-list_annotations")!;
  const res = await tool.handler({ query: "endpoint" });
  assert.ok(!res.isError);
  const data = payload(res);
  assert.equal(data.matched, 1);
  assert.equal(data.annotations[0].name, "Action");
});

test("sdk-get_ast_schema returns envelope when definition is omitted", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-get_ast_schema")!;
  const res = await tool.handler({});
  assert.ok(!res.isError);
  const data = payload(res);
  assert.equal(data.schemaFormat, 1);
  assert.equal(data.definitionCount, 2);
  assert.deepEqual(data.definitions, ["ActionMetadata", "DomainMetadata"]);
  assert.ok(Array.isArray(data["x-exeris-reader-requirements"]));
});

test("sdk-get_ast_schema returns definition schema when requested", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-get_ast_schema")!;
  const res = await tool.handler({ definition: "DomainMetadata" });
  assert.ok(!res.isError);
  const data = payload(res);
  assert.equal(data.definition, "DomainMetadata");
  assert.equal(data.schema.description, "Root metadata record");
});

test("sdk-get_ast_schema reports error on unknown definition", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-get_ast_schema")!;
  const res = await tool.handler({ definition: "NoSuchRecord" });
  assert.equal(res.isError, true);
  const data = payload(res);
  assert.equal(data.error, "unknown_definition");
  assert.match(data.message, /NoSuchRecord/);
});

test("sdk-get_ast_schema reports error on inherited property definition names like constructor or __proto__", async () => {
  const bundle = createBundle(true);
  const tool = registerSdkTools(bundle, root).find((t) => t.definition.name === "sdk-get_ast_schema")!;

  for (const def of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    const res = await tool.handler({ definition: def });
    assert.equal(res.isError, true);
    const data = payload(res);
    assert.equal(data.error, "unknown_definition");
    assert.match(data.message, new RegExp(def));
  }
});

test("sdk tools return family_unavailable when bundle is unavailable", async () => {
  const darkBundle: BundleState = {
    state: "unavailable",
    reason: "no bundle (test)",
    remedy: "run vendor:data (test)",
  };
  const tools = registerSdkTools(darkBundle);
  for (const tool of tools) {
    const res = await tool.handler({});
    assert.equal(res.isError, true);
    const data = payload(res);
    assert.equal(data.error, "family_unavailable");
    assert.equal(data.family, "sdk");
  }
});
