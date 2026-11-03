import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { writeJar } from "./__tests__/jar-fixture.js";
import { readJarEntry } from "./jar-entry.js";

const dir = mkdtempSync(join(tmpdir(), "exeris-jar-entry-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const TEXT = '{"briefSchemaFormat":1}'.repeat(50);
const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

function reason(read: ReturnType<typeof readJarEntry>): string {
  return read.kind === "failed" ? read.reason : "";
}

test("a stored entry is read back", () => {
  const jar = join(dir, "stored.jar");
  writeJar(jar, { "a.txt": "x", "META-INF/exeris/brief-schema.json": TEXT });
  const read = readJarEntry(jar, "META-INF/exeris/brief-schema.json", 10_000);
  assert.equal(read.kind === "ok" && read.bytes.toString("utf8"), TEXT);
});

test("a deflated entry is read back", () => {
  const jar = join(dir, "deflated.jar");
  writeJar(jar, { "e.json": TEXT }, { deflate: true });
  const read = readJarEntry(jar, "e.json", 10_000);
  assert.equal(read.kind === "ok" && read.bytes.toString("utf8"), TEXT);
});

test("an entry that is not in the archive is absent, not a failure", () => {
  const jar = join(dir, "other.jar");
  writeJar(jar, { "a.txt": "x" });
  assert.deepEqual(readJarEntry(jar, "missing.json", 1000), { kind: "absent" });
});

test("an entry over the byte limit is refused with the limit named, stored or deflated", () => {
  for (const deflate of [false, true]) {
    const jar = join(dir, `big-${deflate}.jar`);
    writeJar(jar, { "e.json": TEXT }, { deflate });
    const read = readJarEntry(jar, "e.json", 100);
    assert.equal(read.kind, "failed");
    assert.match(reason(read), /limit is 100/);
  }
});

test("a deflated entry whose directory understates its size cannot inflate past the limit", () => {
  const jar = join(dir, "lie.jar");
  writeJar(jar, { "e.json": "a".repeat(100_000) }, { deflate: true });
  const bytes = readFileSync(jar);
  bytes.writeUInt32LE(50, bytes.lastIndexOf(CENTRAL) + 24);
  writeFileSync(jar, bytes);
  const read = readJarEntry(jar, "e.json", 1000);
  assert.equal(read.kind, "failed");
});

test("a truncated, junk or tiny archive fails with its own reason", () => {
  const jar = join(dir, "trunc.jar");
  writeJar(jar, { "e.json": TEXT });
  truncateSync(jar, 40);
  assert.equal(readJarEntry(jar, "e.json", 10_000).kind, "failed");

  const junk = join(dir, "junk.jar");
  writeFileSync(junk, Buffer.alloc(500, 7));
  assert.match(reason(readJarEntry(junk, "e.json", 10_000)), /end-of-central-directory/);

  const tiny = join(dir, "tiny.jar");
  writeFileSync(tiny, "x");
  assert.match(reason(readJarEntry(tiny, "e.json", 10)), /too short/);
});

test("an unreadable path reports the I/O error, not a missing entry", () => {
  const read = readJarEntry(join(dir, "nope.jar"), "e.json", 10);
  assert.equal(read.kind, "failed");
  assert.match(reason(read), /ENOENT/);
});

test("an encrypted entry and a zip64 archive are refused with a reason", () => {
  const jar = join(dir, "enc.jar");
  writeJar(jar, { "e.json": TEXT });
  const bytes = readFileSync(jar);
  bytes.writeUInt16LE(1, bytes.lastIndexOf(CENTRAL) + 8);
  writeFileSync(jar, bytes);
  assert.match(reason(readJarEntry(jar, "e.json", 10_000)), /encrypted/);

  const z64 = join(dir, "z64.jar");
  writeJar(z64, { "e.json": TEXT });
  const b2 = readFileSync(z64);
  b2.writeUInt16LE(0xffff, b2.length - 22 + 10);
  writeFileSync(z64, b2);
  assert.match(reason(readJarEntry(z64, "e.json", 10_000)), /zip64/);
});

test("a jar produced by the Maven build is readable", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const real = join(
    here,
    "..",
    "..",
    "test/fixtures/m2/eu/exeris/exeris-sdk-source-model/0.13.1/exeris-sdk-source-model-0.13.1.jar",
  );
  const read = readJarEntry(real, "META-INF/exeris/brief-schema.json", 1024 * 1024);
  assert.equal(read.kind, "ok");
});
