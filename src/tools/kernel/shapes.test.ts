import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  KernelShapeError,
  parseBootstrapDagSnapshot,
  parseProvidersSnapshot,
  parseSubsystemSnapshot,
} from "./shapes.js";

test("parseProvidersSnapshot re-emits the canonical contract fields", () => {
  const out = parseProvidersSnapshot({
    schemaVersion: "1.0",
    capturedAt: "2026-06-25T14:30:45Z",
    providers: [
      { providerName: "ExerisCommunity/KernelDiagnostics", spiType: "telemetry", priority: 0, displayName: null },
    ],
    extra: "ignored",
  });
  assert.deepEqual(out, {
    schemaVersion: "1.0",
    capturedAt: "2026-06-25T14:30:45Z",
    providers: [
      { providerName: "ExerisCommunity/KernelDiagnostics", spiType: "telemetry", priority: 0, displayName: null },
    ],
  });
});

test("parseProvidersSnapshot normalizes an absent displayName to null", () => {
  const out = parseProvidersSnapshot({
    schemaVersion: "1.0",
    capturedAt: "t",
    providers: [{ providerName: "P", spiType: "memory", priority: 100 }],
  });
  assert.equal(out.providers[0].displayName, null);
});

test("parseProvidersSnapshot rejects a non-numeric priority", () => {
  assert.throws(
    () =>
      parseProvidersSnapshot({
        schemaVersion: "1.0",
        capturedAt: "t",
        providers: [{ providerName: "P", spiType: "memory", priority: "high" }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof KernelShapeError);
      assert.match(err.message, /providers\[0\]\.priority must be a finite number/);
      return true;
    },
  );
});

test("parseBootstrapDagSnapshot validates nodes with dependsOn and flags", () => {
  const out = parseBootstrapDagSnapshot({
    schemaVersion: "1.0",
    capturedAt: "t",
    nodes: [
      { name: "memory", phase: "FOUNDATION", dependsOn: [], running: true, optional: false },
      { name: "crypto", phase: "FOUNDATION", dependsOn: ["memory"], running: true, optional: false },
    ],
  });
  assert.equal(out.nodes.length, 2);
  assert.deepEqual(out.nodes[1].dependsOn, ["memory"]);
});

test("parseBootstrapDagSnapshot rejects a non-string entry inside dependsOn", () => {
  assert.throws(
    () =>
      parseBootstrapDagSnapshot({
        schemaVersion: "1.0",
        capturedAt: "t",
        nodes: [{ name: "x", phase: "RUNTIME", dependsOn: [42], running: true, optional: false }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof KernelShapeError);
      assert.match(err.message, /nodes\[0\]\.dependsOn\[0\] must be a string/);
      return true;
    },
  );
});

test("parseSubsystemSnapshot returns the descriptor when present", () => {
  const out = parseSubsystemSnapshot({
    schemaVersion: "1.0",
    capturedAt: "t",
    requestedName: "transport",
    subsystem: { name: "transport", phase: "SERVICES", dependsOn: ["memory"], running: true, optional: false },
  });
  assert.equal(out.requestedName, "transport");
  assert.equal(out.subsystem?.name, "transport");
});

test("parseSubsystemSnapshot maps an absent/null subsystem to null (not an error)", () => {
  const absent = parseSubsystemSnapshot({ schemaVersion: "1.0", capturedAt: "t", requestedName: "nope" });
  assert.equal(absent.subsystem, null);
  const explicitNull = parseSubsystemSnapshot({
    schemaVersion: "1.0",
    capturedAt: "t",
    requestedName: "nope",
    subsystem: null,
  });
  assert.equal(explicitNull.subsystem, null);
});

test("a compatible minor schemaVersion (1.x) is accepted", () => {
  const out = parseProvidersSnapshot({ schemaVersion: "1.7", capturedAt: "t", providers: [] });
  assert.equal(out.schemaVersion, "1.7");
});

test("an incompatible major schemaVersion (2.0) is a clear version error", () => {
  assert.throws(
    () => parseBootstrapDagSnapshot({ schemaVersion: "2.0", capturedAt: "t", nodes: [] }),
    (err: unknown) => {
      assert.ok(err instanceof KernelShapeError);
      assert.match(err.message, /incompatible KernelDiagnostics schema major/);
      assert.match(err.message, /supports 1\.x/);
      return true;
    },
  );
});

test("a snapshot missing schemaVersion is a shape error", () => {
  assert.throws(
    () => parseProvidersSnapshot({ capturedAt: "t", providers: [] }),
    (err: unknown) => {
      assert.ok(err instanceof KernelShapeError);
      assert.match(err.message, /schemaVersion must be a string/);
      return true;
    },
  );
});
