import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  KernelShapeError,
  parseBootstrapDagSnapshot,
  parseProvidersSnapshot,
  parseRuntimeErgonomicsSnapshot,
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

// ---------------------------------------------------------------------------
// getJvmErgonomics (the fourth SPI method)

const ERGONOMICS = {
  schemaVersion: "1.0",
  capturedAt: "2026-09-02T09:15:00Z",
  gcName: "G1 Young Generation",
  heapMaxBytes: 8589934592,
  heapCommittedBytes: 536870912,
  availableProcessors: 8,
  cpuQuotaMicros: 200000,
  cpuPeriodMicros: 100000,
  memoryMaxBytes: 2147483648,
  cpusetEffective: "0-3",
  largePagesEnabled: false,
  transparentHugePages: true,
  classDataSharingActive: true,
  aotCacheActive: false,
};

test("parseRuntimeErgonomicsSnapshot re-emits the canonical contract fields", () => {
  const out = parseRuntimeErgonomicsSnapshot(ERGONOMICS);
  assert.deepEqual(out, ERGONOMICS);
});

test("an unrecognized field is dropped rather than passed through", () => {
  const out = parseRuntimeErgonomicsSnapshot({ ...ERGONOMICS, gcPauseMillis: 12 });
  assert.equal("gcPauseMillis" in out, false);
});

// Every Optional on the source record serialises as JSON null, so null is the
// normal answer for "the kernel could not determine this" — not a shape fault,
// and not something to render as a missing field.
test("null Optionals are carried through as null, not dropped", () => {
  const out = parseRuntimeErgonomicsSnapshot({
    ...ERGONOMICS,
    cpuQuotaMicros: null,
    cpuPeriodMicros: null,
    memoryMaxBytes: null,
    cpusetEffective: null,
    largePagesEnabled: null,
    transparentHugePages: null,
    classDataSharingActive: null,
    aotCacheActive: null,
  });
  assert.equal(out.cpuQuotaMicros, null);
  assert.equal(out.cpusetEffective, null);
  assert.equal(out.aotCacheActive, null);
  assert.equal("aotCacheActive" in out, true);
});

// RuntimeErgonomicsSnapshot.unknown() is what the SPI's DEFAULT method returns,
// so a kernel that never implemented this still produces a VALID response. It
// must parse; the -1s and "unknown" are the kernel's answer, not a shape error.
test("the SPI's unknown() fallback snapshot is a valid response", () => {
  const out = parseRuntimeErgonomicsSnapshot({
    schemaVersion: "1.0",
    capturedAt: "2026-09-02T09:15:00Z",
    gcName: "unknown",
    heapMaxBytes: -1,
    heapCommittedBytes: -1,
    availableProcessors: 4,
    cpuQuotaMicros: null,
    cpuPeriodMicros: null,
    memoryMaxBytes: null,
    cpusetEffective: null,
    largePagesEnabled: null,
    transparentHugePages: null,
    classDataSharingActive: null,
    aotCacheActive: null,
  });
  assert.equal(out.gcName, "unknown");
  assert.equal(out.heapMaxBytes, -1);
});

test("a non-numeric heapMaxBytes is a shape error naming the field", () => {
  assert.throws(
    () => parseRuntimeErgonomicsSnapshot({ ...ERGONOMICS, heapMaxBytes: "8g" }),
    (err: unknown) => {
      assert.ok(err instanceof KernelShapeError);
      assert.match(err.message, /runtimeErgonomicsSnapshot\.heapMaxBytes/);
      return true;
    },
  );
});

test("an incompatible major schemaVersion is rejected here too", () => {
  assert.throws(
    () => parseRuntimeErgonomicsSnapshot({ ...ERGONOMICS, schemaVersion: "2.0" }),
    (err: unknown) => {
      assert.ok(err instanceof KernelShapeError);
      assert.match(err.message, /incompatible KernelDiagnostics schema major/);
      return true;
    },
  );
});
