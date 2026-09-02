import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CapShapeError, parseCapManifest } from "./shapes.js";

// Mirrors eu.exeris.sdk.composition.CapManifest as exeris-tooling emits it.
// The two-module example is the shape CapCompositionE2ETest asserts upstream:
// audit @Requires what vault @Provides, so initOrder is [vault, audit] — the
// opposite of alphabetical, which is the whole reason it is stamped rather
// than derived.
const MANIFEST = {
  schemaVersion: 2,
  stamp: {
    validated: true,
    compositionVersion: "1.4.0",
    contentBinding: "sha256:2b9c0f1e",
  },
  modules: [
    {
      qualifiedName: "eu.exeris.caps.vault.VaultModule",
      module: { provides: [{ service: "eu.exeris.caps.vault.Vault", version: "1.0.0" }], lifecycleOwner: "eu.exeris.caps.vault.VaultLifecycle" },
    },
    {
      qualifiedName: "eu.exeris.caps.audit.AuditModule",
      module: { provides: [], lifecycleOwner: null },
    },
  ],
  initOrder: ["eu.exeris.caps.vault.VaultModule", "eu.exeris.caps.audit.AuditModule"],
};

test("parseCapManifest re-emits the canonical contract fields", () => {
  assert.deepEqual(parseCapManifest(MANIFEST), MANIFEST);
});

test("an unrecognized producer field is dropped rather than passed through", () => {
  const out = parseCapManifest({ ...MANIFEST, generatedAt: "2026-09-02T00:00:00Z" });
  assert.equal("generatedAt" in out, false);
});

// The producer normalises a blank lifecycleOwner to null, so null is the only
// "no owner" state — an absent key must land on it too rather than undefined.
test("an absent lifecycleOwner is normalized to null", () => {
  const out = parseCapManifest({
    ...MANIFEST,
    modules: [{ qualifiedName: "a.B", module: { provides: [] } }],
    initOrder: ["a.B"],
  });
  assert.equal(out.modules[0].module.lifecycleOwner, null);
});

// initOrder is transcribed, never recomputed: the bridge must not re-resolve
// the @Requires→@Provides DAG. Feeding it an order no dependency analysis would
// produce proves the parser has no opinion about it.
test("initOrder is transcribed verbatim, not re-derived", () => {
  const reversed = [...MANIFEST.initOrder].reverse();
  const out = parseCapManifest({ ...MANIFEST, initOrder: reversed });
  assert.deepEqual(out.initOrder, reversed);
});

test("a validated:false stamp parses — it is an answer, not a fault", () => {
  const out = parseCapManifest({ ...MANIFEST, stamp: { ...MANIFEST.stamp, validated: false } });
  assert.equal(out.stamp.validated, false);
});

// schemaVersion is a single integer, not semver: a different number is a
// different contract, so there is no compatible-minor to be lenient about.
test("a different schemaVersion is refused, naming both versions", () => {
  assert.throws(
    () => parseCapManifest({ ...MANIFEST, schemaVersion: 3 }),
    (err: unknown) => {
      assert.ok(err instanceof CapShapeError);
      assert.match(err.message, /incompatible cap-manifest schemaVersion 3/);
      assert.match(err.message, /supports 2/);
      return true;
    },
  );
});

test("a non-integer schemaVersion is a shape error", () => {
  assert.throws(
    () => parseCapManifest({ ...MANIFEST, schemaVersion: "2" }),
    (err: unknown) => {
      assert.ok(err instanceof CapShapeError);
      assert.match(err.message, /schemaVersion must be an integer/);
      return true;
    },
  );
});

test("a malformed module names the offending index", () => {
  assert.throws(
    () => parseCapManifest({ ...MANIFEST, modules: [{ qualifiedName: 7, module: { provides: [] } }] }),
    (err: unknown) => {
      assert.ok(err instanceof CapShapeError);
      assert.match(err.message, /capManifest\.modules\[0\]\.qualifiedName must be a string/);
      return true;
    },
  );
});

test("a missing stamp is a shape error, not a silent empty stamp", () => {
  assert.throws(
    () => parseCapManifest({ ...MANIFEST, stamp: undefined }),
    (err: unknown) => {
      assert.ok(err instanceof CapShapeError);
      assert.match(err.message, /capManifest\.stamp must be an object/);
      return true;
    },
  );
});
