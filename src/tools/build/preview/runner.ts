import { spawn } from "node:child_process";

import { killGroupSync, trackGroup, untrackGroup } from "./cleanup.js";

// Spawns a generator as a child process and bounds the run.
//
// The generator is only ever a separate process (the Wall): `java -jar …` or
// `node …/exeris-gen`, never linked. Every limit is a named constant rather
// than an environment variable — the tool surface freezes under semver, and a
// limit an operator could silently raise would change what a preview may cost.

/** Wall-clock budget for one generator run. A JVM start dominates it. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * How long, after the child exits or a limit fires, the runner waits for the
 * output pipes to close before it gives up on them. A descendant that left the
 * process group (setsid) can hold a pipe open indefinitely; the run settles
 * with what was captured instead of waiting for it.
 */
export const DEFAULT_GRACE_MS = 2_000;
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
  readonly unit: "ms" | "bytes" | "entries" | "levels";
  /** One sentence, safe to show an agent verbatim. */
  readonly message: string;
}

export interface RunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly graceMs?: number;
  /** The child's whole environment; see generatorEnv(). Never inherited implicitly. */
  readonly env: NodeJS.ProcessEnv;
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

const ENV_ALLOWLIST = ["PATH", "HOME", "JAVA_HOME", "LANG", "LC_ALL"] as const;
const WINDOWS_ENV_ALLOWLIST = ["SystemRoot", "windir"] as const;

/**
 * The environment a generator runs with: a fixed allowlist copied from `base`,
 * and the temporary-directory variables pointed at the scratch directory.
 *
 * Nothing else is inherited. In particular no `*_OPTIONS` variable
 * (JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, NODE_OPTIONS) reaches the child, since
 * each can make a runtime write a dump, a log or a report to a path of the
 * operator's choosing, or load code into the generator.
 */
export function generatorEnv(base: NodeJS.ProcessEnv, workdir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const names: readonly string[] =
    process.platform === "win32" ? [...ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST] : ENV_ALLOWLIST;
  for (const name of names) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env.TMPDIR = workdir;
  env.TMP = workdir;
  env.TEMP = workdir;
  return env;
}

/**
 * Run the command to completion or to a limit.
 *
 * `shell: false` always: arguments reach the child verbatim, so a path with a
 * space or a metacharacter cannot become a second command.
 *
 * On POSIX the child leads its own process group, and a kill takes the whole
 * group — a generator that forks (a JVM launcher, a Node wrapper) leaves no
 * descendant running past the call. The group is killed when the leader exits
 * and when a limit fires, and at most once: after that the group id may belong
 * to an unrelated process, so it is never signalled again. On Windows there are
 * no groups; `taskkill /T` takes the tree, with a plain kill as the fallback.
 *
 * A descendant that escaped the group can still hold the output pipes open; the
 * run then settles after DEFAULT_GRACE_MS with what it captured.
 */
export function runGenerator(options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
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
    let groupAlive = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let graceTimer: NodeJS.Timeout | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      // The environment is exactly options.env (callers build it with generatorEnv()); the
      // command is resolved against that PATH.
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

    const pid = child.pid;
    if (pid !== undefined) {
      groupAlive = true;
      trackGroup(pid);
    }

    const killGroup = (): void => {
      if (!groupAlive || pid === undefined) return;
      groupAlive = false;
      untrackGroup(pid);
      killProcessTree(pid, posix, () => child.kill("SIGKILL"));
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      killGroup();
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

    // Armed whenever the run is ending: the pipes should close on their own, and
    // if a descendant outside the group holds them, they are destroyed here.
    const startGrace = (): void => {
      if (graceTimer !== undefined || settled) return;
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitInfo?.code ?? null, exitInfo?.signal ?? null);
      }, graceMs);
    };

    const stopForLimit = (reached: PreviewLimit): void => {
      if (limit !== null) return;
      limit = reached;
      killGroup();
      startGrace();
    };

    const timer = setTimeout(() => {
      if (limit !== null) return;
      timedOut = true;
      stopForLimit(timeoutLimit(timeoutMs));
    }, timeoutMs);

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
      stopForLimit(outputLimit(maxOutputBytes));
    };

    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));

    child.on("error", (err) => {
      spawnError = err.message;
      finish(null, null);
    });
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      killGroup();
      startGrace();
    });
    // 'close' fires after the pipes drain, so the tail of the output is not lost.
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function killProcessTree(pid: number, posix: boolean, fallback: () => void): void {
  if (posix) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // The group was never formed; try the child itself.
    }
    try {
      fallback();
    } catch {
      // Already exited.
    }
    return;
  }
  // taskkill /T takes the tree; the plain kill covers a taskkill that could not run.
  killGroupSync(pid);
  try {
    fallback();
  } catch {
    // Already exited.
  }
}
