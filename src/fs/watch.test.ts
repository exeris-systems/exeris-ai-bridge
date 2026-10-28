import { strict as assert } from "node:assert";
import { type FSWatcher, mkdirSync, mkdtempSync, watch, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";

import { trackedCloserCount } from "../process/exit-hooks.js";

import {
  compileGlob,
  describeFsError,
  isExcludedPath,
  leavesBase,
  type SiblingProbe,
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

test("isExcludedPath excludes build output only beside a build file, and VCS and dependencies anywhere", () => {
  const beside = (...files: string[]): SiblingProbe => (dir, file) => dir.length === 0 && files.includes(file);
  const none: SiblingProbe = () => false;

  assert.ok(isExcludedPath([".git", "objects"], none));
  assert.ok(isExcludedPath(["web", "node_modules", "x"], none));

  assert.ok(isExcludedPath(["target", "classes"], beside("pom.xml")));
  assert.ok(isExcludedPath(["build", "tmp"], beside("build.gradle")));
  assert.ok(isExcludedPath(["build", "tmp"], beside("build.gradle.kts")));
  assert.ok(isExcludedPath(["dist"], beside("package.json")));
  assert.ok(!isExcludedPath(["target"], beside("pom.xml")));
  assert.ok(!isExcludedPath(["target", "generated-sources", "x", "A.java"], beside("pom.xml")));
  assert.ok(!isExcludedPath(["build", "generated", "sources"], beside("build.gradle")));

  // The same names without a build file beside them are ordinary directories.
  assert.ok(!isExcludedPath(["target", "classes"], none));
  assert.ok(!isExcludedPath(["dist"], none));
  assert.ok(!isExcludedPath(["src", "main", "java", "com", "acme", "build", "Foo.java"], beside("pom.xml")));
  assert.ok(!isExcludedPath(["src", "main", "java", "com", "acme", "target", "Foo.java"], beside("pom.xml")));
  assert.ok(!isExcludedPath(["src", "main", "A.java"], none));
});

test("describeFsError reports the code and never the message", () => {
  const err = Object.assign(new Error("ENOSPC: no space left, watch '/home/someone/project/src'"), { code: "ENOSPC" });
  assert.equal(describeFsError(err), "ENOSPC");
  const reason = describeFsError(new Error("EACCES: cannot read /home/someone/project"));
  assert.equal(reason, "unknown error");
  assert.ok(!/[/\\]/.test(reason) && !/[/\\]/.test(describeFsError(err)));
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
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: 1000, onEvents: c.push }));
  try {
    const file = join(root, "A.java");
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `class A { int v${i}; }`);
      await sleep(20);
    }
    await c.until(() => c.batches.length > 0);
    await sleep(1200);
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

test("removing a directory tree reports the deletion or a rescan, never a wrong path", async () => {
  const { root, cleanup } = fixture();
  const c = collector();
  const file = join(root, "a", "b", "X.java");
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(file, "class X {}");
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    rmSync(join(root, "a"), { recursive: true });
    // The removed directory's own watcher forwards a rescan; if the per-file
    // delete wins the race instead, its path must be exact. resolveEventPath
    // pins the exactness for a deleted ancestor.
    await c.until(
      () => c.batches.some((b) => b.kind === "rescan") || allEvents(c.batches).some((e) => e.path === file && e.type === "deleted"),
    );
    assert.ok(allEvents(c.batches).every((e) => e.path === file));
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
  writeFileSync(join(root, "pom.xml"), "<project/>");
  writeFileSync(join(root, "package.json"), "{}");
  for (const d of [
    ".git/objects",
    "node_modules/x",
    "dist",
    "target/classes",
    "target/generated-sources/g",
    "build/tmp",
    "build/generated/s",
    "src/a",
    "src/main/java/com/acme/build",
    "src/main/java/com/acme/target",
  ]) {
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
      "src/main",
      "src/main/java",
      "src/main/java/com",
      "src/main/java/com/acme",
      "src/main/java/com/acme/build",
      "src/main/java/com/acme/target",
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

test("package directories named build and target under src/main/java are watched and report events", linuxOnly, async () => {
  const { root, cleanup } = fixture();
  writeFileSync(join(root, "pom.xml"), "<project/>");
  const pkg = join(root, "src", "main", "java", "com", "acme");
  mkdirSync(join(pkg, "build"), { recursive: true });
  mkdirSync(join(pkg, "target"), { recursive: true });
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    writeFileSync(join(pkg, "build", "Foo.java"), "class Foo {}");
    writeFileSync(join(pkg, "target", "Bar.java"), "class Bar {}");
    await c.until(() => {
      const paths = allEvents(c.batches).map((e) => e.path);
      return paths.includes(join(pkg, "build", "Foo.java")) && paths.includes(join(pkg, "target", "Bar.java"));
    });
  } finally {
    handle.close();
    cleanup();
  }
});

test("a watched directory that is moved away forwards a rescan", linuxOnly, async () => {
  const { root, outside, cleanup } = fixture();
  mkdirSync(join(root, "pkg", "inner"), { recursive: true });
  writeFileSync(join(root, "pkg", "inner", "A.java"), "class A {}");
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    renameSync(join(root, "pkg"), join(outside, "pkg"));
    await c.until(() => c.batches.some((b) => b.kind === "rescan"));
  } finally {
    handle.close();
    cleanup();
  }
});

const TREES = 6;
const FILES = 6000;

test("a nested tree created in one burst is watched once per directory and fully released on close", linuxOnly, async () => {
  const { root, cleanup } = fixture();
  const opened: FSWatcher[] = [];
  let closes = 0;
  const countingWatch = ((...args: Parameters<typeof watch>) => {
    const w = watch(...args);
    const levels = relative(root, String(args[0])).split(sep).slice(1);
    const child = ["b", "c", "d"][levels.length - 1];
    if (levels.length >= 1 && levels.length <= 3 && child !== undefined) {
      mkdirSync(join(String(args[0]), child), { recursive: true });
    }
    const close = w.close.bind(w);
    w.close = () => {
      closes++;
      close();
    };
    opened.push(w);
    return w;
  }) as typeof watch;
  const c = collector();
  const handle = await started(
    watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push, watchFn: countingWatch }),
  );
  try {
    const initial = opened.length;
    // Each tree arrives as `tN/a` holding many files, so listing `a` is slow. The
    // counting watch creates the next level the moment a level's watch is
    // attached: the parent's watcher then reports the child while the
    // ancestor's walk is still listing it, and both paths reach the child.
    const stage = mkdtempSync(join(tmpdir(), "exeris-watch-stage-"));
    for (let i = 0; i < TREES; i++) {
      mkdirSync(join(stage, `t${i}`, "a"), { recursive: true });
      for (let f = 0; f < FILES; f++) writeFileSync(join(stage, `t${i}`, "a", `f${f}.txt`), "");
      renameSync(join(stage, `t${i}`), join(root, `t${i}`));
    }
    rmSync(stage, { recursive: true, force: true });
    await sleep(1500);
    for (let i = 0; i < TREES; i++) writeFileSync(join(root, `t${i}`, "a", "b", "c", "d", "D.java"), "class D {}");
    await c.until(() => allEvents(c.batches).filter((e) => e.path.endsWith("D.java")).length === TREES);
    await sleep(300);

    const watched = handle.watchedDirectories();
    assert.equal(new Set(watched).size, watched.length, "no directory is watched twice");
    assert.equal(watched.length, 1 + TREES * 5, "root plus every tree's five directories");
    assert.equal(opened.length - initial, TREES * 5, "exactly one OS watch was opened per new directory");
  } finally {
    handle.close();
    cleanup();
  }
  assert.equal(closes, opened.length, "every OS watch that was opened has been closed");
  assert.deepEqual(handle.watchedDirectories(), []);
});

test("only a first segment of exactly `..` leaves the base", () => {
  assert.equal(leavesBase(".."), true);
  assert.equal(leavesBase(join("..", "x")), true);
  assert.equal(leavesBase("..x"), false);
  assert.equal(leavesBase(join("..x", "A.java")), false);
  assert.equal(leavesBase(""), false);
});

test("a directory named `..x` inside the root is inside it", async () => {
  const { root, cleanup } = fixture();
  mkdirSync(join(root, "..x"));
  const file = join(root, "..x", "A.java");
  writeFileSync(file, "class A {}");
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: c.push }));
  try {
    assert.equal(await resolveEventPath(root, file), file);
    writeFileSync(file, "class A { int x; }");
    await c.until(() => allEvents(c.batches).some((e) => e.path === file));
  } finally {
    handle.close();
    cleanup();
  }
});

test("a build file created within a burst applies to the events after it", async () => {
  const { root, cleanup } = fixture();
  const pkg = join(root, "pkg");
  mkdirSync(join(pkg, "target"), { recursive: true });
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: 600, onEvents: c.push }));
  try {
    // Each step lands inside one debounce window, so the probe answered for B
    // is still cached when pom.xml appears.
    writeFileSync(join(pkg, "target", "B.java"), "class B {}");
    await sleep(100);
    writeFileSync(join(pkg, "pom.xml"), "<project/>");
    await sleep(100);
    writeFileSync(join(pkg, "target", "C.java"), "class C {}");
    await c.until(() => allEvents(c.batches).length > 0);
    await sleep(700);
    const paths = allEvents(c.batches).map((e) => e.path);
    assert.ok(paths.includes(join(pkg, "target", "B.java")), JSON.stringify(paths));
    assert.ok(!paths.includes(join(pkg, "target", "C.java")), JSON.stringify(paths));
  } finally {
    handle.close();
    cleanup();
  }
});

test("a watcher that degrades leaves no closer registered", async () => {
  const before = trackedCloserCount();
  const handle = watchRoot("/", { globs: ["**/*.java"], debounceMs: DEBOUNCE_MS, onEvents: () => undefined });
  await handle.ready;
  assert.equal(handle.state().state, "degraded");
  assert.equal(trackedCloserCount(), before);
  handle.close();
  assert.equal(trackedCloserCount(), before);
});

test("a depth-0 watcher watches the root alone and reports only its own matches", async () => {
  const { root, cleanup } = fixture();
  mkdirSync(join(root, "sub"));
  const c = collector();
  const handle = await started(
    watchRoot(root, { globs: ["**/adr-index.md"], maxDepth: 0, debounceMs: DEBOUNCE_MS, onEvents: c.push }),
  );
  try {
    assert.deepEqual(handle.watchedDirectories(), [root]);
    writeFileSync(join(root, "sub", "adr-index.md"), "nested");
    writeFileSync(join(root, "other.md"), "other");
    writeFileSync(join(root, "adr-index.md"), "index");
    await c.until(() => allEvents(c.batches).length > 0);
    await sleep(150);
    assert.deepEqual(allEvents(c.batches).map((e) => e.path), [join(root, "adr-index.md")]);

    // A directory created later is not descended into either.
    mkdirSync(join(root, "later"));
    await sleep(150);
    assert.deepEqual(handle.watchedDirectories(), [root]);
  } finally {
    handle.close();
    cleanup();
  }
});

test("a depth-0 watcher reports a file replaced by rename", async () => {
  const { root, cleanup } = fixture();
  writeFileSync(join(root, "adr-index.md"), "old");
  const c = collector();
  const handle = await started(
    watchRoot(root, { globs: ["adr-index.md"], maxDepth: 0, debounceMs: DEBOUNCE_MS, onEvents: c.push }),
  );
  try {
    writeFileSync(join(root, ".adr-index.md.tmp"), "new");
    renameSync(join(root, ".adr-index.md.tmp"), join(root, "adr-index.md"));
    await c.until(() => allEvents(c.batches).some((e) => e.path === join(root, "adr-index.md")));
  } finally {
    handle.close();
    cleanup();
  }
});

test("a directory replaced within a window is judged by its new contents", linuxOnly, async () => {
  const { root, cleanup } = fixture();
  const proj = join(root, "proj");
  mkdirSync(join(proj, "build"), { recursive: true });
  writeFileSync(join(proj, "pom.xml"), "<project/>");
  const c = collector();
  const handle = await started(watchRoot(root, { globs: ["**/*.java"], debounceMs: 1500, onEvents: c.push }));
  try {
    // Caches "proj has a pom.xml".
    writeFileSync(join(proj, "build", "Old.java"), "class Old {}");
    await sleep(100);
    renameSync(proj, join(root, "proj.old"));
    await sleep(200);
    mkdirSync(join(proj, "build", "foo"), { recursive: true });
    writeFileSync(join(proj, "build", "foo", "A.java"), "class A {}");
    await sleep(300);
    assert.ok(
      handle.watchedDirectories().includes(join(proj, "build", "foo")),
      JSON.stringify(handle.watchedDirectories()),
    );
  } finally {
    handle.close();
    cleanup();
  }
});
