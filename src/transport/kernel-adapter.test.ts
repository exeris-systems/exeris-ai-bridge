import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  KernelAdapter,
  KernelChannel,
  KernelCloseReason,
  KernelRequestError,
  KernelTransportError,
} from "./kernel-adapter.js";
import { encodeLine, NdjsonDecoder } from "./ndjson-framing.js";

const SPEC = { command: "kernel-stub", args: ["--inspect"] };

/** Flush the microtask/timer queue so a lazy spawn + dispatch settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Scriptable in-memory NDJSON channel. Decodes what the adapter writes, lets a
 * test inspect those requests and push responses / lifecycle events back.
 */
class FakeChannel implements KernelChannel {
  readonly sent: any[] = [];
  private dataHandler: ((c: Buffer) => void) | null = null;
  private closeHandler: ((r: KernelCloseReason) => void) | null = null;
  private readonly decoder = new NdjsonDecoder();
  closed = false;

  /** Optional auto-responder invoked for every request the adapter sends. */
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
  onClose(handler: (r: KernelCloseReason) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }

  /** Push a raw response object as one NDJSON line. */
  respond(message: unknown): void {
    this.dataHandler?.(encodeLine(message));
  }
  /** Push arbitrary bytes (for framing-desync tests). */
  raw(bytes: string): void {
    this.dataHandler?.(Buffer.from(bytes, "utf8"));
  }
  emitClose(reason: KernelCloseReason): void {
    this.closeHandler?.(reason);
  }
}

const PROVIDERS = { schemaVersion: "1.0", capturedAt: "2026-06-25T00:00:00Z", providers: [] };

test("request sends {method} and resolves with the response object", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = (msg) => (msg.method === "listProviders" ? PROVIDERS : undefined);
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  const result = await adapter.request("listProviders");
  assert.deepEqual(result, PROVIDERS);
  assert.deepEqual(channel.sent[0], { method: "listProviders" });
});

test("request merges params flat alongside method", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = (msg) => ({ requestedName: msg.name, subsystem: null });
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  await adapter.request("describeSubsystem", { name: "memory" });
  assert.deepEqual(channel.sent[0], { method: "describeSubsystem", name: "memory" });
});

test("an {error} response rejects with KernelRequestError carrying the message", async () => {
  const channel = new FakeChannel();
  channel.autoResponder = () => ({ error: "unknown method: bogus" });
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  await assert.rejects(adapter.request("bogus"), (err: unknown) => {
    assert.ok(err instanceof KernelRequestError);
    assert.match(err.message, /unknown method: bogus/);
    return true;
  });
});

test("responses correlate FIFO across pipelined requests", async () => {
  const channel = new FakeChannel();
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  const first = adapter.request("a");
  const second = adapter.request("b");
  await flush(); // both requests written before any reply
  assert.deepEqual(
    channel.sent.map((m) => m.method),
    ["a", "b"],
  );
  // Answer in receipt order — the only correlation the id-less protocol offers.
  channel.respond({ value: "A" });
  channel.respond({ value: "B" });

  assert.deepEqual(await first, { value: "A" });
  assert.deepEqual(await second, { value: "B" });
});

test("a spawn failure rejects with KernelTransportError naming the command", async () => {
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => {
      throw new Error("ENOENT: kernel-stub not found");
    },
  });

  await assert.rejects(adapter.request("listProviders"), (err: unknown) => {
    assert.ok(err instanceof KernelTransportError);
    assert.match(err.message, /kernel-stub --inspect/);
    assert.match(err.message, /ENOENT/);
    return true;
  });
});

test("a premature exit rejects in-flight requests and is sticky (no re-spawn)", async () => {
  let spawns = 0;
  const channel = new FakeChannel();
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => {
      spawns++;
      return channel;
    },
  });

  const inflight = adapter.request("listProviders");
  await flush();
  channel.emitClose({ kind: "exited", code: 1, signal: null });

  await assert.rejects(inflight, (err: unknown) => {
    assert.ok(err instanceof KernelTransportError);
    assert.match(err.message, /exited.*code=1/);
    return true;
  });
  // A later request fails fast against the sticky reason — no spawn storm.
  await assert.rejects(adapter.request("listProviders"), KernelTransportError);
  assert.equal(spawns, 1);
});

test("a request timeout soft-resets and a later request re-spawns clean", async () => {
  let spawns = 0;
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => {
      spawns++;
      const channel = new FakeChannel();
      // First child never answers (→ timeout); second answers everything.
      channel.autoResponder = spawns === 1 ? () => undefined : () => PROVIDERS;
      return channel;
    },
    requestTimeoutMs: 20,
  });

  await assert.rejects(adapter.request("listProviders"), (err: unknown) => {
    assert.ok(err instanceof KernelTransportError);
    assert.match(err.message, /timed out after 20ms/);
    return true;
  });
  assert.deepEqual(await adapter.request("listProviders"), PROVIDERS);
  assert.equal(spawns, 2);
});

test("a late response from a timed-out child cannot misalign the next request", async () => {
  const channels: FakeChannel[] = [];
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    },
    requestTimeoutMs: 20,
  });

  await assert.rejects(adapter.request("slow"), KernelTransportError); // first child times out
  const second = adapter.request("listProviders"); // re-spawns onto channels[1]
  await flush();
  // The first (killed) child belatedly emits a response — it must be ignored,
  // not delivered to the second request.
  channels[0].respond({ value: "STALE" });
  channels[1].respond(PROVIDERS);
  assert.deepEqual(await second, PROVIDERS);
});

test("framing desync soft-resets; the next request re-spawns", async () => {
  let spawns = 0;
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => {
      spawns++;
      const channel = new FakeChannel();
      if (spawns === 1) {
        // Garbage on stdout (e.g. a Maven banner) desyncs the first stream.
        channel.autoResponder = () => {
          channel.raw("<<< not json >>>\n");
          return undefined;
        };
      } else {
        channel.autoResponder = () => PROVIDERS;
      }
      return channel;
    },
  });

  await assert.rejects(adapter.request("listProviders"), (err: unknown) => {
    assert.ok(err instanceof KernelTransportError);
    assert.match(err.message, /framing error/);
    return true;
  });
  assert.deepEqual(await adapter.request("listProviders"), PROVIDERS);
  assert.equal(spawns, 2);
});

test("dispose rejects in-flight requests and closes the channel", async () => {
  const channel = new FakeChannel();
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  const inflight = adapter.request("listProviders");
  adapter.dispose();

  await assert.rejects(inflight, KernelTransportError);
  assert.equal(channel.closed, true);
  await assert.rejects(adapter.request("listProviders"), /disposed/);
});

test("a synchronous write failure rejects the request instead of stranding it", async () => {
  const channel = new FakeChannel();
  const originalWrite = channel.write.bind(channel);
  let writes = 0;
  channel.write = (chunk) => {
    if (++writes === 1) throw new Error("EPIPE: stdin closed");
    originalWrite(chunk);
  };
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  await assert.rejects(adapter.request("listProviders"), (err: unknown) => {
    assert.ok(err instanceof KernelTransportError);
    assert.match(err.message, /Failed to write to kernel CLI.*EPIPE/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// status() — the non-spawning view bridge:health reads (ROADMAP 0.5.0)

test("status() reports not-started without spawning, then running after a request", async () => {
  let spawns = 0;
  const channel = new FakeChannel();
  channel.autoResponder = () => PROVIDERS;
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => {
      spawns++;
      return channel;
    },
  });

  assert.deepEqual(adapter.status(), { state: "not-started", closeReason: null, lastSoftReset: null });
  adapter.status();
  adapter.status();
  assert.equal(spawns, 0, "status() must never spawn");

  await adapter.request("listProviders");
  assert.equal(adapter.status().state, "running");
  assert.equal(spawns, 1);
});

test("status() reports a sticky hard close with its reason", async () => {
  const channel = new FakeChannel();
  const adapter = new KernelAdapter(SPEC, { channelFactory: () => channel });

  const pending = adapter.request("listProviders");
  await flush();
  channel.emitClose({ kind: "exited", code: 2, signal: null });
  await assert.rejects(pending, KernelTransportError);

  const status = adapter.status();
  assert.equal(status.state, "closed");
  assert.deepEqual(status.closeReason, { kind: "exited", code: 2, signal: null });
});

test("status() surfaces a soft reset, which otherwise looks like never having run", async () => {
  // A soft reset drops the channel and leaves closeReason null so the next call
  // re-spawns — indistinguishable from "not-started" without lastSoftReset.
  const adapter = new KernelAdapter(SPEC, {
    channelFactory: () => new FakeChannel(), // never answers
    requestTimeoutMs: 20,
  });

  await assert.rejects(adapter.request("listProviders"), KernelTransportError);

  const status = adapter.status();
  assert.equal(status.state, "not-started");
  assert.equal(status.closeReason, null);
  assert.match(status.lastSoftReset ?? "", /timed out after 20ms/);
});
