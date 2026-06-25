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
  docsRoot: "/var/empty/exeris-docs-stub",
  ecosystemRoot: "/var/empty",
  lsp: { command: "lsp-stub", args: [], source: "default", workspaceRoot: "/var/empty" },
  kernel: { command: "kernel-stub", args: [], source: "default" },
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

test("registerKernelTools registers all three kernel:* tools", () => {
  const names = registerKernelTools(CONFIG, stubAdapter(async () => ({})))
    .map((t) => t.definition.name)
    .sort();
  assert.deepEqual(names, [
    "kernel:describe_subsystem",
    "kernel:get_bootstrap_dag",
    "kernel:list_providers",
  ]);
});

test("kernel:list_providers returns the validated snapshot as pretty JSON on success", async () => {
  const calls: string[] = [];
  const tools = toolsWith(async (method) => {
    calls.push(method);
    return PROVIDERS;
  });
  const res = await tools.get("kernel:list_providers")!.handler({});
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(text(res)), PROVIDERS);
  assert.deepEqual(calls, ["listProviders"]);
});

test("kernel:list_providers surfaces a shape mismatch as a clear error, not a crash", async () => {
  const tools = toolsWith(async () => ({ schemaVersion: "1.0", capturedAt: "t", providers: "nope" }));
  const res = await tools.get("kernel:list_providers")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /did not match the expected read-only wire shape/);
  assert.match(text(res), /providers must be an array/);
});

test("kernel:list_providers maps a transport failure onto an actionable error", async () => {
  const tools = toolsWith(async () => {
    throw new KernelTransportError("Cannot reach kernel diagnostics CLI (command: kernel-stub): ENOENT");
  });
  const res = await tools.get("kernel:list_providers")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /Cannot reach kernel diagnostics CLI/);
  assert.match(text(res), /EXERIS_KERNEL_COMMAND/);
});

test("kernel:get_bootstrap_dag maps a rejected request onto a clear error", async () => {
  const tools = toolsWith(async () => {
    throw new KernelRequestError("unknown method: getBootstrapDag");
  });
  const res = await tools.get("kernel:get_bootstrap_dag")!.handler({});
  assert.equal(res.isError, true);
  assert.match(text(res), /was rejected: unknown method/);
});

test("kernel:get_bootstrap_dag returns the validated DAG snapshot on success", async () => {
  const dag = {
    schemaVersion: "1.0",
    capturedAt: "t",
    nodes: [{ name: "memory", phase: "FOUNDATION", dependsOn: [], running: true, optional: false }],
  };
  const tools = toolsWith(async () => dag);
  const res = await tools.get("kernel:get_bootstrap_dag")!.handler({});
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(text(res)), dag);
});

test("kernel:describe_subsystem rejects a missing/blank name before any adapter call", async () => {
  let called = false;
  const tools = toolsWith(async () => {
    called = true;
    return {};
  });
  const res = await tools.get("kernel:describe_subsystem")!.handler({ name: "   " });
  assert.equal(res.isError, true);
  assert.match(text(res), /'name' must be a non-empty string/);
  assert.equal(called, false);
});

test("kernel:describe_subsystem forwards name and validates the snapshot (null subsystem ok)", async () => {
  const seen: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const tools = toolsWith(async (method, params) => {
    seen.push({ method, params });
    return { schemaVersion: "1.0", capturedAt: "t", requestedName: "ghost", subsystem: null };
  });
  const res = await tools.get("kernel:describe_subsystem")!.handler({ name: "ghost" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(seen, [{ method: "describeSubsystem", params: { name: "ghost" } }]);
  assert.equal(JSON.parse(text(res)).subsystem, null);
});
