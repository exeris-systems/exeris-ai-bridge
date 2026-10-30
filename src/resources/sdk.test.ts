import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import type { BundleState } from "../data/bundle.js";
import { registerResources } from "./index.js";

const DARK = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };
const URI = "exeris://sdk/brief-schema";
const SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://exeris.eu/schema/sdk/brief/1.json",
  briefSchemaFormat: 1,
  sdkVersion: "0.13.1",
});

const config: BridgeConfig = {
  mode: "contributor",
  modeSource: "default",
  ecosystemRoot: null,
  project: DARK,
  docs: DARK,
  lsp: DARK,
  kernel: DARK,
};

let work: string;
const open: Client[] = [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "exeris-sdk-resource-"));
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close();
  rmSync(work, { recursive: true, force: true });
});

/** A bundle whose single brief-schema entry points at `text` written under the work directory. */
function bundleWith(text: string, digestOf: string = text): BundleState {
  writeFileSync(join(work, "brief-schema.json"), text, "utf8");
  return {
    state: "available",
    generatedAt: "2026-01-01T00:00:00Z",
    bridgeVersion: "0.9.0",
    entries: [
      {
        id: "brief-schema",
        path: "brief-schema.json",
        sha256: createHash("sha256").update(digestOf, "utf8").digest("hex"),
        bytes: Buffer.byteLength(text),
        sourceArtifact: "eu.exeris:exeris-sdk-source-model:0.13.1",
      },
    ],
  };
}

const withoutEntry: BundleState = {
  state: "available",
  generatedAt: "2026-01-01T00:00:00Z",
  bridgeVersion: "0.9.0",
  entries: [],
};

async function connect(bundle: BundleState): Promise<Client> {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { resources: { subscribe: true } } });
  registerResources(server, config, bundle, { bundleRoot: work });
  const client = new Client({ name: "test-client", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client);
  return client;
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

test("the brief schema is listed and read verbatim when the bundle carries it", async () => {
  const client = await connect(bundleWith(SCHEMA));
  const listed = (await client.listResources()).resources.find((r) => r.uri === URI);
  assert.ok(listed, "brief-schema was not listed");
  assert.equal(listed.mimeType, "application/schema+json");

  const result = await client.readResource({ uri: URI });
  assert.equal(result.contents.length, 1);
  const [content] = result.contents;
  assert.equal(content.uri, URI);
  assert.equal(content.mimeType, "application/schema+json");
  assert.ok("text" in content);
  assert.equal(content.text, SCHEMA);
  assert.equal(JSON.parse(content.text).briefSchemaFormat, 1);
});

test("without the entry the resource is not listed and a read says why", async () => {
  for (const bundle of [withoutEntry, DARK]) {
    const client = await connect(bundle);
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    assert.equal(uris.includes(URI), false);
    assert.equal(uris.includes("exeris://docs/adr-index"), true);

    const err = await rejection(client.readResource({ uri: URI }));
    assert.equal(err.code, ErrorCode.InternalError);
    assert.equal((err.data as { error?: string }).error, "family_unavailable");
    assert.equal((err.data as { family?: string }).family, "sdk");
    assert.ok(((err.data as { remedy?: string }).remedy ?? "").length > 0);
  }
});

test("a schema of a format this build does not read is not served", async () => {
  const client = await connect(bundleWith(JSON.stringify({ briefSchemaFormat: 2 })));
  const err = await rejection(client.readResource({ uri: URI }));
  assert.equal(err.code, ErrorCode.InternalError);
  assert.match((err.data as { reason: string }).reason, /briefSchemaFormat 2/);
});

test("a schema that fails its digest is not served", async () => {
  const client = await connect(bundleWith(SCHEMA, "something else"));
  const err = await rejection(client.readResource({ uri: URI }));
  assert.equal(err.code, ErrorCode.InternalError);
  assert.match((err.data as { reason: string }).reason, /integrity/);
});

test("the brief schema cannot be subscribed to", async () => {
  const client = await connect(bundleWith(SCHEMA));
  const err = await rejection(client.subscribeResource({ uri: URI }));
  assert.equal(err.code, ErrorCode.InvalidParams);
  assert.match(err.message, /exeris:\/\/docs\/adr-index/);
});
