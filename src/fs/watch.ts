import { type FSWatcher, realpathSync, watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { trackCloser, untrackCloser } from "../tools/build/preview/cleanup.js";

// A bounded, root-confined recursive watcher. Every event is resolved against
// the realpath of the pinned root and dropped when its path, once resolved,
// leaves that root — so a symlinked directory inside the root cannot be used to
// observe files outside it. Events are debounced and coalesced per path; a burst
// larger than the buffer collapses into a single rescan signal rather than
// growing without bound.

export type WatchChangeType = "created" | "changed" | "deleted";

export interface WatchEvent {
  /** Absolute path under the real root. */
  readonly path: string;
  readonly type: WatchChangeType;
}

export type WatchBatch =
  | { readonly kind: "events"; readonly events: readonly WatchEvent[] }
  /** Too many changes to enumerate: the consumer must treat everything as changed. */
  | { readonly kind: "rescan" };

export interface WatchOptions {
  /** Glob patterns, relative to the root, matched against POSIX-style relative paths. */
  readonly globs: readonly string[];
  readonly debounceMs: number;
  readonly onEvents: (batch: WatchBatch) => void;
  /** Distinct paths buffered per debounce window before collapsing to a rescan. Default 1000. */
  readonly maxBufferedEvents?: number;
}

export interface WatchHandle {
  /** The realpath of the watched root. */
  readonly root: string;
  close(): void;
}

const DEFAULT_MAX_BUFFERED = 1000;

/**
 * Compile a glob to a matcher over POSIX relative paths. Supports `**`, `*`,
 * `?` and `{a,b}` alternation, which covers the patterns language servers
 * register (a recursive extension match, or a subtree with an extension list).
 */
export function compileGlob(glob: string): RegExp {
  let out = "";
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      braceDepth++;
      out += "(?:";
    } else if (c === "}" && braceDepth > 0) {
      braceDepth--;
      out += ")";
    } else if (c === "," && braceDepth > 0) {
      out += "|";
    } else {
      out += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }
  while (braceDepth-- > 0) out += ")";
  return new RegExp(`^${out}$`);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Realpath of the nearest ancestor of `path` that exists, or null if none resolves. */
async function realpathOfNearestAncestor(path: string): Promise<string | null> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export function watchRoot(root: string, options: WatchOptions): WatchHandle {
  const realRoot = realpathSync(root);
  const matchers = options.globs.map(compileGlob);
  const max = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED;

  // Per path: whether fs.watch reported a rename (create/delete/move) and/or a change.
  const buffer = new Map<string, { rename: boolean }>();
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let flushing = false;
  let rearm = false;
  let watcher: FSWatcher | null = null;

  const matches = (rel: string): boolean => matchers.some((m) => m.test(rel));

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flush(), options.debounceMs);
  };

  const collapse = (): void => {
    overflow = true;
    buffer.clear();
    schedule();
  };

  const flush = async (): Promise<void> => {
    timer = null;
    if (closed) return;
    if (flushing) {
      rearm = true;
      return;
    }
    flushing = true;
    const pending = [...buffer];
    const hadOverflow = overflow;
    buffer.clear();
    overflow = false;
    try {
      if (hadOverflow) {
        options.onEvents({ kind: "rescan" });
        return;
      }
      const events: WatchEvent[] = [];
      for (const [path, flags] of pending) {
        // The parent directory is what a symlink can redirect out of the root.
        const parentReal = await realpathOfNearestAncestor(dirname(path));
        if (parentReal === null || !isInside(realRoot, parentReal)) continue;
        let exists = true;
        try {
          await lstat(path);
        } catch {
          exists = false;
        }
        const type: WatchChangeType = !exists ? "deleted" : flags.rename ? "created" : "changed";
        events.push({ path: join(parentReal, basename(path)), type });
      }
      if (events.length > 0 && !closed) options.onEvents({ kind: "events", events });
    } finally {
      flushing = false;
      if (rearm && !closed) {
        rearm = false;
        schedule();
      }
    }
  };

  const onRaw = (eventType: string, filename: string | Buffer | null): void => {
    if (closed) return;
    if (filename === null || filename === undefined) {
      collapse();
      return;
    }
    const name = filename.toString();
    const path = join(realRoot, name);
    if (!isInside(realRoot, path)) return;
    if (!matches(name.split(sep).join("/"))) return;
    if (overflow) {
      schedule();
      return;
    }
    let entry = buffer.get(path);
    if (entry === undefined) {
      if (buffer.size >= max) {
        collapse();
        return;
      }
      entry = { rename: false };
      buffer.set(path, entry);
    }
    if (eventType === "rename") entry.rename = true;
    schedule();
  };

  const closeWatcher = (): void => {
    const current = watcher;
    watcher = null;
    try {
      current?.close();
    } catch {
      // Already closed.
    }
  };

  watcher = watch(realRoot, { recursive: true }, onRaw);
  // A watcher that errors (inotify limit, root removed) can no longer vouch for
  // the tree: report a rescan and stop rather than go silently stale.
  watcher.on("error", (err) => {
    process.stderr.write(`[exeris-ai-bridge] workspace watcher error: ${err.message}\n`);
    collapse();
    closeWatcher();
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    buffer.clear();
    closeWatcher();
    untrackCloser(close);
  };
  trackCloser(close);
  return { root: realRoot, close };
}
