import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

// Process-wide cleanup for what a preview leaves behind if the bridge itself
// is stopped mid-run.
//
// A generator runs in its own process group (so a kill takes its descendants),
// which also means a signal sent to the bridge does not reach it. Without this
// registry a bridge stopped by SIGTERM or Ctrl-C would leave the generator
// running and its scratch directory on disk. The 'exit' handler is synchronous
// by necessity: it is the last code the process runs.

const groups = new Set<number>();
const directories = new Set<string>();
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

/** Kill every tracked group and remove every tracked directory. Synchronous and never throws. */
export function cleanupNow(): void {
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

export function killGroupSync(pgid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pgid), "/T", "/F"], { shell: false, stdio: "ignore" });
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
