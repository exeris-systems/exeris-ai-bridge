import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  DEFAULT_MAX_FILES_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  checkFilesSize,
  runGenerator,
  type RunResult,
} from "./runner.js";
import { WorkdirRefusedError, createWorkdir, withWorkdir } from "./workdir.js";

// The fake generators are small Node scripts written into a scratch directory
// at test time and launched as the command in place of java / exeris-gen.

let scratch: string;
let projectRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "exeris-runner-"));
  projectRoot = join(scratch, "project");
  mkdirSync(projectRoot);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fakeGenerator(name: string, source: string): string {
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, source);
  return path;
}

interface Outcome {
  readonly result: RunResult;
  readonly workdir: string;
}

/** Run a fake generator inside a workdir the way the preview tool will: `--output-dir=<workdir>`. */
async function runFake(
  script: string,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  extraArgs: string[] = [],
): Promise<Outcome> {
  let workdir = "";
  const result = await withWorkdir({ protectedRoots: [projectRoot] }, async (dir) => {
    workdir = dir;
    return runGenerator({
      command: process.execPath,
      args: [script, `--output-dir=${dir}`, ...extraArgs],
      ...limits,
    });
  });
  return { result, workdir };
}

test("defaults are exported constants", () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, "number");
  assert.equal(typeof DEFAULT_MAX_OUTPUT_BYTES, "number");
  assert.equal(typeof DEFAULT_MAX_FILES_BYTES, "number");
});

test("a generator that writes files and exits 0 is captured, and the workdir is gone afterwards", async () => {
  const script = fakeGenerator(
    "ok",
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.argv.find((a) => a.startsWith("--output-dir=")).slice(13);
mkdirSync(join(out, "pkg"), { recursive: true });
writeFileSync(join(out, "pkg", "A.java"), "class A {}");
console.log("generated 1 file");
`,
  );
  let seen: string | null = null;
  let workdir = "";
  const result = await withWorkdir({ protectedRoots: [projectRoot] }, async (dir) => {
    workdir = dir;
    const r = await runGenerator({ command: process.execPath, args: [script, `--output-dir=${dir}`] });
    seen = readFileSync(join(dir, "pkg", "A.java"), "utf8");
    return r;
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "generated 1 file");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(result.limit, null);
  assert.equal(seen, "class A {}");
  assert.equal(existsSync(workdir), false);
});

test("exit 1 keeps the [Exeris] EXT- line on stderr", async () => {
  const script = fakeGenerator(
    "fail",
    `console.error("[Exeris] EXT-PROC-1014 stream handler refused on a TENANT entity");
process.exit(1);
`,
  );
  const { result, workdir } = await runFake(script);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /^\[Exeris\] EXT-PROC-1014 /);
  assert.equal(result.limit, null);
  assert.equal(existsSync(workdir), false);
});

test("exit 2 (invalid arguments) is reported as such", async () => {
  const script = fakeGenerator("usage", `console.error("[Exeris] EXT-CLI-5001 bad switch"); process.exit(2);`);
  const { result, workdir } = await runFake(script);
  assert.equal(result.exitCode, 2);
  assert.equal(existsSync(workdir), false);
});

test("a hung generator is stopped and the limit is named with its value", async () => {
  const script = fakeGenerator("hang", `setInterval(() => {}, 1000);`);
  const { result, workdir } = await runFake(script, { timeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.equal(result.limit?.name, "timeout");
  assert.equal(result.limit?.value, 400);
  assert.match(result.limit?.message ?? "", /400 ms wall-clock timeout/);
  assert.equal(existsSync(workdir), false);
});

test("a generator that floods stdout is stopped at the output cap", async () => {
  const script = fakeGenerator(
    "flood",
    `const chunk = "x".repeat(8192);
const timer = setInterval(() => { process.stdout.write(chunk); }, 1);
process.on("SIGTERM", () => clearInterval(timer));
`,
  );
  const { result, workdir } = await runFake(script, { maxOutputBytes: 20_000, timeoutMs: 30_000 });
  assert.equal(result.truncated, true);
  assert.equal(result.limit?.name, "output");
  assert.equal(result.limit?.value, 20_000);
  assert.match(result.limit?.message ?? "", /20000-byte output cap/);
  assert.equal(result.stdout.length + result.stderr.length, 20_000);
  assert.equal(result.timedOut, false);
  assert.equal(existsSync(workdir), false);
});

test("the output cap counts stdout and stderr together", async () => {
  const script = fakeGenerator(
    "both",
    `const timer = setInterval(() => { process.stdout.write("a".repeat(600)); process.stderr.write("b".repeat(600)); }, 1);
process.on("SIGTERM", () => clearInterval(timer));
`,
  );
  const { result } = await runFake(script, { maxOutputBytes: 2_000, timeoutMs: 30_000 });
  assert.equal(result.limit?.name, "output");
  assert.equal(result.stdout.length + result.stderr.length, 2_000);
});

test("a grandchild that sleeps is killed with its parent", async () => {
  const pidFile = join(scratch, "grandchild.pid");
  const script = fakeGenerator(
    "fork",
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);
`,
  );
  const { result, workdir } = await runFake(script, { timeoutMs: 1_000 });
  assert.equal(result.timedOut, true);
  assert.equal(existsSync(workdir), false);

  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0);
  assert.equal(await waitUntilGone(pid), true, "the grandchild must not outlive the call");
});

test("a grandchild left behind by a generator that exits by itself is killed too", async () => {
  const pidFile = join(scratch, "orphan.pid");
  const script = fakeGenerator(
    "orphan",
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
grandchild.unref();
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
`,
  );
  const { result } = await runFake(script, { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(await waitUntilGone(Number(readFileSync(pidFile, "utf8"))), true);
});

test("a command that cannot start reports a spawn error instead of throwing", async () => {
  const result = await runGenerator({ command: join(scratch, "no-such-binary"), args: [] });
  assert.equal(result.exitCode, null);
  assert.ok(result.spawnError !== null);
});

test("the workdir is removed when the callback throws", async () => {
  let workdir = "";
  await assert.rejects(
    withWorkdir({ protectedRoots: [projectRoot] }, async (dir) => {
      workdir = dir;
      writeFileSync(join(dir, "partial.txt"), "x");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(existsSync(workdir), false);
});

test("the workdir is not inside the project root", async () => {
  await withWorkdir({ protectedRoots: [projectRoot] }, async (dir) => {
    assert.ok(!dir.startsWith(projectRoot));
  });
});

test("a temporary directory inside the project root is refused, and nothing is created", () => {
  const insideProject = join(projectRoot, "tmp");
  mkdirSync(insideProject);
  assert.throws(
    () => createWorkdir({ protectedRoots: [projectRoot], tmpRoot: insideProject }),
    WorkdirRefusedError,
  );
  assert.deepEqual(readdirNames(insideProject), []);
});

test("a temporary directory inside the ecosystem root is refused", () => {
  const ecosystem = join(scratch, "ecosystem");
  const inside = join(ecosystem, "tmp");
  mkdirSync(inside, { recursive: true });
  assert.throws(
    () => createWorkdir({ protectedRoots: [projectRoot, ecosystem], tmpRoot: inside }),
    WorkdirRefusedError,
  );
});

test("a temporary directory that is a symlink into the project root is refused", () => {
  const link = join(scratch, "tmp-link");
  symlinkSync(projectRoot, link);
  assert.throws(
    () => createWorkdir({ protectedRoots: [projectRoot], tmpRoot: link }),
    WorkdirRefusedError,
  );
  assert.deepEqual(readdirNames(projectRoot), []);
});

test("a null ecosystem root is ignored", async () => {
  await withWorkdir({ protectedRoots: [projectRoot, null] }, async (dir) => {
    assert.ok(existsSync(dir));
  });
});

test("checkFilesSize names the limit and its value when the total exceeds it", () => {
  assert.equal(checkFilesSize(100, 100), null);
  const limit = checkFilesSize(101, 100);
  assert.equal(limit?.name, "files");
  assert.equal(limit?.value, 100);
  assert.match(limit?.message ?? "", /100-byte size cap/);
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("a temporary directory under a dot-dot-named directory inside the project is refused", () => {
  const dotted = join(projectRoot, "..cache");
  mkdirSync(dotted);
  assert.throws(() => createWorkdir({ protectedRoots: [projectRoot], tmpRoot: dotted }), WorkdirRefusedError);
  assert.deepEqual(readdirNames(dotted), []);
});

test("a temporary directory in a dot-dot-named sibling of the project is allowed", async () => {
  const sibling = join(scratch, "..elsewhere");
  mkdirSync(sibling);
  await withWorkdir({ protectedRoots: [projectRoot], tmpRoot: sibling }, async (dir) => {
    assert.ok(existsSync(dir));
  });
});
