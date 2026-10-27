import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compileGlob,
  isExcludedPath,
  MAX_GLOB_LENGTH,
  refusedRootReason,
  resolveEventPath,
  type WatchBatch,
  type WatchHandle,
  watchRoot,
} from "./watch.js";

const DEBOUNCE_MS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixture(): { root: string; outside: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "exeris-watch-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Collects batches and lets a test wait until a predicate over all of them holds. */
function collector(): { batches: WatchBatch[]; push: (b: WatchBatch) => void; until: (p: () => boolean) => Promise<void> } {
  const batches: WatchBatch[] = [];
  return {
    batches,
    push: (b) => batches.push(b),
    until: async (predicate) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out; batches=${JSON.stringify(batches)}`);
        await sleep(20);
      }
    },
  };
}

function allEvents(batches: readonly WatchBatch[]): { path: string; type: string }[] {
  return batches.flatMap((b) => (b.kind === "events" ? [...b.events] : []));
}

/** Let the platform watcher settle after creation before the test starts writing. */
async function started(handle: WatchHandle): Promise<WatchHandle> {
  await handle.ready;
  await sleep(50);
  return handle;
}

test("compileGlob supports recursive extension, subtree, brace and single-star patterns", () => {
  const java = compileGlob("**/*.java");
  assert.ok(java("A.java"));
  assert.ok(java("a/b/C.java"));
  assert.ok(!java("a/b/C.txt"));
  assert.ok(!java("a/b/C.java.bak"));

  const sub = compileGlob("src/**/*.{java,kt}");
  assert.ok(sub("src/a/B.kt"));
  assert.ok(sub("src/B.java"));
  assert.ok(!sub("other/B.java"));

  const flat = compileGlob("*.java");
  assert.ok(flat("A.java"));
  assert.ok(!flat("a/A.java"));

  assert.ok(compileGlob("a?c.java")("abc.java"));
  assert.ok(!compileGlob("a?c.java")("ac.java"));
});

test("compileGlob rejects an over-long pattern and finishes quickly on pathological ones", () => {
  assert.throws(() => compileGlob("a".repeat(MAX_GLOB_LENGTH + 1)), /longer than/);

  const started = Date.now();
  const hostile = [
    "**/**/**/**/**/**/**/**/**/**/*.java",
    "*a*a*a*a*a*a*a*a*a*a*a*a*b",
    "{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}/**/*x",
  ];
  const longName = "a".repeat(5000);
  const deepPath = Array.from({ length: 500 }, () => "d").join("/") + "/" + longName;
  for (const glob of hostile) {
    assert.equal(compileGlob(glob)(longName), false);
    assert.equal(compileGlob(glob)(deepPath), false);
  }
  assert.throws(() => compileGlob("{a,b}".repeat(7)), /too many alternatives/);
  assert.ok(Date.now() - started < 2000, "pathological globs must not backtrack");
});

test("isExcludedPath excludes VCS and build output but keeps the scanner's generated sources", () => {
  assert.ok(isExcludedPath([".git", "objects"]));
  assert.ok(isExcludedPath(["web", "node_modules", "x"]));
  assert.ok(isExcludedPath(["dist"]));
  assert.ok(isExcludedPath(["target", "classes"]));
  assert.ok(isExcludedPath(["build", "tmp"]));
  assert.ok(!isExcludedPath(["target"]));
  assert.ok(!isExcludedPath(["target", "generated-sources", "x", "A.java"]));
  assert.ok(!isExcludedPath(["build", "generated", "sources"]));
  assert.ok(!isExcludedPath(["src", "main", "A.java"]));
});

test("resolveEventPath resolves symlinks and keeps the path below a deleted ancestor exact", async (t) => {
  const { root, outside, cleanup } = fixture();
  try {
    mkdirSync(join(root, "real"));
    try {
      symlinkSync(outside, join(root, "escape"), "dir");
      symlinkSync(join(root, "real"), join(root, "alias"), "dir");
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    assert.equal(await resolveEventPath(root, join(root, "escape", "Evil.java")), null);
    assert.equal(await resolveEventPath(root, join(root, "escape", "deep", "gone", "Evil.java")), null);
    assert.equal(await resolveEventPath(root, join(root, "alias", "A.java")), join(root, "real", "A.java"));
    assert.equal(await resolveEventPath(root, join(root, "gone", "sub", "A.java")), join(root, "gone", "sub", "A.java"));
    assert.equal(await resolveEventPath(root, join(outside, "X.java")), null);
  } finally {
    cleanup();
  }
});

test("create, change and delete are reported with the matching type", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    mkdirSync(join(root, "pkg"));
    const file = join(root, "pkg", "A.java");

    writeFileSync(file, "class A {}");
    await c.until(() => allEvents(c.batches).some((e) => e.path === file && e.type === "created"));

    await sleep(DEBOUNCE_MS * 3);
    c.batches.length = 0;
    writeFileSync(file, "class A { int x; }");
    await c.until(() => allEvents(c.batches).some((e) => e.path === file && e.type === "changed"));

    await sleep(DEBOUNCE_MS * 3);
    c.batches.length = 0;
    unlinkSync(file);
    await c.until(() => allEvents(c.batches).some((e) => e.path === file && e.type === "deleted"));
  } finally {
    handle.close();
    cleanup();
  }
});

test("files that match no glob are not reported", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    writeFileSync(join(root, "notes.txt"), "x");
    writeFileSync(join(root, "B.java"), "class B {}");
    await c.until(() => allEvents(c.batches).length > 0);
    await sleep(DEBOUNCE_MS * 3);
    assert.deepEqual(
      allEvents(c.batches).map((e) => e.path),
      [join(root, "B.java")],
    );
  } finally {
    handle.close();
    cleanup();
  }
});

test("a burst of writes to one path inside the debounce window coalesces into one event", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: 300, onEvents: c.push }));
  try {
    const file = join(root, "A.java");
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `class A { int v${i}; }`);
      await sleep(20);
    }
    await c.until(() => c.batches.length > 0);
    await sleep(500);
    assert.equal(c.batches.length, 1, "one debounced batch");
    const events = allEvents(c.batches);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.path, file);
    assert.equal(events[0]?.type, "created");
  } finally {
    handle.close();
    cleanup();
  }
});

test("more distinct paths than the buffer holds collapse into a single rescan", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(
    watchRoot(root, { globs: ["**/*.java"], debounceMs: 150, maxBufferedEvents: 3, onEvents: c.push }),
  );
  try {
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `F${i}.java`), "class F {}");
    await c.until(() => c.batches.length > 0);
    await sleep(400);
    assert.deepEqual(c.batches, [{ kind: "rescan" }]);
  } finally {
    handle.close();
    cleanup();
  }
});

test("close stops delivery, including a batch already pending", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: 200, onEvents: c.push }));
  try {
    writeFileSync(join(root, "A.java"), "class A {}");
    await sleep(60);
    handle.close();
    handle.close(); // idempotent
    writeFileSync(join(root, "B.java"), "class B {}");
    await sleep(500);
    assert.deepEqual(c.batches, []);
  } finally {
    cleanup();
  }
});

test("a delete inside a deleted directory keeps the exact path", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const file = join(root, "a", "b", "X.java");
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(file, "class X {}");
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    rmSync(join(root, "a"), { recursive: true });
    await c.until(() => allEvents(c.batches).some((e) => e.path === file && e.type === "deleted"));
  } finally {
    handle.close();
    cleanup();
  }
});

test("a directory created after the watch started is watched and its files reported", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    mkdirSync(join(root, "n", "m"), { recursive: true });
    await sleep(150);
    const file = join(root, "n", "m", "N.java");
    writeFileSync(file, "class N {}");
    await c.until(() => allEvents(c.batches).some((e) => e.path === file));
  } finally {
    handle.close();
    cleanup();
  }
});

test("a continuous writer cannot postpone the flush past maxWaitMs", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const handle = await started(
    watchRoot(root, { globs: ["**/*.java"], debounceMs: 400, maxWaitMs: 600, onEvents: c.push }),
  );
  try {
    const begun = Date.now();
    const writer = (async () => {
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(root, "A.java"), `class A { int v${i}; }`);
        await sleep(100);
      }
    })();
    await c.until(() => c.batches.length > 0);
    const firstAfter = Date.now() - begun;
    assert.ok(firstAfter < 1500, `first batch after ${firstAfter} ms, writer still running`);
    await writer;
  } finally {
    handle.close();
    cleanup();
  }
});

const linuxOnly = { skip: process.platform === "linux" ? false : "owned per-directory watching is Linux-only" };

test("excluded directories get no watch", linuxOnly, async () => {
  const { root, cleanup } = fixture();
  for (const d of [".git/objects", "node_modules/x", "dist", "target/classes", "target/generated-sources/g", "build/tmp", "build/generated/s", "src/a"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  const handle = watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: () => undefined });
  try {
    await handle.ready;
    const watched = handle
      .watchedDirectories()
      .map((d) => d.slice(root.length + 1))
      .sort();
    assert.deepEqual(watched, [
      "",
      "build",
      "build/generated",
      "build/generated/s",
      "src",
      "src/a",
      "target",
      "target/generated-sources",
      "target/generated-sources/g",
    ]);
  } finally {
    handle.close();
    cleanup();
  }
});

test("more directories than the cap degrade the watcher and release every watch", linuxOnly, async () => {
  const { root, cleanup } = fixture();
  for (let i = 0; i < 10; i++) mkdirSync(join(root, `d${i}`));
  let reason: string | null = null;
  const handle = watchRoot(root, {
    globs: ["**/*.java"],
    debounceMs: DEBOUNCE_MS,
    maxDirectories: 4,
    onEvents: () => undefined,
    onDegraded: (r) => {
      reason = r;
    },
  });
  try {
    await handle.ready;
    const state = handle.state();
    assert.equal(state.state, "degraded");
    assert.match(reason ?? "", /more than 4 directories/);
    assert.deepEqual(handle.watchedDirectories(), []);
  } finally {
    handle.close();
    cleanup();
  }
});

test("a filesystem root and the home directory are refused", async () => {
  assert.ok(refusedRootReason("/") !== null || process.platform === "win32");
  const home = realpathSync(homedir());
  assert.match(refusedRootReason(home) ?? "", /home directory/);

  for (const target of [home, realpathSync("/")]) {
    let reason: string | null = null;
    const handle = watchRoot(target, {
      globs: ["**/*.java"],
      debounceMs: DEBOUNCE_MS,
      onEvents: () => undefined,
      onDegraded: (r) => {
        reason = r;
      },
    });
    await handle.ready;
    assert.equal(handle.state().state, "degraded");
    assert.ok(reason !== null);
    assert.deepEqual(handle.watchedDirectories(), []);
    handle.close();
  }
});
