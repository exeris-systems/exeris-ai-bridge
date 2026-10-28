import { existsSync, type FSWatcher, realpathSync, watch } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";

import { trackCloser, untrackCloser } from "../process/exit-hooks.js";

// A bounded, root-confined workspace watcher.
//
// Bounds, by construction:
//   - On Linux the tree is watched with one non-recursive watcher per
//     directory, built by an async walk, so the walk never blocks the event
//     loop and the number of inotify watches is known and capped. macOS and
//     Windows use the native recursive mode, which has no per-directory cost.
//   - Directories that hold no sources (VCS metadata, dependency and build
//     output) get no watch; see isExcludedPath.
//   - A root that is a filesystem root or the user's home directory is refused.
//   - Exceeding the directory cap, or any watcher error, moves the watcher to a
//     degraded state and releases every watch, rather than leaving a silently
//     partial one. The consumer decides what degraded means.
//
// Confinement: every event is resolved against the realpath of the root and
// dropped when its resolved path leaves that root, so a symlinked directory
// cannot be used to observe files outside it. Symlinked directories are never
// descended into.
//
// Events are debounced and coalesced per path; a burst larger than the buffer
// collapses into a single rescan batch.

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

export type WatchState =
  | { readonly state: "watching" }
  | { readonly state: "degraded"; readonly reason: string };

export interface WatchOptions {
  /** Glob patterns, relative to the root, matched against POSIX-style relative paths. */
  readonly globs: readonly string[];
  readonly debounceMs: number;
  readonly onEvents: (batch: WatchBatch) => void;
  /** Called once, if the watcher can no longer vouch for the tree. */
  readonly onDegraded?: (reason: string) => void;
  /** Longest a continuous stream of events may postpone a flush. Default 2000 ms. */
  readonly maxWaitMs?: number;
  /** Distinct paths buffered per window before collapsing to a rescan. Default 1000. */
  readonly maxBufferedEvents?: number;
  /** Directories watched on Linux before degrading. Default 10 000. */
  readonly maxDirectories?: number;
  /**
   * Deepest directory watched, counted from the root (0 = the root alone, no
   * descent). Unset watches the whole tree. A bounded depth always uses one
   * non-recursive watcher per directory, on every platform.
   */
  readonly maxDepth?: number;
  /** Replaces `fs.watch`; for tests that count the OS watches opened and closed. */
  readonly watchFn?: typeof watch;
}

export interface WatchHandle {
  /** The realpath of the watched root. */
  readonly root: string;
  /** Settles when the initial walk has finished or the watcher has degraded. Never rejects. */
  readonly ready: Promise<void>;
  state(): WatchState;
  /** Directories with an OS watch (Linux only; empty for the native recursive mode). */
  watchedDirectories(): string[];
  /** Replace the glob set; takes effect for events not yet buffered. */
  setGlobs(globs: readonly string[]): void;
  close(): void;
}

const DEFAULT_MAX_BUFFERED = 1000;
const DEFAULT_MAX_WAIT_MS = 2000;
const DEFAULT_MAX_DIRECTORIES = 10_000;

export const MAX_GLOB_LENGTH = 256;
const MAX_BRACE_EXPANSIONS = 64;

// --- paths ----------------------------------------------------------------

const ALWAYS_EXCLUDED = new Set([".git", "node_modules"]);
const JVM_BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts"];
const PROBED_FILES = new Set([...JVM_BUILD_FILES, "package.json"]);

/** Whether the directory at `directory` (root-relative segments) contains `file`. */
export type SiblingProbe = (directory: readonly string[], file: string) => boolean;

/**
 * Whether a root-relative path lies in a subtree that is not watched.
 *
 * `.git` and `node_modules` are excluded wherever they sit. `target` and
 * `build` are build output only when they sit directly beside a build file
 * (`pom.xml`, `build.gradle`, `build.gradle.kts`), and `dist` only beside a
 * `package.json`: a Java package directory with one of those names holds
 * sources, which the platform scanner indexes. Build output is excluded except
 * the directories the scanner indexes as sources (`target/generated-sources`,
 * `build/generated`). The directories `target` and `build` themselves stay
 * watched, so those children are reachable.
 */
export function isExcludedPath(segments: readonly string[], hasSibling: SiblingProbe): boolean {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    if (ALWAYS_EXCLUDED.has(segment)) return true;
    const next = segments[i + 1];
    const parent = segments.slice(0, i);
    if (segment === "target" && next !== undefined && next !== "generated-sources") {
      if (JVM_BUILD_FILES.some((f) => hasSibling(parent, f))) return true;
    }
    if (segment === "build" && next !== undefined && next !== "generated") {
      if (JVM_BUILD_FILES.some((f) => hasSibling(parent, f))) return true;
    }
    if (segment === "dist" && hasSibling(parent, "package.json")) return true;
  }
  return false;
}

/** A filesystem error as a path-free reason: its code, never its message, which embeds absolute paths. */
export function describeFsError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/** Why a root must not be watched, or null. A filesystem root or the home directory is too broad. */
export function refusedRootReason(realRoot: string): string | null {
  if (parse(realRoot).root === realRoot) return "the workspace root is a filesystem root";
  let home: string | null;
  try {
    home = realpathSync(homedir());
  } catch {
    home = null;
  }
  if (home !== null && home === realRoot) return "the workspace root is the home directory";
  return null;
}

/** Whether a `relative()` result leaves its base. A directory merely named `..x` stays inside. */
export function leavesBase(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

function isInside(root: string, candidate: string): boolean {
  return !leavesBase(relative(root, candidate));
}

/**
 * Resolve an event path against the real root. Returns the resolved absolute
 * path, or null when it leaves the root. The nearest existing ancestor is
 * resolved through symlinks; segments below it (a deleted file, a deleted
 * directory) are kept as they were, so the path stays exact.
 */
export async function resolveEventPath(realRoot: string, path: string): Promise<string | null> {
  let ancestor = dirname(path);
  let ancestorReal: string | null = null;
  for (;;) {
    try {
      ancestorReal = await realpath(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  if (ancestorReal === null) return null;
  const resolved = join(ancestorReal, relative(ancestor, path));
  return isInside(realRoot, resolved) ? resolved : null;
}

// --- globs ----------------------------------------------------------------

const GLOBSTAR = Symbol("globstar");
type SegmentPattern = string | typeof GLOBSTAR;

/** Expand `{a,b}` alternation (nested allowed) into plain globs, bounded. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];
  let depth = 0;
  const commas: number[] = [];
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === "," && depth === 1) commas.push(i);
  }
  if (close === -1) return [glob]; // unbalanced: literal
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const alt = glob.slice((bounds[i]) + 1, bounds[i + 1]);
    for (const rest of expandBraces(head + alt + tail)) {
      out.push(rest);
      if (out.length > MAX_BRACE_EXPANSIONS) throw new Error("glob expands to too many alternatives");
    }
  }
  return out;
}

function parseGlob(glob: string): SegmentPattern[] {
  const segments: SegmentPattern[] = [];
  for (const raw of glob.split("/")) {
    if (raw === "") continue;
    if (/^\*\*+$/.test(raw)) {
      if (segments[segments.length - 1] !== GLOBSTAR) segments.push(GLOBSTAR); // `**/**` is `**`
    } else {
      segments.push(raw.replace(/\*+/g, "*"));
    }
  }
  return segments;
}

/** Match one path segment against a pattern of literals, `*` and `?`, in O(n·m) time. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const pc = pattern[p];
    if (pc === "*") {
      starP = p++;
      starT = t;
    } else if (pc !== undefined && (pc === "?" || pc === text[t])) {
      p++;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function matchSegments(pattern: readonly SegmentPattern[], path: readonly string[]): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < path.length) {
    const pc = pattern[p];
    if (pc === GLOBSTAR) {
      starP = p++;
      starS = s;
    } else if (pc !== undefined && matchSegment(pc, path[s])) {
      p++;
      s++;
    } else if (starP !== -1) {
      p = starP + 1;
      s = ++starS;
    } else {
      return false;
    }
  }
  while (pattern[p] === GLOBSTAR) p++;
  return p === pattern.length;
}

/**
 * Compile a glob to a matcher over POSIX relative paths. Supports `**`, `*`,
 * `?` and `{a,b}`. Matching is greedy two-pointer matching, never regular
 * expression backtracking, so a hostile pattern costs at most O(n·m).
 * Throws for a pattern longer than MAX_GLOB_LENGTH.
 */
export function compileGlob(glob: string): (relativePath: string) => boolean {
  if (glob.length > MAX_GLOB_LENGTH) throw new Error(`glob longer than ${MAX_GLOB_LENGTH} characters`);
  const alternatives = expandBraces(glob).map(parseGlob);
  return (relativePath) => {
    const segments = relativePath.split("/").filter((s) => s !== "");
    return alternatives.some((alt) => matchSegments(alt, segments));
  };
}

// --- watcher --------------------------------------------------------------

export function watchRoot(root: string, options: WatchOptions): WatchHandle {
  const realRoot = realpathSync(root);
  let matchers = options.globs.map(compileGlob);
  const maxBuffered = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED;
  const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  const watchFn = options.watchFn ?? watch;

  // Per path: whether fs.watch reported a rename (create/delete/move).
  const buffer = new Map<string, { rename: boolean }>();
  const directoryWatchers = new Map<string, FSWatcher>();
  let nativeWatcher: FSWatcher | null = null;
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let windowStart: number | null = null;
  let closed = false;
  let degradedReason: string | null = null;
  let flushing = false;
  let rearm = false;

  // Sibling probes answered so far, per directory. A probe is a synchronous
  // stat, and every event of a burst asks the same few questions. An answer
  // holds until the build file it was about is created or removed, a rescan is
  // requested, a new directory is about to be walked, or the window flushes,
  // so a burst costs one stat per (directory, file).
  const probes = new Map<string, Map<string, boolean>>();
  const hasSibling: SiblingProbe = (directory, file) => {
    const key = directory.join(sep);
    let known = probes.get(key);
    if (known === undefined) {
      known = new Map();
      probes.set(key, known);
    }
    let found = known.get(file);
    if (found === undefined) {
      found = existsSync(join(realRoot, ...directory, file));
      known.set(file, found);
    }
    return found;
  };
  const forgetProbes = (path: string): void => {
    const name = basename(path);
    if (PROBED_FILES.has(name)) probes.get(relative(realRoot, dirname(path)))?.delete(name);
  };
  const excluded = (segments: readonly string[]): boolean => isExcludedPath(segments, hasSibling);
  const matches = (rel: string): boolean => matchers.some((m) => m(rel));
  const relSegments = (path: string): string[] => relative(realRoot, path).split(sep);
  const maxDepth = options.maxDepth;
  const depthOf = (dir: string): number => relSegments(dir).filter((s) => s !== "").length;

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    const now = Date.now();
    windowStart ??= now;
    const delay = Math.max(0, Math.min(options.debounceMs, windowStart + maxWait - now));
    timer = setTimeout(() => void flush(), delay);
  };

  const collapse = (): void => {
    // A rescan means the tree may have been replaced, so no probe answer about it still holds.
    probes.clear();
    overflow = true;
    buffer.clear();
    schedule();
  };

  const closeAllWatchers = (): void => {
    for (const w of directoryWatchers.values()) {
      try {
        w.close();
      } catch {
        // Already closed.
      }
    }
    directoryWatchers.clear();
    try {
      nativeWatcher?.close();
    } catch {
      // Already closed.
    }
    nativeWatcher = null;
  };

  const degrade = (reason: string): void => {
    if (closed || degradedReason !== null) return;
    degradedReason = reason;
    closeAllWatchers();
    untrackCloser(close);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    buffer.clear();
    process.stderr.write(`[exeris-ai-bridge] workspace watcher degraded: ${reason}\n`);
    try {
      options.onDegraded?.(reason);
    } catch {
      // A consumer failure must not escape a watcher callback.
    }
  };

  const flush = async (): Promise<void> => {
    timer = null;
    windowStart = null;
    probes.clear();
    if (closed || degradedReason !== null) return;
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
        const resolved = await resolveEventPath(realRoot, path);
        if (resolved === null) continue;
        let exists = true;
        try {
          await lstat(path);
        } catch {
          exists = false;
        }
        const type: WatchChangeType = !exists ? "deleted" : flags.rename ? "created" : "changed";
        events.push({ path: resolved, type });
      }
      if (events.length > 0 && !closed && degradedReason === null) {
        options.onEvents({ kind: "events", events });
      }
    } finally {
      flushing = false;
      if (rearm && !closed) {
        rearm = false;
        schedule();
      }
    }
  };

  const record = (path: string, rename: boolean): void => {
    if (closed || degradedReason !== null) return;
    forgetProbes(path);
    const segments = relSegments(path);
    if (excluded(segments)) return;
    if (!matches(segments.join("/"))) return;
    if (overflow) {
      schedule();
      return;
    }
    let entry = buffer.get(path);
    if (entry === undefined) {
      if (buffer.size >= maxBuffered) {
        collapse();
        return;
      }
      entry = { rename: false };
      buffer.set(path, entry);
    }
    if (rename) entry.rename = true;
    schedule();
  };

  // --- Linux: one watcher per directory ---

  const removeDirectoryTree = (dir: string): void => {
    for (const [d, w] of directoryWatchers) {
      if (d === dir || d.startsWith(dir + sep)) {
        try {
          w.close();
        } catch {
          // Already closed.
        }
        directoryWatchers.delete(d);
      }
    }
  };

  // "present": another walk already watches (and lists) this directory, e.g.
  // `mkdir -p a/b` is seen both from `a`'s walk and from the parent's event for `b`.
  const watchDirectory = (dir: string): "added" | "present" | "failed" => {
    if (directoryWatchers.has(dir)) return "present";
    if (directoryWatchers.size >= maxDirectories) {
      degrade(`more than ${maxDirectories} directories under the workspace root`);
      return "failed";
    }
    let w: FSWatcher;
    try {
      w = watchFn(dir, { persistent: true }, (eventType, filename) => {
        if (closed || degradedReason !== null) return;
        if (filename === null || filename === undefined) {
          collapse();
          return;
        }
        void onDirectoryEvent(join(dir, filename.toString()), eventType);
      });
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      // A directory removed between listing and watching is not a failure.
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return "added";
      degrade(`cannot watch a directory (${describeFsError(err)})`);
      return "failed";
    }
    // Attached before anything can fail asynchronously.
    w.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        removeDirectoryTree(dir);
        return;
      }
      degrade(`watcher error (${describeFsError(err)})`);
    });
    // Never leave a replaced watcher open: it would keep delivering events and
    // holding an inotify watch outside the cap.
    directoryWatchers.get(dir)?.close();
    directoryWatchers.set(dir, w);
    return "added";
  };

  /** Watch `dir` and everything under it that is not excluded; symlinks are never followed. */
  const walk = async (start: string, reportFound: boolean): Promise<void> => {
    const queue = [start];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      if (closed || degradedReason !== null) return;
      if (excluded(relSegments(dir).filter((s) => s !== ""))) continue;
      // Watch first, list second: an entry created in between shows up in both.
      const watched = watchDirectory(dir);
      if (watched === "failed") return;
      if (watched === "present") continue;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // removed or unreadable: its watch, if any, was already dropped or is harmless
      }
      for (const entry of entries) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (maxDepth === undefined || depthOf(dir) < maxDepth) queue.push(child);
        }
        else if (reportFound) record(child, true);
      }
    }
  };

  const onDirectoryEvent = async (path: string, eventType: string): Promise<void> => {
    if (eventType === "rename") {
      let isDirectory = false;
      try {
        isDirectory = (await lstat(path)).isDirectory();
      } catch {
        // A watched directory that disappeared (removed, renamed away, moved out
        // of the root or into an excluded directory) takes its sources with it
        // without an event per file: only a rescan can report them.
        const wasWatched = directoryWatchers.has(path);
        removeDirectoryTree(path);
        if (wasWatched && !closed && degradedReason === null) collapse();
      }
      if (closed || degradedReason !== null) return;
      if (isDirectory && !directoryWatchers.has(path) && (maxDepth === undefined || depthOf(dirname(path)) < maxDepth)) {
        // A directory that is new at this path may sit where another stood.
        probes.clear();
        await walk(path, true);
        return;
      }
    }
    record(path, eventType === "rename");
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    buffer.clear();
    closeAllWatchers();
    untrackCloser(close);
  };
  trackCloser(close);

  // --- startup ---

  const refused = refusedRootReason(realRoot);
  let ready: Promise<void>;
  if (refused !== null) {
    ready = Promise.resolve().then(() => degrade(refused));
  } else if (process.platform === "linux" || maxDepth !== undefined) {
    ready = walk(realRoot, false).catch((cause: unknown) => {
      degrade(`directory walk failed (${describeFsError(cause)})`);
    });
  } else {
    try {
      nativeWatcher = watchFn(realRoot, { recursive: true }, (eventType, filename) => {
        if (closed || degradedReason !== null) return;
        if (filename === null || filename === undefined) {
          collapse();
          return;
        }
        record(join(realRoot, filename.toString()), eventType === "rename");
      });
      nativeWatcher.on("error", (err: NodeJS.ErrnoException) => degrade(`watcher error (${describeFsError(err)})`));
      ready = Promise.resolve();
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      ready = Promise.resolve().then(() => degrade(`cannot watch the workspace root (${describeFsError(err)})`));
    }
  }

  return {
    root: realRoot,
    ready,
    state: () => (degradedReason === null ? { state: "watching" } : { state: "degraded", reason: degradedReason }),
    watchedDirectories: () => [...directoryWatchers.keys()],
    setGlobs: (globs) => {
      matchers = globs.map(compileGlob);
    },
    close,
  };
}
