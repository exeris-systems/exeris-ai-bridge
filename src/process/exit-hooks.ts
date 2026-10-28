import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

// Process-wide cleanup for what the bridge leaves behind if it itself is
// stopped mid-run: child process groups, scratch directories and open
// resources such as filesystem watchers.
//
// A generator runs in its own process group (so a kill takes its descendants),
// which also means a signal sent to the bridge does not reach it. Without this
// registry a bridge stopped by SIGTERM or Ctrl-C would leave the generator
// running and its scratch directory on disk. The 'exit' handler is synchronous
// by necessity: it is the last code the process runs.

const groups = new Set<number>();
const directories = new Set<string>();
const closers = new Set<() => void>();
let installed = false;

/** Track a live generator process group (its leader's pid), so exit can kill it. */
export function trackGroup(pgid: number): void {
  install();
  groups.add(pgid);
}

export function untrackGroup(pgid: number): void {
  groups.delete(pgid);
}

/** Track a scratch directory, so exit can remove it. */
export function trackDirectory(dir: string): void {
  install();
  directories.add(dir);
}

export function untrackDirectory(dir: string): void {
  directories.delete(dir);
}

/** Track a synchronous closer (a filesystem watcher, say), so exit can run it. */
export function trackCloser(close: () => void): void {
  install();
  closers.add(close);
}

export function untrackCloser(close: () => void): void {
  closers.delete(close);
}

/** Run every closer, kill every tracked group and remove every tracked directory. Synchronous and never throws. */
export function cleanupNow(): void {
  for (const close of closers) {
    try {
      close();
    } catch {
      // Closing is best effort at exit.
    }
  }
  closers.clear();
  for (const pgid of groups) {
    killGroupSync(pgid);
  }
  groups.clear();
  for (const dir of directories) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left to the OS temporary-directory reaper.
    }
  }
  directories.clear();
}

/**
 * taskkill by absolute path, so the kill never resolves a binary through PATH.
 */
function taskkillPath(): string {
  return join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "taskkill.exe");
}

export function killGroupSync(pgid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync(taskkillPath(), ["/pid", String(pgid), "/T", "/F"], { shell: false, stdio: "ignore" });
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/**
 * Installed once, on the first tracked run. A signal handler is added only when
 * nothing else listens for that signal: a host that already handles SIGTERM
 * exits through its own path, which still runs the 'exit' handler below.
 */
function install(): void {
  if (installed) return;
  installed = true;
  process.on("exit", cleanupNow);
  if (process.listenerCount("SIGTERM") === 0) process.on("SIGTERM", () => process.exit(143));
  if (process.listenerCount("SIGINT") === 0) process.on("SIGINT", () => process.exit(130));
}

/** How many closers are tracked; lets a test assert that a finished resource released its entry. */
export function trackedCloserCount(): number {
  return closers.size;
}
