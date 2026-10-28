import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { encodeMessage, LspMessageDecoder } from "./lsp-framing.js";
import { JSONRPC_METHOD_NOT_FOUND, LspChannel, LspClient, LspCloseReason } from "./lsp-client.js";

// The client-side half of watched-file forwarding, against a fake server that
// issues server-to-client requests the way the real one does after `initialized`.

const SPEC = { command: "lsp-stub", args: ["--demo"] };
const execFileAsync = promisify(execFile);

class FakeChannel implements LspChannel {
  readonly sent: any[] = [];
  private dataHandler: ((c: Buffer) => void) | null = null;
  private readonly decoder = new LspMessageDecoder();
  autoResponder: ((msg: any) => unknown) | null = null;

  write(chunk: Buffer): void {
    for (const msg of this.decoder.push(chunk)) {
      this.sent.push(msg);
      const response = this.autoResponder?.(msg);
      if (response !== undefined) this.respond(response);
    }
  }
  onData(handler: (c: Buffer) => void): void {
    this.dataHandler = handler;
  }
  private closeHandler: ((r: LspCloseReason) => void) | null = null;
  closed = false;
  onClose(handler: (r: LspCloseReason) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }
  emitClose(reason: LspCloseReason): void {
    this.closeHandler?.(reason);
  }

  respond(message: unknown): void {
    this.dataHandler?.(encodeMessage(message));
  }
}

function ackInitialize(msg: any): unknown {
  if (msg.method === "initialize") return { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } };
  return undefined;
}

/** Write a file from a second process, as another tool on the same workspace would. */
async function writeFromOtherProcess(path: string, content: string): Promise<void> {
  await execFileAsync(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
    path,
    content,
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

interface Fixture {
  readonly root: string;
  readonly channel: FakeChannel;
  readonly client: LspClient;
  /** Start the handshake; the fake's reverse request is sent on `initialized`. */
  start(): Promise<void>;
  cleanup(): void;
}

function fixture(reverse: (root: string) => unknown, rootOverride?: string): Fixture {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "exeris-lsp-watch-")));
  mkdirSync(join(tmp, "sub"));
  const root = rootOverride ?? tmp;
  const channel = new FakeChannel();
  channel.autoResponder = (msg) => {
    if (msg.method === "initialize") return ackInitialize(msg);
    if (msg.method === "initialized") return reverse(root);
    return undefined;
  };
  const client = new LspClient(
    { ...SPEC, workspaceRoot: root },
    { channelFactory: () => channel, watchDebounceMs: 50, requestTimeoutMs: 200 },
  );
  return {
    root,
    channel,
    client,
    start: async () => {
      // The probe request is never answered; only the handshake matters.
      await client.request("noop").catch(() => undefined);
    },
    cleanup: () => {
      client.dispose();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const registerJavaWatcher = (id: string | number) => () => ({
  jsonrpc: "2.0",
  id,
  method: "client/registerCapability",
  params: {
    registrations: [
      {
        id: "w1",
        method: "workspace/didChangeWatchedFiles",
        registerOptions: { watchers: [{ globPattern: "**/*.java" }] },
      },
    ],
  },
});

const watched = (channel: FakeChannel) => channel.sent.filter((m) => m.method === "workspace/didChangeWatchedFiles");
const replyTo = (channel: FakeChannel, id: string | number) =>
  channel.sent.find((m) => m.id === id && m.method === undefined);

test("initialize advertises dynamic registration for watched files", async () => {
  const f = fixture(() => undefined);
  try {
    await f.start();
    assert.deepEqual(f.channel.sent[0].params.capabilities, {
      workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
    });
  } finally {
    f.cleanup();
  }
});

test("a registered watcher forwards a write made by a second process as didChangeWatchedFiles", async () => {
  const f = fixture(registerJavaWatcher(7));
  try {
    await f.start();
    await until(() => replyTo(f.channel, 7) !== undefined, "registration reply");
    assert.deepEqual(replyTo(f.channel, 7), { jsonrpc: "2.0", id: 7, result: null });
    await sleep(100); // let the platform watcher arm

    const file = join(f.root, "sub", "Order.java");
    await writeFromOtherProcess(file, "class Order {}");
    await until(() => watched(f.channel).length > 0, "didChangeWatchedFiles");

    const notification = watched(f.channel)[0];
    assert.equal(notification.id, undefined, "it is a notification");
    const changes: { uri: string; type: number }[] = watched(f.channel).flatMap((m) => m.params.changes);
    assert.ok(
      changes.some((c) => c.uri === pathToFileURL(file).href && c.type === 1),
      JSON.stringify(changes),
    );
  } finally {
    f.cleanup();
  }
});

test("a string request id is echoed back unchanged", async () => {
  const f = fixture(registerJavaWatcher("srv-1"));
  try {
    await f.start();
    await until(() => replyTo(f.channel, "srv-1") !== undefined, "registration reply");
    assert.deepEqual(replyTo(f.channel, "srv-1"), { jsonrpc: "2.0", id: "srv-1", result: null });
  } finally {
    f.cleanup();
  }
});

test("an unknown server request is answered with method not found and the same id", async () => {
  const f = fixture(() => ({ jsonrpc: "2.0", id: "x-9", method: "workspace/configuration", params: {} }));
  try {
    await f.start();
    await until(() => replyTo(f.channel, "x-9") !== undefined, "error reply");
    const reply = replyTo(f.channel, "x-9");
    assert.equal(reply.error.code, JSONRPC_METHOD_NOT_FOUND);
    assert.equal(reply.result, undefined);
  } finally {
    f.cleanup();
  }
});

test("unregisterCapability stops forwarding", async () => {
  const f = fixture(registerJavaWatcher(1));
  try {
    await f.start();
    await until(() => replyTo(f.channel, 1) !== undefined, "registration reply");
    await sleep(100);

    f.channel.respond({
      jsonrpc: "2.0",
      id: 2,
      method: "client/unregisterCapability",
      params: { unregisterations: [{ id: "w1", method: "workspace/didChangeWatchedFiles" }] },
    });
    await until(() => replyTo(f.channel, 2) !== undefined, "unregister reply");
    assert.deepEqual(replyTo(f.channel, 2), { jsonrpc: "2.0", id: 2, result: null });

    await writeFromOtherProcess(join(f.root, "After.java"), "class After {}");
    await sleep(400);
    assert.equal(watched(f.channel).length, 0);
  } finally {
    f.cleanup();
  }
});

test("a RelativePattern whose baseUri is outside the workspace root is refused", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "exeris-lsp-outside-")));
  const f = fixture(() => ({
    jsonrpc: "2.0",
    id: 3,
    method: "client/registerCapability",
    params: {
      registrations: [
        {
          id: "w1",
          method: "workspace/didChangeWatchedFiles",
          registerOptions: {
            watchers: [{ globPattern: { baseUri: pathToFileURL(outside).href, pattern: "**/*.java" } }],
          },
        },
      ],
    },
  }));
  try {
    await f.start();
    await until(() => replyTo(f.channel, 3) !== undefined, "refusal reply");
    assert.equal(replyTo(f.channel, 3).error.code, -32602);

    await writeFromOtherProcess(join(outside, "Evil.java"), "class Evil {}");
    await writeFromOtherProcess(join(f.root, "Inside.java"), "class Inside {}");
    await sleep(400);
    assert.equal(watched(f.channel).length, 0);
  } finally {
    f.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a RelativePattern inside the root is rebased onto it", async () => {
  const f = fixture((root) => ({
    jsonrpc: "2.0",
    id: 4,
    method: "client/registerCapability",
    params: {
      registrations: [
        {
          id: "w1",
          method: "workspace/didChangeWatchedFiles",
          registerOptions: {
            watchers: [
              {
                globPattern: {
                  baseUri: { uri: pathToFileURL(join(root, "sub")).href, name: "w" },
                  pattern: "*.java",
                },
              },
            ],
          },
        },
      ],
    },
  }));
  try {
    await f.start();
    await until(() => replyTo(f.channel, 4) !== undefined, "registration reply");
    assert.equal(replyTo(f.channel, 4).result, null);
    await sleep(100);

    await writeFromOtherProcess(join(f.root, "Top.java"), "class Top {}");
    await writeFromOtherProcess(join(f.root, "sub", "In.java"), "class In {}");
    await until(() => watched(f.channel).length > 0, "didChangeWatchedFiles");
    await sleep(300);
    const uris = watched(f.channel).flatMap((m) => m.params.changes.map((c: { uri: string }) => c.uri));
    assert.deepEqual(uris, [pathToFileURL(join(f.root, "sub", "In.java")).href]);
  } finally {
    f.cleanup();
  }
});

test("dispose stops the watcher", async () => {
  const f = fixture(registerJavaWatcher(5));
  try {
    await f.start();
    await until(() => replyTo(f.channel, 5) !== undefined, "registration reply");
    await sleep(100);
    f.client.dispose();
    await writeFromOtherProcess(join(f.root, "Late.java"), "class Late {}");
    await sleep(400);
    assert.equal(watched(f.channel).length, 0);
  } finally {
    f.cleanup();
  }
});

const registerOne = (id: number, regId: string, watchers: unknown[]) => ({
  jsonrpc: "2.0",
  id,
  method: "client/registerCapability",
  params: {
    registrations: [
      { id: regId, method: "workspace/didChangeWatchedFiles", registerOptions: { watchers } },
    ],
  },
});

test("registrations beyond the caps are refused with -32602 and change nothing", async () => {
  const f = fixture(() => undefined);
  try {
    await f.start();
    const java = [{ globPattern: "**/*.java" }];

    // Four registrations are accepted; the fifth is refused.
    for (let i = 1; i <= 5; i++) f.channel.respond(registerOne(i, `r${i}`, java));
    await until(() => [1, 2, 3, 4, 5].every((i) => replyTo(f.channel, i) !== undefined), "replies");
    for (let i = 1; i <= 4; i++) assert.equal(replyTo(f.channel, i).result, null, `registration ${i}`);
    assert.equal(replyTo(f.channel, 5).error.code, -32602);

    // Re-registering an existing id replaces it and is not a fifth registration.
    f.channel.respond(registerOne(6, "r1", java));
    // 33 watchers in one registration, and an over-long glob.
    f.channel.respond(registerOne(7, "r1", Array.from({ length: 33 }, () => java[0])));
    f.channel.respond(registerOne(8, "r1", [{ globPattern: "a".repeat(257) }]));
    await until(() => [6, 7, 8].every((i) => replyTo(f.channel, i) !== undefined), "replies");
    assert.equal(replyTo(f.channel, 6).result, null);
    assert.equal(replyTo(f.channel, 7).error.code, -32602);
    assert.equal(replyTo(f.channel, 8).error.code, -32602);

    // Four registrations share one physical watcher: one write is one change, not four.
    await sleep(100);
    const file = join(f.root, "One.java");
    await writeFromOtherProcess(file, "class One {}");
    await until(() => watched(f.channel).length > 0, "didChangeWatchedFiles");
    await sleep(300);
    const created = watched(f.channel)
      .flatMap((m) => m.params.changes as { uri: string; type: number }[])
      .filter((c) => c.uri === pathToFileURL(file).href && c.type === 1);
    assert.equal(created.length, 1);
    assert.deepEqual(f.client.watchStatus(), { state: "watching" });
  } finally {
    f.cleanup();
  }
});

test("a registration that arrives after the client closed is refused and starts nothing", async () => {
  const f = fixture(() => undefined);
  try {
    await f.start();
    f.channel.emitClose({ kind: "exited", code: 1, signal: null });
    f.channel.respond(registerOne(9, "late", [{ globPattern: "**/*.java" }]));
    await until(() => replyTo(f.channel, 9) !== undefined, "refusal");
    assert.ok(replyTo(f.channel, 9).error);
    assert.deepEqual(f.client.watchStatus(), { state: "off" });
  } finally {
    f.cleanup();
  }
});

test("a root that may not be watched degrades, and each request is preceded by a root change", async () => {
  const f = fixture(registerJavaWatcher(1), realpathSync("/"));
  try {
    await f.start();
    await until(() => replyTo(f.channel, 1) !== undefined, "registration reply");
    assert.equal(replyTo(f.channel, 1).result, null, "the registration itself is accepted");
    await until(() => f.client.watchStatus().state === "degraded", "degraded state");
    const status = f.client.watchStatus();
    assert.ok(status.state === "degraded" && /filesystem root/.test(status.reason));

    const before = f.channel.sent.length;
    await f.client.request("exeris/domains").catch(() => undefined);
    const after = f.channel.sent.slice(before);
    const notificationAt = after.findIndex((m) => m.method === "workspace/didChangeWatchedFiles");
    const requestAt = after.findIndex((m) => m.method === "exeris/domains");
    assert.ok(notificationAt !== -1 && requestAt !== -1 && notificationAt < requestAt);
    assert.deepEqual(after[notificationAt].params.changes, [{ uri: "file:///", type: 2 }]);

    // Every request, not only the first.
    const mark = f.channel.sent.length;
    await f.client.request("exeris/domains").catch(() => undefined);
    const again = f.channel.sent.slice(mark);
    assert.equal(again[0].method, "workspace/didChangeWatchedFiles");
    assert.equal(again[1].method, "exeris/domains");
  } finally {
    f.cleanup();
  }
});

test("a retried handshake closes the previous attempt's channel", async () => {
  const first = new FakeChannel(); // never answers initialize
  const second = new FakeChannel();
  second.autoResponder = ackInitialize;
  const channels = [first, second];
  const client = new LspClient(SPEC, { channelFactory: () => channels.shift() as FakeChannel, requestTimeoutMs: 100 });
  try {
    await assert.rejects(client.request("noop"));
    await client.request("noop").catch(() => undefined);
    assert.equal(first.closed, true);
    // The first child exiting late does not take the new client down.
    first.emitClose({ kind: "exited", code: 0, signal: null });
    assert.notEqual(client.status().state, "closed");
  } finally {
    client.dispose();
  }
});
