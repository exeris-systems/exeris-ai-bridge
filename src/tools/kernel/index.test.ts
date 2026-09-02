import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BridgeConfig } from "../../config/env.js";
import {
  KernelAdapter,
  KernelRequestError,
  KernelTransportError,
} from "../../transport/kernel-adapter.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerKernelTools } from "./index.js";

const CONFIG: BridgeConfig = {
  mode: "contributor",
  modeSource: "probe",
  ecosystemRoot: "/var/empty",
  docs: { state: "available", docsRoot: "/var/empty/exeris-docs-stub", ecosystemRoot: "/var/empty" },
  lsp: { state: "available", command: "lsp-stub", args: [], source: "source-tree", workspaceRoot: "/var/empty" },
  kernel: { state: "available", command: "kernel-stub", args: [], source: "source-tree" },
};

/** The same config with no launch spec for the CLI — the zero-checkout shape. */
const DARK_CONFIG: BridgeConfig = {
  ...CONFIG,
  kernel: { state: "unavailable", reason: "no launch spec (test)", remedy: "set EXERIS_KERNEL_COMMAND (test)" },
};

type RequestFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** The tools only ever call adapter.request — a thin stub is enough here. */
function stubAdapter(request: RequestFn): KernelAdapter {
  return { request } as unknown as KernelAdapter;
}

function toolsWith(request: RequestFn) {
  return new Map(
    registerKernelTools(CONFIG, stubAdapter(request)).map((t) => [t.definition.name, t]),
  );
}

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

const PROVIDERS = {
  schemaVersion: "1.0",
  capturedAt: "2026-06-25T00:00:00Z",
  providers: [
    { providerName: "ExerisCommunity/KernelDiagnostics", spiType: "telemetry", priority: 0, displayName: null },
  ],
};

test("registerKernelTools registers one tool per KernelDiagnostics method", () => {
  const names = registerKernelTools(CONFIG, stubAdapter(async () => ({})))
    .map((t) => t.definition.name)
    .sort();
  assert.deepEqual(names, [
    "kernel-describe_subsystem",
    "kernel-get_bootstrap_dag",
    "kernel-get_jvm_ergonomics",
    "kernel-list_providers",
  ]);
});

test("kernel-list_providers returns the validated snapshot as pretty JSON on success", async () => {
  const calls: string[] = [];
  const tools = toolsWith(async (method) => {
    calls.push(method);
    return PROVIDERS;
  });
  const res = await tools.get("kernel-list_providers")!.handler({});
  assert.ok(!res.isError, text(res));
  assert.deepEqual(JSON.parse(text(res)), PROVIDERS);
  assert.deepEqual(calls, ["listProviders"]);
});

test("kernel-list_providers surfaces a shape mismatch as a clear error, not a crash", async () => {
  const tools = toolsWith(async () => ({ schemaVersion: "1.0", capturedAt: "t", providers: "nope" }));
  const res = await tools.get("kernel-list_providers")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /did not match the expected read-only wire shape/);
  assert.match(text(res), /providers must be an array/);
});

test("kernel-list_providers maps a transport failure onto an actionable error", async () => {
  const tools = toolsWith(async () => {
    throw new KernelTransportError("Cannot reach kernel diagnostics CLI (command: kernel-stub): ENOENT");
  });
  const res = await tools.get("kernel-list_providers")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /Cannot reach kernel diagnostics CLI/);
  assert.match(text(res), /EXERIS_KERNEL_COMMAND/);
});

test("kernel-get_bootstrap_dag maps a rejected request onto a clear error", async () => {
  const tools = toolsWith(async () => {
    throw new KernelRequestError("unknown method: getBootstrapDag");
  });
  const res = await tools.get("kernel-get_bootstrap_dag")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /was rejected: unknown method/);
});

test("kernel-get_bootstrap_dag returns the validated DAG snapshot on success", async () => {
  const dag = {
    schemaVersion: "1.0",
    capturedAt: "t",
    nodes: [{ name: "memory", phase: "FOUNDATION", dependsOn: [], running: true, optional: false }],
  };
  const tools = toolsWith(async () => dag);
  const res = await tools.get("kernel-get_bootstrap_dag")!.handler({});
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(text(res)), dag);
});

test("kernel-describe_subsystem rejects a missing/blank name before any adapter call", async () => {
  let called = false;
  const tools = toolsWith(async () => {
    called = true;
    return {};
  });
  const res = await tools.get("kernel-describe_subsystem")!.handler({ name: "   " });
  assert.equal(res.isError, true);
  assert.match(text(res), /'name' must be a non-empty string/);
  assert.equal(called, false);
});

test("kernel-describe_subsystem forwards name and validates the snapshot (null subsystem ok)", async () => {
  const seen: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const tools = toolsWith(async (method, params) => {
    seen.push({ method, params });
    return { schemaVersion: "1.0", capturedAt: "t", requestedName: "ghost", subsystem: null };
  });
  const res = await tools.get("kernel-describe_subsystem")!.handler({ name: "ghost" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(seen, [{ method: "describeSubsystem", params: { name: "ghost" } }]);
  assert.equal(JSON.parse(text(res)).subsystem, null);
});

test("kernel-* is dark when config resolved no launch spec", async () => {
  const tools = new Map(registerKernelTools(DARK_CONFIG).map((t) => [t.definition.name, t]));
  for (const [name, tool] of tools) {
    const res = await tool.handler({});
    assert.equal(res.isError, true, name);
    const payload = JSON.parse(text(res));
    assert.equal(payload.error, "family_unavailable", name);
    assert.equal(payload.family, "kernel", name);
    assert.equal(payload.reason, "no launch spec (test)", name);
  }
});

test("an injected adapter overrides config-time unavailability", async () => {
  // The test seam must not depend on the environment: a caller that hands in a
  // transport has, by definition, supplied what config resolution could not.
  const tools = new Map(
    registerKernelTools(DARK_CONFIG, stubAdapter(async () => PROVIDERS)).map((t) => [
      t.definition.name,
      t,
    ]),
  );
  const res = await tools.get("kernel-list_providers")!.handler({});
  assert.equal(res.isError, undefined);
});


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

test("kernel-get_jvm_ergonomics calls getJvmErgonomics and returns the validated snapshot", async () => {
  const calls: string[] = [];
  const tools = toolsWith(async (method) => {
    calls.push(method);
    return ERGONOMICS;
  });
  const res = await tools.get("kernel-get_jvm_ergonomics")!.handler({});
  assert.ok(!res.isError, text(res));
  assert.deepEqual(JSON.parse(text(res)), ERGONOMICS);
  assert.deepEqual(calls, ["getJvmErgonomics"]);
});

// A kernel older than the method answers KernelRequestError rather than a
// snapshot. That is a normal outcome to relay, not a bridge fault — the SPI
// default only covers kernels that HAVE the method and no implementation.
test("kernel-get_jvm_ergonomics reports a kernel that does not know the method", async () => {
  const tools = toolsWith(async () => {
    throw new KernelRequestError("unknown method: getJvmErgonomics");
  });
  const res = await tools.get("kernel-get_jvm_ergonomics")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /was rejected: unknown method/);
});

test("kernel-get_jvm_ergonomics is dark with the rest of the family", async () => {
  const tools = new Map(
    registerKernelTools(DARK_CONFIG).map((t) => [t.definition.name, t]),
  );
  const res = await tools.get("kernel-get_jvm_ergonomics")!.handler({});
  assert.equal(res.isError, true);
  const payload = JSON.parse(text(res));
  assert.equal(payload.error, "family_unavailable");
  assert.equal(payload.family, "kernel");
});
