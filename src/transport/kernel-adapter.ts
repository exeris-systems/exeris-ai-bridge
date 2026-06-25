import { spawn } from "node:child_process";

import { encodeLine, NdjsonDecoder, NdjsonFramingError } from "./ndjson-framing.js";

// Node-side adapter for a child exeris-kernel-diagnostics-cli process, over
// NDJSON (see ndjson-framing.ts). This is the bridge's ONLY path to a running
// kernel — a separate process in a separate language — which is how the
// kernel:* family preserves The Wall (ADR-006) by construction.
//
// The CLI is stateless and read-only: it boots the kernel in inspect mode,
// reads one JSON request line on stdin, and writes one response line per
// request on stdout, in order, with NO id field. Responsibilities here:
//   - lazy spawn on first request, cached for the session (no handshake)
//   - FIFO request/response correlation (the protocol has no ids; ordering is
//     the contract)
//   - resilient failure with two recovery modes:
//       * hard close (CLI gone: spawn-error / exited / disposed) — sticky, the
//         adapter fails fast on every later call, no spawn storm
//       * soft reset (request timeout / framing desync) — the current child is
//         killed and the NEXT call re-spawns clean. Necessary because a dropped
//         or desynced response would otherwise misalign the id-less FIFO, and
//         because a slow cold JVM boot must not permanently brick kernel:*.
//
// Scope is runtime kernel state only and cap-blind (ADR-024 / ADR-025) — see
// ../tools/kernel/index.ts. The adapter is a dumb transport; it does not know
// the diagnostics methods.

/** Why an adapter was torn down. Hard reasons are sticky; soft reasons re-spawn. */
export type KernelCloseReason =
  | { kind: "spawn-error"; message: string }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "disposed" };

/**
 * Minimal byte-channel to the diagnostics CLI. The production factory wraps
 * `child_process.spawn`; tests provide a fake to drive responses, timeouts,
 * framing desync, and crashes deterministically without a real JVM.
 */
export interface KernelChannel {
  write(chunk: Buffer): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: (reason: KernelCloseReason) => void): void;
  close(): void;
}

export interface KernelLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export type KernelChannelFactory = (spec: KernelLaunchSpec) => KernelChannel;

/** An `{"error": "..."}` response from the CLI (unknown method, bad args, ...). */
export class KernelRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelRequestError";
  }
}

/** The transport is unusable — CLI unreachable, crashed, desynced, or disposed. */
export class KernelTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelTransportError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface KernelAdapterOptions {
  readonly requestTimeoutMs?: number;
  /** Injected for tests; defaults to a real child-process channel. */
  readonly channelFactory?: KernelChannelFactory;
}

export class KernelAdapter {
  private readonly spec: KernelLaunchSpec;
  private readonly factory: KernelChannelFactory;
  private readonly requestTimeoutMs: number;

  private channel: KernelChannel | null = null;
  private decoder = new NdjsonDecoder();
  // Sticky terminal reason (hard close only). Soft resets leave this null so the
  // next request re-spawns.
  private closeReason: KernelCloseReason | null = null;
  // Bumped on every spawn and on every soft reset, so a callback delivered late
  // by a killed child (its async 'exit', a trailing stdout chunk) is ignored
  // instead of corrupting the state of the channel that replaced it.
  private epoch = 0;
  // FIFO queue: the CLI answers requests in receipt order with no id to match
  // on, so the oldest unanswered request owns the next response.
  private readonly pending: PendingRequest[] = [];

  constructor(spec: KernelLaunchSpec, options: KernelAdapterOptions = {}) {
    this.spec = spec;
    this.factory = options.channelFactory ?? defaultChannelFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Send one NDJSON request, lazily spawning the CLI on first use. `params` is
   * merged flat into the request object alongside `method` (the CLI reads e.g.
   * `name` as a sibling of `method`). Resolves with the parsed response object;
   * rejects with KernelRequestError for an `{"error": ...}` response, or
   * KernelTransportError for unreachable/crashed/desynced/timeout.
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closeReason !== null) {
      return Promise.reject(this.transportErrorForClose(this.closeReason));
    }
    if (this.channel === null && !this.start()) {
      return Promise.reject(this.transportErrorForClose(this.closeReason!));
    }
    const channel = this.channel!;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // No ids: a late response to a timed-out request would be matched to the
        // wrong caller. Soft-reset so the next call re-spawns clean.
        this.softReset(
          new KernelTransportError(
            `kernel request '${method}' timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      // NOTE: the timer is intentionally NOT unref'd — see the same note in
      // lsp-client.ts. An in-flight request must keep the loop alive long enough
      // to deliver its own timeout rejection.
      this.pending.push({ method, resolve, reject, timer });
      try {
        channel.write(encodeLine(params ? { method, ...params } : { method }));
      } catch (cause) {
        // A synchronous write failure (EPIPE on dead stdin) must not strand the
        // entry until timeout. It is the tail we just pushed, so popping it keeps
        // the FIFO consistent; fail it now.
        clearTimeout(timer);
        this.pending.pop();
        const message = cause instanceof Error ? cause.message : String(cause);
        reject(new KernelTransportError(`Failed to write to kernel CLI: ${message}`));
      }
    });
  }

  /** Terminate the CLI and reject all in-flight requests. Sticky. Idempotent. */
  dispose(): void {
    this.hardClose({ kind: "disposed" });
  }

  /** Spawn + wire the channel. Returns false (and sets closeReason) on failure. */
  private start(): boolean {
    const epoch = ++this.epoch;
    try {
      this.channel = this.factory(this.spec);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.closeReason = { kind: "spawn-error", message };
      return false;
    }
    this.decoder = new NdjsonDecoder();
    // Guard every callback on its spawn epoch: a stale child that we already
    // soft-reset must not touch the live channel.
    this.channel.onData((chunk) => {
      if (epoch === this.epoch) this.onData(chunk);
    });
    this.channel.onClose((reason) => {
      if (epoch === this.epoch) this.hardClose(reason);
    });
    return true;
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (cause) {
      // Framing desync is unrecoverable for the current stream — soft-reset so
      // the next call re-spawns rather than reading garbage forever.
      const message = cause instanceof NdjsonFramingError ? cause.message : String(cause);
      this.softReset(new KernelTransportError(`Kernel diagnostics CLI framing error: ${message}`));
      return;
    }
    for (const message of messages) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return; // not a response object — ignore
    }
    const pending = this.pending.shift();
    if (pending === undefined) {
      return; // unsolicited line (e.g. a banner that slipped onto stdout) — ignore
    }
    clearTimeout(pending.timer);
    const error = (message as { error?: unknown }).error;
    if (typeof error === "string") {
      pending.reject(new KernelRequestError(error));
      return;
    }
    pending.resolve(message);
  }

  /** Sticky teardown: the CLI is gone. Fail fast on every later request. */
  private hardClose(reason: KernelCloseReason): void {
    if (this.closeReason === null) this.closeReason = reason;
    this.rejectAllPending(this.transportErrorForClose(reason));
    this.channel?.close();
    this.channel = null;
  }

  /** Recoverable teardown: kill the current child; the next request re-spawns. */
  private softReset(err: KernelTransportError): void {
    this.rejectAllPending(err);
    this.epoch++; // invalidate the dying child's callbacks
    this.channel?.close();
    this.channel = null;
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.length = 0;
  }

  private transportErrorForClose(reason: KernelCloseReason): KernelTransportError {
    switch (reason.kind) {
      case "spawn-error":
        return new KernelTransportError(
          `Cannot reach kernel diagnostics CLI (command: ${this.describeCommand()}): ${reason.message}`,
        );
      case "exited":
        return new KernelTransportError(
          `Kernel diagnostics CLI exited (code=${reason.code}, signal=${reason.signal ?? "none"}) — command: ${this.describeCommand()}`,
        );
      case "disposed":
        return new KernelTransportError("Kernel adapter was disposed");
    }
  }

  private describeCommand(): string {
    return [this.spec.command, ...this.spec.args].join(" ");
  }
}

/** Production channel: spawn the CLI and adapt its stdio streams. */
function defaultChannelFactory(spec: KernelLaunchSpec): KernelChannel {
  // stdin/stdout are pipes we own (the NDJSON channel). stderr is INHERITED,
  // not piped: the CLI's JVM/Maven logging flows to the bridge's own stderr
  // (visible in the host's MCP logs) and — crucially — an inherited fd cannot
  // fill a pipe buffer and deadlock the child. stdout is reserved for NDJSON.
  const child = spawn(spec.command, [...spec.args], { stdio: ["pipe", "pipe", "inherit"] });
  return {
    write: (chunk) => {
      child.stdin.write(chunk);
    },
    onData: (handler) => {
      child.stdout.on("data", handler);
    },
    onClose: (handler) => {
      child.on("error", (err) => handler({ kind: "spawn-error", message: err.message }));
      child.on("exit", (code, signal) => handler({ kind: "exited", code, signal }));
      // A write to a dead CLI surfaces as an async 'error' (EPIPE) on stdin, not
      // a throw from write(). Without this listener Node escalates it to an
      // uncaught exception that takes down the whole bridge. Funnel it through
      // the same close path; a second reason after 'exit' is a no-op.
      child.stdin.on("error", (err) =>
        handler({ kind: "spawn-error", message: `kernel CLI stdin error: ${err.message}` }),
      );
    },
    close: () => {
      child.kill();
    },
  };
}
