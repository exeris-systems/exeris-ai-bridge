import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { BridgeConfig, KernelConfig } from "../config/env.js";
import { registerKernelTools } from "../tools/kernel/index.js";
import { KernelAdapter } from "./kernel-adapter.js";

// End-to-end integration test for the kernel:* family against a REAL
// exeris-kernel-diagnostics-cli — the item closing ROADMAP 0.4.0. It spawns the
// CLI over the same NDJSON-over-stdio path production uses (the kernel boots in
// read-only inspect mode) and asserts all three tools return the validated
// snapshot shapes.
//
// Opt-in: the bridge's own CI does not carry a JVM toolchain, so this is gated
// on EXERIS_KERNEL_IT=1 AND EXERIS_KERNEL_COMMAND pointing at a runnable CLI:
//
//   EXERIS_KERNEL_IT=1 \
//   EXERIS_KERNEL_COMMAND="mvn -q -f /abs/exeris-kernel/exeris-kernel-diagnostics-cli/pom.xml exec:java -Dexec.mainClass=eu.exeris.kernel.diagnostics.cli.DiagnosticsCli" \
//   npm run build && (cd dist && node --test transport/kernel-integration.test.js)
//
// A pre-built shaded jar (java -jar …-diagnostics-cli-<ver>.jar) is the faster
// override. The test also empirically confirms the default Maven launch keeps
// NDJSON stdout clean: leaked Maven logging would desync the framing and fail.

const command = process.env.EXERIS_KERNEL_COMMAND?.trim();
const skip = !process.env.EXERIS_KERNEL_IT
  ? "set EXERIS_KERNEL_IT=1 (and EXERIS_KERNEL_COMMAND) to run the live kernel integration test"
  : !command
    ? "EXERIS_KERNEL_COMMAND must point at a runnable exeris-kernel-diagnostics-cli"
    : false;

// JVM + Maven cold start is slow; give the first (lazy-spawn) request room.
const REQUEST_TIMEOUT_MS = 90_000;

function text(res: CallToolResult): string {
  return (res.content[0] as { text: string }).text;
}

// Returns `any` so assertions can index the decoded payload directly (test-only).
function parseJson(res: CallToolResult): any {
  const raw = text(res);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`tool returned non-JSON (isError=${res.isError}): ${raw}`);
  }
}

// The transports are injected below, so config-time availability is moot —
// every family is left dark to make that explicit: an injected client/adapter
// IS the transport and overrides what config resolution found (or didn't).
const NOT_UNDER_TEST = {
  state: "unavailable" as const,
  reason: "not under test",
  remedy: "not under test",
};

const DARK_CONFIG: BridgeConfig = {
  mode: "app",
  modeSource: "probe",
  ecosystemRoot: null,
  docs: NOT_UNDER_TEST,
  lsp: NOT_UNDER_TEST,
  kernel: NOT_UNDER_TEST,
};

test(
  "kernel:* tools return validated data from a real diagnostics CLI over NDJSON",
  { skip, timeout: REQUEST_TIMEOUT_MS + 30_000 },
  async () => {
    const tokens = command!.split(/\s+/);
    const kernel: KernelConfig = {
      state: "available",
      command: tokens[0],
      args: tokens.slice(1),
      source: "env-command",
    };
    // Own the adapter so we can dispose() the child JVM in the finally block.
    const adapter = new KernelAdapter(kernel, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const tools = new Map(
      registerKernelTools(DARK_CONFIG, adapter).map((t) => [t.definition.name, t]),
    );

    try {
      const providers = parseJson(await tools.get("kernel-list_providers")!.handler({}));
      assert.equal(providers.schemaVersion, "1.0");
      assert.ok(Array.isArray(providers.providers) && providers.providers.length >= 1);
      // listProviders enumerates one Community provider per SPI domain; the core
      // subsystems (memory, telemetry) are always present in inspect mode.
      const spiTypes = providers.providers.map((p: { spiType: string }) => p.spiType);
      assert.ok(
        spiTypes.includes("memory") && spiTypes.includes("telemetry"),
        `expected core spiTypes among providers, got ${JSON.stringify(spiTypes)}`,
      );

      const dag = parseJson(await tools.get("kernel-get_bootstrap_dag")!.handler({}));
      assert.equal(dag.schemaVersion, "1.0");
      assert.ok(Array.isArray(dag.nodes) && dag.nodes.length >= 1);
      const node = dag.nodes[0];
      assert.equal(typeof node.name, "string");
      assert.equal(typeof node.phase, "string");
      assert.ok(Array.isArray(node.dependsOn));

      // describe_subsystem on a name we know exists (taken from the live DAG) —
      // it must echo the request and return a matching descriptor.
      const detail = parseJson(
        await tools.get("kernel-describe_subsystem")!.handler({ name: node.name }),
      );
      assert.equal(detail.requestedName, node.name);
      assert.equal(detail.subsystem?.name, node.name);

      // A name that cannot exist resolves to a clean null, not an error.
      const missing = parseJson(
        await tools.get("kernel-describe_subsystem")!.handler({ name: "__no_such_subsystem__" }),
      );
      assert.equal(missing.subsystem, null);
    } finally {
      adapter.dispose();
    }
  },
);
