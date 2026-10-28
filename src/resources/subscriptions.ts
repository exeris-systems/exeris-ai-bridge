import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { DocsConfig, Unavailable } from "../config/env.js";
import { describeFsError, watchRoot, type WatchHandle, type WatchOptions } from "../fs/watch.js";
import { ADR_INDEX_FILENAME } from "../tools/docs/content.js";

// Subscriptions to exeris://docs/adr-index.
//
// The registry index is the one resource that can change under a running
// server: from a checkout it is a file somebody edits or a `git pull`
// replaces. Everything else the resources serve is either a template or a
// record reached through that index, and a client that cares re-reads the
// index to learn the registry moved.
//
// Over the bundled snapshot the content is immutable for the process, so a
// subscription is accepted and never fires, and no watcher exists. The same
// holds when docs is unavailable: there is nothing to watch, and the read
// that follows says why.
//
// State lives in the object createAdrIndexSubscriptions returns, which belongs
// to one MCP server. A server that serves several sessions builds one per
// session, so a subscription cannot notify a session that did not make it.

export const ADR_INDEX_URI = "exeris://docs/adr-index";

/** Quiet period after the last write before a notification is sent. */
const DEFAULT_DEBOUNCE_MS = 250;

export type SubscriptionWatchStatus =
  /** No subscriber, so no watcher. */
  | { readonly state: "off" }
  /** Content is immutable for the process; a subscription never fires. */
  | { readonly state: "static" }
  | { readonly state: "watching" }
  | { readonly state: "degraded"; readonly reason: string };

export interface AdrIndexSubscriptionOptions {
  /** Replaces the shared watcher; for tests that count the watchers opened and closed. */
  readonly watchRootFn?: (root: string, options: WatchOptions) => WatchHandle;
  readonly debounceMs?: number;
}

export interface AdrIndexSubscriptions {
  /** Resolves once the watcher, if one is needed, is in place, so a write after the reply is seen. */
  subscribe(uri: string): Promise<void>;
  unsubscribe(uri: string): void;
  status(): SubscriptionWatchStatus;
  /** Stops the watcher and forgets every subscription. */
  close(): void;
}

/**
 * @param notify called with the resource URI, once per debounced burst of
 *   changes, and only while a subscription is active. It must not throw.
 */
export function createAdrIndexSubscriptions(
  docs: DocsConfig | Unavailable,
  notify: (uri: string) => void,
  options: AdrIndexSubscriptionOptions = {},
): AdrIndexSubscriptions {
  const watchRootFn = options.watchRootFn ?? watchRoot;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const subscribed = new Set<string>();
  let handle: WatchHandle | null = null;
  let startFailure: string | null = null;

  // Deferred past the current turn: a failure while subscribing is observed
  // inside the subscribe handler, and the reply to that request must be the
  // first thing the subscriber hears.
  const fire = (): void => {
    setImmediate(() => {
      if (subscribed.has(ADR_INDEX_URI)) notify(ADR_INDEX_URI);
    });
  };

  const stop = (): void => {
    handle?.close();
    handle = null;
    startFailure = null;
  };

  const start = (config: DocsConfig): void => {
    if (config.source !== "checkout") return;
    try {
      // The index sits directly in the docs root: watching that one directory
      // and that one name keeps the cost independent of the size of the tree.
      handle = watchRootFn(config.docsRoot, {
        globs: [ADR_INDEX_FILENAME],
        maxDepth: 0,
        debounceMs,
        onEvents: fire,
        // The watcher can no longer vouch for the file, so the subscriber is
        // told once to read it again.
        onDegraded: fire,
      });
    } catch (cause) {
      startFailure = `cannot start the watcher (${describeFsError(cause)})`;
      fire();
    }
  };

  return {
    async subscribe(uri) {
      if (uri !== ADR_INDEX_URI) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Only ${ADR_INDEX_URI} can be subscribed to; the given URI is not subscribable.`,
        );
      }
      const first = subscribed.size === 0;
      subscribed.add(uri);
      // A watcher that failed or degraded is replaced by the next subscribe.
      const degraded = startFailure !== null || handle?.state().state === "degraded";
      if ((first || degraded) && docs.state === "available") {
        stop();
        start(docs);
      }
      await handle?.ready;
    },
    unsubscribe(uri) {
      if (!subscribed.delete(uri)) return;
      if (subscribed.size === 0) stop();
    },
    status() {
      if (docs.state === "unavailable" || docs.source !== "checkout") return { state: "static" };
      if (subscribed.size === 0) return { state: "off" };
      if (startFailure !== null) return { state: "degraded", reason: startFailure };
      const watch = handle?.state();
      return watch === undefined || watch.state === "watching" ? { state: "watching" } : watch;
    },
    close() {
      subscribed.clear();
      stop();
    },
  };
}
