import { spawn } from "node:child_process";

import { encodeMessage, LspMessageDecoder } from "./lsp-framing.js";

// JSON-RPC client for a child exeris-platform-lsp process, over the LSP
// base-protocol framing (see lsp-framing.ts). Responsibilities:
//   - lazy spawn on first request, cached for the session
//   - the LSP `initialize` / `initialized` handshake, awaited once
//   - request/response correlation by id, with a per-request timeout
//   - resilient failure: spawn errors, premature exit, and JSON-RPC errors
//     surface as typed rejections instead of crashing the bridge
//
// Phase 3a (ROADMAP 0.3.0) ships this transport WITHOUT the three custom
// requests it will eventually carry (`workspace/exerisDomains`, …Describe,
// …Actions) — those depend on a companion exeris-platform-lsp that does not
// yet implement them. Until it does, `request()` against an unknown method
// resolves to a JSON-RPC "method not found" error, which the lsp:* handlers
// translate into a structured "not yet supported" tool result.

/** Standard JSON-RPC error code for an unimplemented method. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

/** Why a client became permanently unusable. */
export type LspCloseReason =
  | { kind: "spawn-error"; message: string }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "disposed" };

/**
 * Minimal byte-channel to the language server. The production factory wraps
 * `child_process.spawn`; tests provide a fake to drive handshake, responses,
 * timeouts, and crashes deterministically without a real process.
 */
export interface LspChannel {
  write(chunk: Buffer): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: (reason: LspCloseReason) => void): void;
  close(): void;
}

export interface LspLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export type LspChannelFactory = (spec: LspLaunchSpec) => LspChannel;

/** A JSON-RPC error returned by the server (e.g. method not found). */
export class LspRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "LspRequestError";
  }
}

/** The transport is unusable — server unreachable, crashed, or disposed. */
export class LspTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspTransportError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspClientOptions {
  readonly requestTimeoutMs?: number;
  /** Injected for tests; defaults to a real child-process channel. */
  readonly channelFactory?: LspChannelFactory;
}

export class LspClient {
  private readonly spec: LspLaunchSpec;
  private readonly factory: LspChannelFactory;
  private readonly requestTimeoutMs: number;

  private channel: LspChannel | null = null;
  private decoder = new LspMessageDecoder();
  private startPromise: Promise<void> | null = null;
  private closeReason: LspCloseReason | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(spec: LspLaunchSpec, options: LspClientOptions = {}) {
    this.spec = spec;
    this.factory = options.channelFactory ?? defaultChannelFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Send a JSON-RPC request, lazily starting the server on first use.
   * Resolves with the `result`; rejects with LspRequestError for a JSON-RPC
   * error response, or LspTransportError for unreachable/crashed/timeout.
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.dispatch(method, params);
  }

  /** Terminate the server and reject all in-flight requests. Idempotent. */
  dispose(): void {
    this.failPendingAndClose({ kind: "disposed" });
    this.channel?.close();
    this.channel = null;
  }

  private ensureStarted(): Promise<void> {
    if (this.closeReason !== null) {
      return Promise.reject(this.transportErrorForClose(this.closeReason));
    }
    if (this.startPromise === null) {
      this.startPromise = this.start();
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    try {
      this.channel = this.factory(this.spec);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.closeReason = { kind: "spawn-error", message };
      throw this.transportErrorForClose(this.closeReason);
    }

    this.channel.onData((chunk) => this.onData(chunk));
    this.channel.onClose((reason) => this.failPendingAndClose(reason));

    // LSP handshake: initialize request, then the initialized notification.
    await this.dispatch("initialize", {
      processId: null,
      clientInfo: { name: "exeris-ai-bridge" },
      capabilities: {},
      rootUri: null,
    });
    this.notify("initialized", {});
  }

  private dispatch(method: string, params: unknown): Promise<unknown> {
    // A close that arrives mid-handshake (server crashes after acking
    // initialize) leaves the channel handle in place but closeReason set.
    // Reject here too, otherwise a request dispatched after close would
    // register a pending entry the dead server can never answer — hanging
    // until the request timeout instead of failing fast.
    if (this.closeReason !== null) {
      return Promise.reject(this.transportErrorForClose(this.closeReason));
    }
    if (this.channel === null) {
      return Promise.reject(new LspTransportError("LSP channel is not connected"));
    }
    const id = this.nextId++;
    const channel = this.channel;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspTransportError(`LSP request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      // Do not keep the event loop alive solely for a pending LSP timeout.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      channel.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    this.channel?.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (cause) {
      // Framing desync is unrecoverable — tear down so the next call retries
      // cleanly rather than reading garbage forever.
      const message = cause instanceof Error ? cause.message : String(cause);
      this.failPendingAndClose({ kind: "spawn-error", message: `LSP framing error: ${message}` });
      this.channel?.close();
      this.channel = null;
      return;
    }
    for (const message of messages) {
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const msg = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof msg.id !== "number") return; // notification / request from server — ignored in Phase 3a
    const pending = this.pending.get(msg.id);
    if (pending === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error !== undefined && msg.error !== null) {
      const err = msg.error as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof err.code === "number" ? err.code : 0;
      const text = typeof err.message === "string" ? err.message : "LSP request failed";
      pending.reject(new LspRequestError(code, text, err.data));
      return;
    }
    pending.resolve(msg.result);
  }

  private failPendingAndClose(reason: LspCloseReason): void {
    if (this.closeReason === null) this.closeReason = reason;
    const err = this.transportErrorForClose(reason);
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private transportErrorForClose(reason: LspCloseReason): LspTransportError {
    switch (reason.kind) {
      case "spawn-error":
        return new LspTransportError(
          `Cannot reach LSP server (command: ${this.describeCommand()}): ${reason.message}`,
        );
      case "exited":
        return new LspTransportError(
          `LSP server exited (code=${reason.code}, signal=${reason.signal ?? "none"}) — command: ${this.describeCommand()}`,
        );
      case "disposed":
        return new LspTransportError("LSP client was disposed");
    }
  }

  private describeCommand(): string {
    return [this.spec.command, ...this.spec.args].join(" ");
  }
}

/** Production channel: spawn the LSP server and adapt its stdio streams. */
function defaultChannelFactory(spec: LspLaunchSpec): LspChannel {
  const child = spawn(spec.command, [...spec.args], { stdio: ["pipe", "pipe", "pipe"] });
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
    },
    close: () => {
      child.kill();
    },
  };
}
