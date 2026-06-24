import { strict as assert } from "node:assert";
import { test } from "node:test";

import { encodeMessage, LspMessageDecoder } from "./lsp-framing.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  LspChannel,
  LspClient,
  LspCloseReason,
  LspRequestError,
  LspTransportError,
} from "./lsp-client.js";

const SPEC = { command: "lsp-stub", args: ["--demo"] };

/** Flush the microtask/timer queue so the lazy handshake + dispatch settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Scriptable in-memory channel. Decodes what the client writes, lets a test
 * inspect those messages and push framed responses / lifecycle events back.
 */
class FakeChannel implements LspChannel {
  readonly sent: any[] = [];
  private dataHandler: ((c: Buffer) => void) | null = null;
  private closeHandler: ((r: LspCloseReason) => void) | null = null;
  private readonly decoder = new LspMessageDecoder();
  closed = false;

  /** Optional auto-responder invoked for every message the client sends. */
  autoResponder: ((msg: any) => unknown | undefined) | null = null;

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
  onClose(handler: (r: LspCloseReason) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }

  respond(message: unknown): void {
    this.dataHandler?.(encodeMessage(message));
  }
  emitClose(reason: LspCloseReason): void {
    this.closeHandler?.(reason);
  }
}

/** Auto-responder that ACKs `initialize` and nothing else. */
function ackInitialize(msg: any): unknown | undefined {
  if (msg.method === "initialize") return { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } };
  return undefined;
}

test("request performs the initialize handshake before the first call", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = (msg) => {
    if (msg.method === "initialize") return { jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } };
    if (msg.method === "exeris/domains")
      return { jsonrpc: "2.0", id: msg.id, result: ["A", "B"] };
    return undefined;
  };
  const client = new LspClient(SPEC, { channelFactory: () => channel });

  const result = await client.request("exeris/domains");
  assert.deepEqual(result, ["A", "B"]);

  // initialize request + initialized notification precede the real request.
  assert.equal(channel.sent[0].method, "initialize");
  assert.equal(channel.sent[1].method, "initialized");
  assert.equal(channel.sent[1].id, undefined); // notification carries no id
  assert.equal(channel.sent[2].method, "exeris/domains");
});

test("initialize sends rootUri as a file URI when workspaceRoot is set, null otherwise", async () => {
  // Responds to every message (incl. the trailing call) so no request is left pending.
  const respondAll = (msg: any) => ({ jsonrpc: "2.0", id: msg.id, result: [] });

  const withRoot = new FakeChannel();
  withRoot.autoResponder = respondAll;
  const client = new LspClient(
    { ...SPEC, workspaceRoot: "/srv/project" },
    { channelFactory: () => withRoot },
  );
  await client.request("exeris/domains");
  assert.equal(withRoot.sent[0].method, "initialize");
  assert.equal(withRoot.sent[0].params.rootUri, "file:///srv/project");

  const noRoot = new FakeChannel();
  noRoot.autoResponder = respondAll;
  const plain = new LspClient(SPEC, { channelFactory: () => noRoot });
  await plain.request("exeris/domains");
  assert.equal(noRoot.sent[0].params.rootUri, null);
});

test("the handshake runs once across concurrent requests", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = (msg) => ({ jsonrpc: "2.0", id: msg.id, result: msg.method });
  const client = new LspClient(SPEC, { channelFactory: () => channel });

  await Promise.all([client.request("a"), client.request("b"), client.request("c")]);
  const initializes = channel.sent.filter((m) => m.method === "initialize");
  assert.equal(initializes.length, 1);
});

test("a JSON-RPC error response rejects with LspRequestError carrying the code", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = (msg) => {
    if (msg.method === "initialize") return ackInitialize(msg);
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" },
    };
  };
  const client = new LspClient(SPEC, { channelFactory: () => channel });

  await assert.rejects(client.request("exeris/domains"), (err: unknown) => {
    assert.ok(err instanceof LspRequestError);
    assert.equal(err.code, JSONRPC_METHOD_NOT_FOUND);
    return true;
  });
});

test("a spawn failure rejects with LspTransportError naming the command", async () => {
  const client = new LspClient(SPEC, {
    channelFactory: () => {
      throw new Error("ENOENT: lsp-stub not found");
    },
  });

  await assert.rejects(client.request("exeris/domains"), (err: unknown) => {
    assert.ok(err instanceof LspTransportError);
    assert.match(err.message, /lsp-stub --demo/);
    assert.match(err.message, /ENOENT/);
    return true;
  });
});

test("a premature exit rejects in-flight requests with LspTransportError", async () => {
  const channel = new FakeChannel();
  // ACK initialize, but never answer the real request — then crash.
  channel.autoResponder = ackInitialize;
  const client = new LspClient(SPEC, { channelFactory: () => channel });

  const inflight = client.request("exeris/domains");
  await flush(); // let the handshake settle so the request is truly pending
  channel.emitClose({ kind: "exited", code: 1, signal: null });

  await assert.rejects(inflight, (err: unknown) => {
    assert.ok(err instanceof LspTransportError);
    assert.match(err.message, /exited.*code=1/);
    return true;
  });
});

test("after a crash, further requests fail fast without re-spawning", async () => {
  let spawns = 0;
  const channel = new FakeChannel();
  // Answer any request so the warmup completes and the client is fully started.
  channel.autoResponder = (msg) => ({ jsonrpc: "2.0", id: msg.id, result: null });
  const client = new LspClient(SPEC, {
    channelFactory: () => {
      spawns++;
      return channel;
    },
  });

  await client.request("warmup"); // force start + handshake
  channel.emitClose({ kind: "exited", code: 2, signal: null });
  await assert.rejects(client.request("exeris/domains"), LspTransportError);
  assert.equal(spawns, 1);
});

test("a request times out when the server never answers", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = ackInitialize; // handshake ok, real call hangs
  const client = new LspClient(SPEC, { channelFactory: () => channel, requestTimeoutMs: 20 });

  await assert.rejects(client.request("exeris/domains"), (err: unknown) => {
    assert.ok(err instanceof LspTransportError);
    assert.match(err.message, /timed out after 20ms/);
    return true;
  });
});

test("dispose rejects in-flight requests and closes the channel", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = ackInitialize;
  const client = new LspClient(SPEC, { channelFactory: () => channel });

  const inflight = client.request("exeris/domains");
  client.dispose();

  await assert.rejects(inflight, LspTransportError);
  assert.equal(channel.closed, true);
});

test("a synchronous write failure rejects the request instead of stranding it", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = ackInitialize;
  // Let the handshake (write #1 initialize, #2 initialized notify) through, then
  // make the real request's write throw — mimicking a synchronous stdin EPIPE.
  const originalWrite = channel.write.bind(channel);
  let writes = 0;
  channel.write = (chunk) => {
    if (++writes === 3) throw new Error("EPIPE: stdin closed");
    originalWrite(chunk);
  };
  const client = new LspClient(SPEC, { channelFactory: () => channel });

  await assert.rejects(client.request("exeris/domains"), (err: unknown) => {
    assert.ok(err instanceof LspTransportError);
    assert.match(err.message, /Failed to write to LSP server.*EPIPE/);
    return true;
  });
});

test("a hung handshake does not pin the client — a later request re-spawns", async () => {
  let spawns = 0;
  const client = new LspClient(SPEC, {
    channelFactory: () => {
      spawns++;
      const channel = new FakeChannel();
      // First spawn never acks initialize (handshake hangs → times out). Second
      // spawn acks everything so the retry succeeds.
      channel.autoResponder = spawns === 1 ? () => undefined : (msg) => ({ jsonrpc: "2.0", id: msg.id, result: "ok" });
      return channel;
    },
    requestTimeoutMs: 20,
  });

  await assert.rejects(client.request("exeris/domains"), LspTransportError);
  assert.equal(await client.request("exeris/domains"), "ok");
  assert.equal(spawns, 2);
});

test("correlates interleaved responses to the right request", async () => {
  const channel = new FakeChannel();
  const client = new LspClient(SPEC, { channelFactory: () => channel });
  // ACK initialize immediately; defer the two real responses, out of order.
  channel.autoResponder = (msg) => (msg.method === "initialize" ? ackInitialize(msg) : undefined);

  const first = client.request("first");
  const second = client.request("second");
  await flush(); // let both real requests get written before we reply
  const realCalls = channel.sent.filter((m) => m.method === "first" || m.method === "second");
  assert.equal(realCalls.length, 2);
  // Respond to the second request before the first.
  channel.respond({ jsonrpc: "2.0", id: realCalls[1].id, result: "B" });
  channel.respond({ jsonrpc: "2.0", id: realCalls[0].id, result: "A" });

  assert.equal(await first, "A");
  assert.equal(await second, "B");
});
