import { spawn } from "node:child_process";

// Spawns a generator as a child process and bounds the run.
//
// The generator is only ever a separate process (the Wall): `java -jar …` or
// `node …/exeris-gen`, never linked. Every limit is a named constant rather
// than an environment variable — the tool surface freezes under semver, and a
// limit an operator could silently raise would change what a preview may cost.

/** Wall-clock budget for one generator run. A JVM start dominates it. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on the bytes captured from stdout and stderr TOGETHER. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Cap on the total size of the produced files a preview returns. */
export const DEFAULT_MAX_FILES_BYTES = 4 * 1024 * 1024;

/** Which limit stopped a run. */
export type PreviewLimitName = "timeout" | "output" | "files";

/** A limit that was exceeded, naming itself and its value. */
export interface PreviewLimit {
  readonly name: PreviewLimitName;
  readonly value: number;
  readonly unit: "ms" | "bytes";
  /** One sentence, safe to show an agent verbatim. */
  readonly message: string;
}

export interface RunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  /** The child's exit status; null when it was killed by a signal or never started. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when output hit the cap; what was captured is cut at the cap. */
  readonly truncated: boolean;
  /** The limit that stopped the run, or null when it ended by itself. */
  readonly limit: PreviewLimit | null;
  /** Set when the process could not be started at all (command missing, not executable). */
  readonly spawnError: string | null;
}

export function timeoutLimit(timeoutMs: number): PreviewLimit {
  return {
    name: "timeout",
    value: timeoutMs,
    unit: "ms",
    message: `The generator exceeded the ${timeoutMs} ms wall-clock timeout and was stopped.`,
  };
}

export function outputLimit(maxBytes: number): PreviewLimit {
  return {
    name: "output",
    value: maxBytes,
    unit: "bytes",
    message: `The generator wrote more than the ${maxBytes}-byte output cap to stdout and stderr and was stopped.`,
  };
}

/**
 * Check the total size of the files a caller is about to return against the cap.
 * Returns the breached limit, or null when the total fits.
 */
export function checkFilesSize(
  totalBytes: number,
  maxBytes: number = DEFAULT_MAX_FILES_BYTES,
): PreviewLimit | null {
  if (totalBytes <= maxBytes) return null;
  return {
    name: "files",
    value: maxBytes,
    unit: "bytes",
    message: `The produced files total more than the ${maxBytes}-byte size cap.`,
  };
}

/**
 * Run the command to completion or to a limit.
 *
 * `shell: false` always: arguments reach the child verbatim, so a path with a
 * space or a metacharacter cannot become a second command.
 *
 * On POSIX the child leads its own process group, and a kill takes the whole
 * group — a generator that forks (a JVM launcher, a Node wrapper) leaves no
 * descendant running past the call. The group is also reaped when the child
 * ends by itself, because the scratch directory is about to be removed. On
 * Windows there are no groups; `taskkill /T` takes the tree, with a plain kill
 * as the fallback.
 */
export function runGenerator(options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const posix = process.platform !== "win32";

  return new Promise<RunResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let limit: PreviewLimit | null = null;
    let spawnError: string | null = null;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command, [...options.args], {
        shell: false,
        cwd: options.cwd,
        env: options.env,
        detached: posix,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        limit: null,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const killTree = (): void => killProcessTree(child.pid, posix, () => child.kill("SIGKILL"));

    const timer = setTimeout(() => {
      if (limit !== null) return;
      timedOut = true;
      limit = timeoutLimit(timeoutMs);
      killTree();
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        truncated,
        limit,
        spawnError,
      });
    };

    const capture = (sink: Buffer[]) => (chunk: Buffer) => {
      if (limit !== null) return;
      const room = maxOutputBytes - captured;
      if (chunk.length <= room) {
        sink.push(chunk);
        captured += chunk.length;
        return;
      }
      if (room > 0) sink.push(chunk.subarray(0, room));
      captured = maxOutputBytes;
      truncated = true;
      limit = outputLimit(maxOutputBytes);
      killTree();
    };

    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));

    child.on("error", (err) => {
      spawnError = err.message;
      finish(null, null);
    });
    // 'close' rather than 'exit': it fires after the pipes drain, so the tail of
    // the output is not lost. A descendant holding a pipe open is bounded by the
    // timeout, which kills the group and so closes the pipe.
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function killProcessTree(pid: number | undefined, posix: boolean, fallback: () => void): void {
  if (pid === undefined) {
    fallback();
    return;
  }
  if (posix) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The group is already gone (ESRCH) or was never formed; try the child itself.
    }
    try {
      fallback();
    } catch {
      // Already exited.
    }
    return;
  }
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
    });
    killer.on("error", () => fallback());
  } catch {
    fallback();
  }
}
