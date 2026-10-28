import { strict as assert } from "node:assert";
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig } from "../config/env.js";
import { writeDocsEcosystemFixture } from "../data/__tests__/docs-ecosystem.js";
import { buildDocsSnapshot, directoryReader } from "../data/docs-snapshot-build.js";
import { loadDocsSnapshot } from "../data/docs-snapshot.js";
import { watchRoot, type WatchHandle, type WatchOptions } from "../fs/watch.js";
import { registerResources, type ResourcesHandle } from "./index.js";

const DARK = { state: "unavailable" as const, reason: "not under test", remedy: "not under test" };
const URI = "exeris://docs/adr-index";
const DEBOUNCE_MS = 60;

function configWith(docs: BridgeConfig["docs"]): BridgeConfig {
  return { mode: "contributor", modeSource: "default", ecosystemRoot: null, project: DARK, docs, lsp: DARK, kernel: DARK };
}

let work: string;
let indexFile: string;
let checkout: BridgeConfig;
let snapshot: BridgeConfig;
const open: { client: Client; server: Server }[] = [];

beforeEach(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "exeris-subscriptions-")));
  const ecosystem = join(work, "ecosystem");
  writeDocsEcosystemFixture(ecosystem);
  const docsRoot = join(ecosystem, "exeris-docs");
  indexFile = join(docsRoot, "adr-index.md");
  checkout = configWith({ state: "available", source: "checkout", docsRoot, ecosystemRoot: ecosystem });

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
});

afterEach(async () => {
  for (const { client, server } of open.splice(0)) {
    await client.close();
    await server.close();
  }
  rmSync(work, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Counts the shared watchers started and closed. */
function countingWatch(): {
  started: () => number;
  closed: () => number;
  watchRootFn: (root: string, options: WatchOptions) => WatchHandle;
} {
  let started = 0;
  let closed = 0;
  return {
    started: () => started,
    closed: () => closed,
    watchRootFn: (root, options) => {
      started++;
      const handle = watchRoot(root, options);
      return {
        ...handle,
        close: () => {
          closed++;
          handle.close();
        },
      };
    },
  };
}

interface Connected {
  client: Client;
  server: Server;
  resources: ResourcesHandle;
  updated: string[];
}

async function connect(config: BridgeConfig, watchRootFn?: (root: string, options: WatchOptions) => WatchHandle): Promise<Connected> {
  const server = new Server({ name: "test", version: "0" }, { capabilities: { resources: { subscribe: true } } });
  const resources = registerResources(server, config, { debounceMs: DEBOUNCE_MS, ...(watchRootFn ? { watchRootFn } : {}) });
  const client = new Client({ name: "test-client", version: "0" });
  const updated: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updated.push(n.params.uri);
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push({ client, server });
  return { client, server, resources, updated };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

/** After the quiet period has passed several times over. */
const settle = (): Promise<void> => sleep(DEBOUNCE_MS * 5);

test("an edit after subscribing sends one notification per burst", async () => {
  const w = countingWatch();
  const c = await connect(checkout, w.watchRootFn);
  await c.client.subscribeResource({ uri: URI });
  assert.equal(w.started(), 1);
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "watching" });

  writeFileSync(indexFile, "first");
  writeFileSync(indexFile, "second");
  writeFileSync(indexFile, "third");
  await until(() => c.updated.length > 0);
  await settle();
  assert.deepEqual(c.updated, [URI]);
});

test("a file replaced by rename sends one notification", async () => {
  const c = await connect(checkout);
  await c.client.subscribeResource({ uri: URI });

  const replacement = join(work, "ecosystem", "exeris-docs", ".adr-index.md.new");
  writeFileSync(replacement, "replaced");
  renameSync(replacement, indexFile);
  await until(() => c.updated.length > 0);
  await settle();
  assert.deepEqual(c.updated, [URI]);
});

test("after unsubscribing an edit sends nothing and the watcher is closed", async () => {
  const w = countingWatch();
  const c = await connect(checkout, w.watchRootFn);
  await c.client.subscribeResource({ uri: URI });
  await c.client.unsubscribeResource({ uri: URI });
  assert.equal(w.closed(), 1);
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "off" });

  writeFileSync(indexFile, "edited");
  await settle();
  assert.deepEqual(c.updated, []);
});

test("subscribing again after the last unsubscribe watches again", async () => {
  const w = countingWatch();
  const c = await connect(checkout, w.watchRootFn);
  await c.client.subscribeResource({ uri: URI });
  await c.client.unsubscribeResource({ uri: URI });
  await c.client.subscribeResource({ uri: URI });
  assert.equal(w.started(), 2);
  writeFileSync(indexFile, "edited");
  await until(() => c.updated.length > 0);
});

test("closing the server closes the watcher", async () => {
  const w = countingWatch();
  const c = await connect(checkout, w.watchRootFn);
  await c.client.subscribeResource({ uri: URI });
  await c.server.close();
  assert.equal(w.closed(), 1);
});

test("a subscription of one server never notifies another", async () => {
  const a = await connect(checkout);
  const b = await connect(checkout);
  await a.client.subscribeResource({ uri: URI });
  writeFileSync(indexFile, "edited");
  await until(() => a.updated.length > 0);
  await settle();
  assert.deepEqual(a.updated, [URI]);
  assert.deepEqual(b.updated, []);
});

test("over the snapshot a subscription is accepted, starts no watcher and never fires", async () => {
  const w = countingWatch();
  const c = await connect(snapshot, w.watchRootFn);
  await c.client.subscribeResource({ uri: URI });
  assert.equal(w.started(), 0);
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "static" });
  writeFileSync(indexFile, "edited");
  await settle();
  assert.deepEqual(c.updated, []);
  await c.client.unsubscribeResource({ uri: URI });
});

test("with docs unavailable a subscription is accepted and starts no watcher", async () => {
  const w = countingWatch();
  const c = await connect(configWith(DARK), w.watchRootFn);
  await c.client.subscribeResource({ uri: URI });
  assert.equal(w.started(), 0);
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "static" });
});

test("any other URI is invalid params naming the subscribable one", async () => {
  const c = await connect(checkout);
  for (const uri of ["exeris://docs/hla", "exeris://docs/adr/003", "file:///etc/passwd", ""]) {
    await assert.rejects(c.client.subscribeResource({ uri }), (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, ErrorCode.InvalidParams);
      assert.ok(err.message.includes(URI), err.message);
      return true;
    });
  }
});

test("unsubscribing from a URI that was never subscribed succeeds", async () => {
  const w = countingWatch();
  const c = await connect(checkout, w.watchRootFn);
  await c.client.unsubscribeResource({ uri: URI });
  await c.client.unsubscribeResource({ uri: "exeris://docs/hla" });
  assert.equal(w.started(), 0);
  assert.equal(w.closed(), 0);
});

test("a watcher that cannot start is reported degraded and tells the subscriber once", async () => {
  const c = await connect(checkout, () => {
    throw Object.assign(new Error("/secret/path"), { code: "EACCES" });
  });
  await c.client.subscribeResource({ uri: URI });
  await until(() => c.updated.length > 0);
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "degraded", reason: "cannot start the watcher (EACCES)" });
});

test("the reply to subscribe precedes any notification, even when the watcher cannot start", async () => {
  const c = await connect(checkout, () => {
    throw Object.assign(new Error("x"), { code: "EACCES" });
  });
  const order: string[] = [];
  c.client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
    order.push("notification");
  });
  await c.client.subscribeResource({ uri: URI });
  order.push("reply");
  await until(() => order.includes("notification"));
  assert.deepEqual(order, ["reply", "notification"]);
});

test("subscribing again replaces a degraded watcher", async () => {
  let calls = 0;
  const w = countingWatch();
  const c = await connect(checkout, (root, options) => {
    const handle = w.watchRootFn(root, options);
    return ++calls === 1 ? { ...handle, state: () => ({ state: "degraded", reason: "ENOSPC" }) } : handle;
  });
  await c.client.subscribeResource({ uri: URI });
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "degraded", reason: "ENOSPC" });
  await c.client.subscribeResource({ uri: URI });
  assert.equal(w.started(), 2);
  assert.equal(w.closed(), 1);
  assert.deepEqual(c.resources.subscriptionWatch(), { state: "watching" });
  writeFileSync(indexFile, "edited");
  await until(() => c.updated.length > 0);
});
