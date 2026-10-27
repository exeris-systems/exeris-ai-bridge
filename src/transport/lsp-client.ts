import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compileGlob,
  type WatchBatch,
  type WatchChangeType,
  type WatchHandle,
  watchRoot,
} from "../fs/watch.js";
import { encodeMessage, LspMessageDecoder } from "./lsp-framing.js";

// JSON-RPC client for a child exeris-platform-lsp process, over the LSP
// base-protocol framing (see lsp-framing.ts). Responsibilities:
//   - lazy spawn on first request, cached for the session
//   - the LSP `initialize` / `initialized` handshake, awaited once
//   - request/response correlation by id, with a per-request timeout
//   - resilient failure: spawn errors, premature exit, and JSON-RPC errors
//     surface as typed rejections instead of crashing the bridge
//
//   - watched files: the client advertises dynamic registration for
//     `workspace/didChangeWatchedFiles`, answers the server's
//     `client/registerCapability` by watching the pinned workspace root, and
//     forwards debounced events — so the server's cached scan is dropped when
//     another process writes the workspace
//
// If the server lacks a requested method, request() resolves to a JSON-RPC
// method not found error, which lsp:* handlers translate into a structured
// tool result.

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
  /**
   * Workspace root sent as `rootUri` in the `initialize` handshake so the
   * server indexes the right `@ExerisDomain` tree. Omitted/empty → `rootUri:
   * null` (server returns an empty index).
   */
  readonly workspaceRoot?: string | null;
}

export type LspChannelFactory = (spec: LspLaunchSpec) => LspChannel;

/**
 * A read-only view of the child process, for bridge:health. Reading it NEVER
 * spawns — that is the whole point: the diagnostic surface must be cheap enough
 * that an agent can call it freely, and it must not perturb what it reports.
 */
export interface LspStatus {
  readonly state: "not-started" | "starting" | "running" | "closed";
  /** The terminal reason, when the client is permanently unusable. */
  readonly closeReason: LspCloseReason | null;
  /**
   * Message of the most recent start attempt that failed WITHOUT a terminal
   * close — an `initialize` that timed out against a hung server, say. Such a
   * client is deliberately retryable and reads as "not-started" again, so
   * without this the failure would leave no trace at all.
   */
  readonly lastStartError: string | null;
}

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
const DEFAULT_WATCH_DEBOUNCE_MS = 200;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;
const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";

/** LSP FileChangeType values. */
const FILE_CHANGE_TYPE: Record<WatchChangeType, 1 | 2 | 3> = { created: 1, changed: 2, deleted: 3 };
/** LSP WatchKind bit for each change type; a watcher without `kind` wants all three. */
const WATCH_KIND_BIT: Record<WatchChangeType, number> = { created: 1, changed: 2, deleted: 4 };
const WATCH_KIND_ALL = 7;

type JsonRpcId = string | number;

/** Registrations held at once and watchers in one registration; the glob length cap is enforced by compileGlob. */
const MAX_REGISTRATIONS = 4;
const MAX_WATCHERS_PER_REGISTRATION = 32;

interface WatchRegistration {
  readonly watchers: readonly {
    readonly match: (relativePath: string) => boolean;
    readonly kinds: number;
    readonly glob: string;
  }[];
}

/** What the client's file watching is doing, for bridge-health. */
export type LspWatchStatus =
  | { readonly state: "off" }
  | { readonly state: "watching" }
  | { readonly state: "degraded"; readonly reason: string };

class RegistrationRefused extends Error {}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface LspClientOptions {
  readonly requestTimeoutMs?: number;
  /** Injected for tests; defaults to a real child-process channel. */
  readonly channelFactory?: LspChannelFactory;
  /** Quiet period before filesystem events are forwarded to the server. Default 200 ms. */
  readonly watchDebounceMs?: number;
}

export class LspClient {
  private readonly spec: LspLaunchSpec;
  private readonly factory: LspChannelFactory;
  private readonly requestTimeoutMs: number;
  private readonly watchDebounceMs: number;
  // One physical watcher on the pinned root, shared by every registration: a
  // registration adds only its matchers.
  private readonly registrations = new Map<string, WatchRegistration>();
  private physicalWatcher: WatchHandle | null = null;
  private watchDegradedReason: string | null = null;

  private channel: LspChannel | null = null;
  private decoder = new LspMessageDecoder();
  private startPromise: Promise<void> | null = null;
  private handshakeComplete = false;
  private lastStartError: string | null = null;
  private closeReason: LspCloseReason | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(spec: LspLaunchSpec, options: LspClientOptions = {}) {
    this.spec = spec;
    this.factory = options.channelFactory ?? defaultChannelFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  }

  /**
   * Send a JSON-RPC request, lazily starting the server on first use.
   * Resolves with the `result`; rejects with LspRequestError for a JSON-RPC
   * error response, or LspTransportError for unreachable/crashed/timeout.
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    // Without a trustworthy watcher the server's cached scan cannot be known to
    // be current, so each request is preceded by an invalidation of it.
    if (this.watchDegradedReason !== null && this.registrations.size > 0) this.notifyRootChanged();
    return this.dispatch(method, params);
  }

  /** The state of file watching, without touching the child. */
  watchStatus(): LspWatchStatus {
    if (this.registrations.size === 0) return { state: "off" };
    if (this.watchDegradedReason !== null) return { state: "degraded", reason: this.watchDegradedReason };
    return { state: "watching" };
  }

  /**
   * Current transport state, without touching the child. Safe to call before
   * any request — it reports "not-started" rather than starting anything.
   */
  status(): LspStatus {
    if (this.closeReason !== null) {
      return { state: "closed", closeReason: this.closeReason, lastStartError: this.lastStartError };
    }
    if (this.startPromise === null) {
      return { state: "not-started", closeReason: null, lastStartError: this.lastStartError };
    }
    return {
      state: this.handshakeComplete ? "running" : "starting",
      closeReason: null,
      lastStartError: this.lastStartError,
    };
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
      this.startPromise = this.start().catch((err: unknown) => {
        // A handshake that fails WITHOUT a terminal close — e.g. `initialize`
        // times out while the server hangs — would otherwise pin the client to
        // a permanently rejected startPromise, so every later request replays
        // the stale error with no re-spawn. Clear it so the next request can
        // retry. Spawn-error / exit set closeReason and are intentionally sticky.
        if (this.closeReason === null) {
          this.startPromise = null;
          // Retryable failures leave no other trace: closeReason stays null and
          // status() falls back to "not-started". Record it so bridge:health can
          // say the handshake was tried and failed.
          this.lastStartError = err instanceof Error ? err.message : String(err);
        }
        throw err;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    // A retried handshake must not leave the previous attempt's child or
    // watchers behind.
    this.stopWatchers();
    this.channel?.close();
    this.channel = null;
    this.decoder = new LspMessageDecoder();
    try {
      this.channel = this.factory(this.spec);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.closeReason = { kind: "spawn-error", message };
      throw this.transportErrorForClose(this.closeReason);
    }

    const channel = this.channel;
    // A superseded channel's late data or exit must not act on its successor.
    channel.onData((chunk) => {
      if (this.channel === channel) this.onData(chunk);
    });
    channel.onClose((reason) => {
      if (this.channel === channel) this.failPendingAndClose(reason);
    });

    // LSP handshake: initialize request, then the initialized notification.
    const root = this.spec.workspaceRoot;
    await this.dispatch("initialize", {
      processId: null,
      clientInfo: { name: "exeris-ai-bridge" },
      capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
      rootUri: root ? pathToFileURL(root).href : null,
    });
    this.notify("initialized", {});
    this.handshakeComplete = true;
    this.lastStartError = null;
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
      // NOTE: the timer is intentionally NOT unref'd. While a request is
      // in-flight it is the one thing that must keep the process alive long
      // enough to deliver the timeout rejection to the awaiting caller; an
      // unref'd timer let Node's test child exit before firing (node 20/22),
      // cancelling the timeout test. In production the stdio transport keeps
      // the loop alive regardless, so this costs nothing there.
      this.pending.set(id, { resolve, reject, timer });
      try {
        channel.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
      } catch (cause) {
        // A synchronous write failure (e.g. EPIPE on a dead stdin) must not
        // strand the pending entry until the timeout — fail the request now.
        clearTimeout(timer);
        this.pending.delete(id);
        const message = cause instanceof Error ? cause.message : String(cause);
        reject(new LspTransportError(`Failed to write to LSP server: ${message}`));
      }
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
    const msg = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof msg.method === "string") {
      // A server-to-client request carries both id and method; without an id it
      // is a notification, which this client has no use for.
      if (typeof msg.id === "string" || typeof msg.id === "number") {
        this.handleServerRequest(msg.id, msg.method, msg.params);
      }
      return;
    }
    if (typeof msg.id !== "number") return;
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

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (this.closeReason !== null || this.channel === null) {
      this.replyError(id, JSONRPC_INTERNAL_ERROR, "LSP client is closed");
      return;
    }
    switch (method) {
      case "client/registerCapability":
        this.registerCapability(id, params);
        return;
      case "client/unregisterCapability":
        this.unregisterCapability(id, params);
        return;
      default:
        this.replyError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private registerCapability(id: JsonRpcId, params: unknown): void {
    const list = (params as { registrations?: unknown } | null)?.registrations;
    if (!Array.isArray(list)) {
      this.replyError(id, JSONRPC_INVALID_PARAMS, "registrations must be an array");
      return;
    }
    // Validate everything first, commit after: a refused registration changes nothing.
    const staged = new Map<string, WatchRegistration>();
    try {
      for (const raw of list) {
        const reg = raw as { id?: unknown; method?: unknown; registerOptions?: unknown };
        // Only watched files are supported; other registrations are accepted and ignored.
        if (reg.method !== WATCHED_FILES_METHOD) continue;
        if (typeof reg.id !== "string") throw new RegistrationRefused("registration id must be a string");
        staged.set(reg.id, this.parseRegistration(reg.registerOptions));
      }
      const total = new Set([...this.registrations.keys(), ...staged.keys()]).size;
      if (total > MAX_REGISTRATIONS) {
        throw new RegistrationRefused(`more than ${MAX_REGISTRATIONS} file-watch registrations`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`[exeris-ai-bridge] LSP file-watch registration refused: ${message}\n`);
      this.replyError(id, JSONRPC_INVALID_PARAMS, `File-watch registration refused: ${message}`);
      return;
    }
    if (staged.size > 0) {
      for (const [regId, reg] of staged) this.registrations.set(regId, reg);
      this.ensurePhysicalWatcher();
      this.physicalWatcher?.setGlobs(this.allGlobs());
    }
    this.replyResult(id, null);
  }

  private unregisterCapability(id: JsonRpcId, params: unknown): void {
    // The LSP spec spells this field "unregisterations".
    const list = (params as { unregisterations?: unknown } | null)?.unregisterations;
    if (!Array.isArray(list)) {
      this.replyError(id, JSONRPC_INVALID_PARAMS, "unregisterations must be an array");
      return;
    }
    for (const raw of list) {
      const unreg = raw as { id?: unknown };
      if (typeof unreg.id === "string") this.registrations.delete(unreg.id);
    }
    if (this.registrations.size === 0) this.stopWatchers();
    else this.physicalWatcher?.setGlobs(this.allGlobs());
    this.replyResult(id, null);
  }

  /** Parse one registration's watchers, confined to the pinned workspace root. */
  private parseRegistration(registerOptions: unknown): WatchRegistration {
    const root = this.spec.workspaceRoot;
    if (!root) throw new RegistrationRefused("no workspace root is pinned");
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      throw new RegistrationRefused("the workspace root does not resolve to a directory");
    }
    const entries = (registerOptions as { watchers?: unknown } | null)?.watchers;
    if (!Array.isArray(entries)) throw new RegistrationRefused("registerOptions.watchers must be an array");
    if (entries.length === 0) throw new RegistrationRefused("no watchers registered");
    if (entries.length > MAX_WATCHERS_PER_REGISTRATION) {
      throw new RegistrationRefused(`more than ${MAX_WATCHERS_PER_REGISTRATION} watchers in one registration`);
    }
    const watchers = entries.map((raw) => {
      const w = raw as { globPattern?: unknown; kind?: unknown };
      const glob = globForWatcher(realRoot, w.globPattern);
      let match: (relativePath: string) => boolean;
      try {
        match = compileGlob(glob);
      } catch (cause) {
        throw new RegistrationRefused(cause instanceof Error ? cause.message : String(cause));
      }
      return { glob, match, kinds: typeof w.kind === "number" ? w.kind : WATCH_KIND_ALL };
    });
    return { watchers };
  }

  private allGlobs(): string[] {
    return [...this.registrations.values()].flatMap((r) => r.watchers.map((w) => w.glob));
  }

  /** Start the one physical watcher on the pinned root, unless it exists or watching already degraded. */
  private ensurePhysicalWatcher(): void {
    if (this.physicalWatcher !== null || this.watchDegradedReason !== null) return;
    const root = this.spec.workspaceRoot;
    if (!root) return;
    try {
      const handle = watchRoot(root, {
        globs: this.allGlobs(),
        debounceMs: this.watchDebounceMs,
        onEvents: (batch) => this.forwardWatchBatch(batch, handle.root),
        onDegraded: (reason) => this.onWatchDegraded(reason),
      });
      this.physicalWatcher = handle;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.onWatchDegraded(`cannot start the workspace watcher (${message})`);
    }
  }

  private onWatchDegraded(reason: string): void {
    if (this.watchDegradedReason !== null) return;
    this.watchDegradedReason = reason;
    this.physicalWatcher?.close();
    this.physicalWatcher = null;
    // Whatever changed while the watch was failing is unknown: invalidate now,
    // then before every request.
    this.notifyRootChanged();
  }

  private notifyRootChanged(): void {
    if (this.closeReason !== null || this.channel === null || !this.handshakeComplete) return;
    const root = this.spec.workspaceRoot;
    if (!root) return;
    let uri: string;
    try {
      uri = pathToFileURL(realpathSync(root)).href;
    } catch {
      uri = pathToFileURL(root).href;
    }
    try {
      this.notify(WATCHED_FILES_METHOD, { changes: [{ uri, type: FILE_CHANGE_TYPE.changed }] });
    } catch {
      // A dead stdin surfaces through the channel's close path.
    }
  }

  private forwardWatchBatch(batch: WatchBatch, root: string): void {
    if (this.closeReason !== null || this.channel === null) return;
    // The server drops its whole scan on any watched-files notification, so a
    // rescan is a single change for the root: it carries no path-level meaning.
    if (batch.kind === "rescan") {
      this.notifyRootChanged();
      return;
    }
    const wanted = new Map<string, { uri: string; type: 1 | 2 | 3 }>();
    for (const e of batch.events) {
      const rel = relative(root, e.path).split(sep).join("/");
      const accepted = [...this.registrations.values()].some((r) =>
        r.watchers.some((w) => (w.kinds & WATCH_KIND_BIT[e.type]) !== 0 && w.match(rel)),
      );
      if (!accepted) continue;
      const uri = pathToFileURL(e.path).href;
      wanted.set(`${e.type}:${uri}`, { uri, type: FILE_CHANGE_TYPE[e.type] });
    }
    if (wanted.size === 0) return;
    try {
      this.notify(WATCHED_FILES_METHOD, { changes: [...wanted.values()] });
    } catch {
      // A dead stdin surfaces through the channel's close path.
    }
  }

  private stopWatchers(): void {
    this.physicalWatcher?.close();
    this.physicalWatcher = null;
    this.registrations.clear();
    this.watchDegradedReason = null;
  }

  private replyResult(id: JsonRpcId, result: unknown): void {
    this.reply({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: JsonRpcId, code: number, message: string): void {
    this.reply({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private reply(message: unknown): void {
    try {
      this.channel?.write(encodeMessage(message));
    } catch {
      // A dead stdin surfaces through the channel's close path.
    }
  }

  private failPendingAndClose(reason: LspCloseReason): void {
    this.stopWatchers();
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
  // stdin/stdout are pipes we own (the JSON-RPC framing channel). stderr is
  // INHERITED, not piped: the language server's diagnostics flow to the
  // bridge's own stderr (visible in the host's MCP logs), and — crucially — an
  // inherited fd cannot fill a pipe buffer. A piped-but-undrained stderr would
  // block the child once it writes ~64 KB of logs and never gets read.
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
      // A write to a dead server surfaces as an async 'error' (EPIPE) on stdin,
      // NOT as a throw from write(). Without this listener Node escalates it to
      // an uncaught exception that takes down the whole bridge — the exact
      // crash the resilient error model exists to prevent. Funnel it through
      // the same close path; if 'exit' already fired, failPendingAndClose is a
      // no-op on the second reason.
      child.stdin.on("error", (err) =>
        handler({ kind: "spawn-error", message: `LSP stdin error: ${err.message}` }),
      );
    },
    close: () => {
      child.kill();
    },
  };
}

/**
 * The root-relative glob for one LSP watcher. A plain string is already
 * root-relative; a RelativePattern is rebased from its `baseUri` onto the root,
 * and refused when the base lies outside it.
 */
function globForWatcher(realRoot: string, globPattern: unknown): string {
  if (typeof globPattern === "string") return globPattern;
  const rp = globPattern as { baseUri?: unknown; pattern?: unknown } | null;
  if (rp === null || typeof rp !== "object" || typeof rp.pattern !== "string") {
    throw new RegistrationRefused("unsupported globPattern");
  }
  const uri =
    typeof rp.baseUri === "string"
      ? rp.baseUri
      : (rp.baseUri as { uri?: unknown } | null)?.uri;
  if (typeof uri !== "string") throw new RegistrationRefused("globPattern.baseUri must be a URI");
  let base: string;
  try {
    base = realpathSync(fileURLToPath(uri));
  } catch {
    throw new RegistrationRefused("globPattern.baseUri does not resolve to a local directory");
  }
  const rel = relative(realRoot, base);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RegistrationRefused("globPattern.baseUri is outside the workspace root");
  }
  return rel === "" ? rp.pattern : `${rel.split(sep).join("/")}/${rp.pattern}`;
}
