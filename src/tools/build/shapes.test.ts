import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyMetadataFile,
  isJavaSimpleName,
  MetadataShapeError,
  parseMetadataEnvelope,
  prefixFor,
} from "./shapes.js";

// The processor writes four kinds into one flat directory and tells them apart
// by filename prefix alone — nothing inside the file records its kind — so this
// table IS the decoding (ExerisDomainProcessor: writeMetadata(entityName, …),
// "enum_" + …, "capability_" + …, "view_" + …).
test("a bare filename is a domain entity", () => {
  assert.deepEqual(classifyMetadataFile("Station.json"), { name: "Station", kind: "domain" });
});

test("each prefix maps to its kind and is stripped from the name", () => {
  assert.deepEqual(classifyMetadataFile("enum_Status.json"), { name: "Status", kind: "enum" });
  assert.deepEqual(classifyMetadataFile("capability_vault.json"), { name: "vault", kind: "capability" });
  assert.deepEqual(classifyMetadataFile("view_Dashboard.json"), { name: "Dashboard", kind: "view" });
});

test("prefixFor round-trips with classifyMetadataFile", () => {
  for (const [kind, name] of [["domain", "Station"], ["enum", "Status"], ["capability", "vault"], ["view", "Dash"]] as const) {
    assert.deepEqual(classifyMetadataFile(`${prefixFor(kind)}${name}.json`), { name, kind });
  }
});

test("non-JSON files and nameless stems are skipped, not reported as entries", () => {
  assert.equal(classifyMetadataFile("README.md"), null);
  assert.equal(classifyMetadataFile(".json"), null);
  assert.equal(classifyMetadataFile("enum_.json"), null);
});

// An entity whose own name starts with a prefix word must not be mis-split:
// only the exact "enum_" form is a prefix.
test("a name that merely begins with a kind word stays a domain", () => {
  assert.deepEqual(classifyMetadataFile("Enumerator.json"), { name: "Enumerator", kind: "domain" });
  assert.deepEqual(classifyMetadataFile("viewport.json"), { name: "viewport", kind: "domain" });
});

const ENVELOPE = {
  schemaVersion: "0.11.0",
  sourceDigest: "sha256:abcdef",
  entityName: "Station",
  packageName: "com.example.fleet",
  fields: [{ name: "backupStation", type: "java.lang.String" }],
  restApi: true,
};

test("parseMetadataEnvelope lifts the envelope and keeps the body verbatim", () => {
  const out = parseMetadataEnvelope(ENVELOPE, "Station.json");
  assert.equal(out.schemaVersion, "0.11.0");
  assert.equal(out.sourceDigest, "sha256:abcdef");
  assert.equal(out.entityName, "Station");
  assert.equal(out.packageName, "com.example.fleet");
  assert.deepEqual(out.metadata, ENVELOPE);
});

// The opposite of the kernel:*/caps:* parsers, deliberately: this file only
// claims to understand the wrapper, so dropping the AST fields it does not
// model would throw away most of the answer.
test("unknown AST fields survive rather than being dropped", () => {
  const out = parseMetadataEnvelope({ ...ENVELOPE, somethingNewInTheSdk: [1, 2] }, "Station.json");
  assert.deepEqual((out.metadata as Record<string, unknown>).somethingNewInTheSdk, [1, 2]);
});

// ADR-042: the digest is stamped behind the javac Compiler Tree API, and where
// that API is absent the processor skips it and writes only schemaVersion. A
// digest-less file is a normal build product, not a damaged one.
test("a missing sourceDigest is normal and becomes null", () => {
  const { sourceDigest, ...noDigest } = ENVELOPE;
  void sourceDigest;
  const out = parseMetadataEnvelope(noDigest, "Station.json");
  assert.equal(out.sourceDigest, null);
});

test("a missing packageName becomes null rather than undefined", () => {
  const { packageName, ...noPackage } = ENVELOPE;
  void packageName;
  assert.equal(parseMetadataEnvelope(noPackage, "Station.json").packageName, null);
});

test("a file with no schemaVersion is rejected as not processor-written", () => {
  const { schemaVersion, ...noVersion } = ENVELOPE;
  void schemaVersion;
  assert.throws(
    () => parseMetadataEnvelope(noVersion, "Station.json"),
    (err: unknown) => {
      assert.ok(err instanceof MetadataShapeError);
      assert.match(err.message, /not written by the Exeris annotation processor/);
      return true;
    },
  );
});

test("a non-object payload names the file it came from", () => {
  assert.throws(
    () => parseMetadataEnvelope([1, 2, 3], "Station.json"),
    (err: unknown) => {
      assert.ok(err instanceof MetadataShapeError);
      assert.match(err.message, /Station\.json must contain a JSON object/);
      return true;
    },
  );
});

// The name is agent input that gets concatenated into a filename. The sandbox
// is still the boundary that decides; this keeps traversal from reaching it.
test("isJavaSimpleName accepts simple names and refuses anything path-shaped", () => {
  for (const ok of ["Station", "_Internal", "$Generated", "Station2"]) {
    assert.equal(isJavaSimpleName(ok), true, ok);
  }
  for (const bad of ["../secret", "com.example.Station", "Station.json", "a/b", "a\\b", "", "2Fast", "Sta tion"]) {
    assert.equal(isJavaSimpleName(bad), false, bad);
  }
});
