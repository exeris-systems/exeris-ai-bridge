import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { compileGlob, type WatchBatch, type WatchHandle, watchRoot } from "./watch.js";

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
  await sleep(100);
  return handle;
}

test("compileGlob supports recursive extension, subtree, brace and single-star patterns", () => {
  const java = compileGlob("**/*.java");
  assert.ok(java.test("A.java"));
  assert.ok(java.test("a/b/C.java"));
  assert.ok(!java.test("a/b/C.txt"));
  assert.ok(!java.test("a/b/C.java.bak"));

  const sub = compileGlob("src/**/*.{java,kt}");
  assert.ok(sub.test("src/a/B.kt"));
  assert.ok(sub.test("src/B.java"));
  assert.ok(!sub.test("other/B.java"));

  const flat = compileGlob("*.java");
  assert.ok(flat.test("A.java"));
  assert.ok(!flat.test("a/A.java"));
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

test("an event reached through a symlinked directory that leaves the root is dropped", async (t) => {
  const { root, outside, cleanup } = fixture();
  try {
    symlinkSync(outside, join(root, "link"), "dir");
  } catch {
    cleanup();
    t.skip("symlinks unavailable on this platform");
    return;
  }
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    writeFileSync(join(outside, "Evil.java"), "class Evil {}");
    writeFileSync(join(root, "Inside.java"), "class Inside {}");
    await c.until(() => allEvents(c.batches).some((e) => e.path === join(root, "Inside.java")));
    await sleep(DEBOUNCE_MS * 3);
    assert.ok(
      allEvents(c.batches).every((e) => e.path.startsWith(root)),
      `no event may leave the root: ${JSON.stringify(c.batches)}`,
    );
    assert.ok(!allEvents(c.batches).some((e) => e.path.includes("Evil")));
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
