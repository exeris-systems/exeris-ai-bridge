import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import { writeDocsEcosystemFixture } from "../data/__tests__/docs-ecosystem.js";
import { buildDocsSnapshot, directoryReader } from "../data/docs-snapshot-build.js";
import { loadDocsSnapshot } from "../data/docs-snapshot.js";
import { registerResources } from "./index.js";
import { RESOURCE_NOT_FOUND } from "./docs.js";

const DARK = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };

function configWith(docs: BridgeConfig["docs"]): BridgeConfig {
  return {
    mode: "contributor",
    modeSource: "default",
    ecosystemRoot: null,
    project: DARK,
    docs,
    lsp: DARK,
    kernel: DARK,
  };
}

let work: string;
let checkout: BridgeConfig;
let snapshot: BridgeConfig;
let unavailable: BridgeConfig;
const open: Client[] = [];

beforeEach(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "exeris-resources-")));
  const ecosystem = join(work, "ecosystem");
  writeDocsEcosystemFixture(ecosystem);
  checkout = configWith({
    state: "available",
    source: "checkout",
    docsRoot: join(ecosystem, "exeris-docs"),
    ecosystemRoot: ecosystem,
  });

  const dataRoot = join(work, "data");
  await buildDocsSnapshot(directoryReader(ecosystem), dataRoot, new Date("2026-09-30T00:00:00Z"));
  const loaded = loadDocsSnapshot(dataRoot);
  assert.equal(loaded.state, "available");
  snapshot = configWith({
    state: "available",
    source: "snapshot",
    docsRoot: loaded.docsRoot,
    ecosystemRoot: loaded.ecosystemRoot,
    generatedAt: loaded.generatedAt,
    sources: loaded.sources,
  });

  unavailable = configWith(DARK);
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  rmSync(work, { recursive: true, force: true });
});

/** A client connected to the real resource handlers over an in-memory transport. */
async function connect(config: BridgeConfig): Promise<Client> {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { resources: { subscribe: true } } });
  registerResources(server, config);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client);
  return client;
}

async function readText(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  assert.equal(result.contents.length, 1);
  const [content] = result.contents;
  assert.equal(content.uri, uri);
  assert.equal(content.mimeType, "text/markdown");
  assert.ok("text" in content, "expected a text resource, got a blob");
  return content.text;
}

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof McpError, `expected an McpError, got ${String(err)}`);
    return err;
  }
  throw new Error("expected the request to be rejected");
}

for (const [mode, pick] of [
  ["checkout", () => checkout],
  ["snapshot", () => snapshot],
] as const) {
  test(`${mode}: the registry index is served as markdown`, async () => {
    const text = await readText(await connect(pick()), "exeris://docs/adr-index");
    assert.match(text, /^# ADR Index \(fixture\)/);
    assert.match(text, /\| 003 \| Sibling by URL/);
  });

  test(`${mode}: hla and whitepaper`, async () => {
    const client = await connect(pick());
    assert.match(await readText(client, "exeris://docs/hla"), /^# HLA \(fixture\)/);
    assert.match(await readText(client, "exeris://docs/whitepaper"), /^# Whitepaper \(fixture\)/);
  });

  test(`${mode}: every template kind`, async () => {
    const client = await connect(pick());
    for (const kind of ["ADR", "RFC", "RESEARCH"]) {
      assert.match(await readText(client, `exeris://docs/template/${kind}`), new RegExp(`^# ${kind} TEMPLATE`));
    }
  });

  test(`${mode}: a local ADR and an ADR in a licensed sibling`, async () => {
    const client = await connect(pick());
    assert.match(await readText(client, "exeris://docs/adr/001"), /^# ADR-001 Local record/);
    assert.match(await readText(client, "exeris://docs/adr/003"), /^# ADR-003 Sibling by URL/);
  });

  test(`${mode}: an ADR number absent from the registry is resource-not-found`, async () => {
    const err = await rejection(connect(pick()).then((c) => c.readResource({ uri: "exeris://docs/adr/999" })));
    assert.equal(err.code, RESOURCE_NOT_FOUND);
    assert.match(err.message, /ADR-999 is not in the registry/);
  });

  test(`${mode}: a reserved ADR with no content is resource-not-found`, async () => {
    const err = await rejection(connect(pick()).then((c) => c.readResource({ uri: "exeris://docs/adr/031" })));
    assert.equal(err.code, RESOURCE_NOT_FOUND);
    assert.match(err.message, /not yet authored/);
  });

  test(`${mode}: an ADR linked outside the ecosystem is not served`, async () => {
    const err = await rejection(connect(pick()).then((c) => c.readResource({ uri: "exeris://docs/adr/040" })));
    assert.equal(err.code, RESOURCE_NOT_FOUND);
    assert.match(err.message, /linked outside the Exeris ecosystem/);
  });
}

test("snapshot: an ADR from an unlicensed repository names the owning repo and its GitHub URL", async () => {
  const err = await rejection(
    connect(snapshot).then((c) => c.readResource({ uri: "exeris://docs/adr/007" })),
  );
  assert.equal(err.code, RESOURCE_NOT_FOUND);
  assert.match(err.message, /exeris-kernel/);
  assert.match(err.message, /https:\/\/github\.com\/exeris-systems\/exeris-kernel\//);
});

test("snapshot: enterprise-tier and enterprise-private ADRs are never served and never leak their content", async () => {
  const client = await connect(snapshot);
  for (const n of ["016", "018"]) {
    const err = await rejection(client.readResource({ uri: `exeris://docs/adr/${n}` }));
    assert.equal(err.code, RESOURCE_NOT_FOUND);
    assert.doesNotMatch(err.message, /# ADR-01[68]/);
  }
});

test("a failure message carries no absolute path", async () => {
  const client = await connect(snapshot);
  const err = await rejection(client.readResource({ uri: "exeris://docs/adr/020" }));
  assert.equal(err.message.includes(work), false);
});

test("malformed or unknown URIs are invalid params", async () => {
  const client = await connect(checkout);
  for (const uri of [
    "exeris://docs/adr/../x",
    "exeris://docs/adr/..%2Fx",
    "exeris://docs/adr/25",
    "exeris://docs/adr/0025",
    "exeris://docs/adr/abc",
    "exeris://docs/adr/",
    "exeris://docs/template/FOO",
    "exeris://docs/template/adr",
    "exeris://docs/template/",
    "exeris://docs/template/ADR/x",
    "exeris://docs/hla/extra",
    "exeris://docs/hla?x=1",
    "exeris://docs/",
    "exeris://docs",
    "exeris://other/hla",
    "file:///etc/passwd",
    "https://example.com/exeris://docs/hla",
    "not a uri",
  ]) {
    const err = await rejection(client.readResource({ uri }));
    assert.equal(err.code, ErrorCode.InvalidParams, `${uri} should be invalid params, got ${err.code}`);
  }
});

test("lists are identical in checkout, snapshot and unavailable docs", async () => {
  const lists = [];
  for (const config of [checkout, snapshot, unavailable]) {
    const client = await connect(config);
    lists.push({
      resources: await client.listResources(),
      templates: await client.listResourceTemplates(),
    });
  }
  assert.deepEqual(lists[1], lists[0]);
  assert.deepEqual(lists[2], lists[0]);

  assert.deepEqual(
    lists[0].resources.resources.map((r) => r.uri),
    ["exeris://docs/adr-index", "exeris://docs/hla", "exeris://docs/whitepaper"],
  );
  assert.deepEqual(
    lists[0].templates.resourceTemplates.map((t) => t.uriTemplate),
    ["exeris://docs/adr/{NNN}", "exeris://docs/template/{kind}"],
  );
  for (const item of [...lists[0].resources.resources, ...lists[0].templates.resourceTemplates]) {
    assert.equal(item.mimeType, "text/markdown");
  }
});

test("unavailable docs: read reports it with the reason and remedy; a malformed URI is still invalid params", async () => {
  const client = await connect(unavailable);
  const err = await rejection(client.readResource({ uri: "exeris://docs/adr-index" }));
  assert.equal(err.code, ErrorCode.InternalError);
  assert.match(err.message, /not available/);
  assert.deepEqual(err.data, {
    error: "family_unavailable",
    family: "docs",
    reason: "not under test",
    remedy: "not under test",
  });

  const bad = await rejection(client.readResource({ uri: "exeris://docs/nope" }));
  assert.equal(bad.code, ErrorCode.InvalidParams);
});

test("the drift-patterns policy is embedded in a prompt only and is not readable as a resource", async () => {
  const err = await rejection(connect(checkout).then((c) => c.readResource({ uri: "exeris://docs/policy/drift-patterns" })));
  assert.equal(err.code, ErrorCode.InvalidParams);
});
