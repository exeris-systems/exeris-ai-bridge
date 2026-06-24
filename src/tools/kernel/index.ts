import type { RegisteredTool } from "../types.js";

// Read-only introspection of a running Exeris kernel via the KernelDiagnostics SPI.
// Crosses a process boundary by design — preserves The Wall (ADR-006).
//
// Scope: runtime kernel state ONLY — provider registry, bootstrap/subsystem DAG,
// per-subsystem detail. This family is cap-blind: capability composition is a
// build-time tooling/platform surface, NOT a kernel one (ADR-024 2026-06-17
// "Validation Stamp Lifecycle" amendment; ADR-025 2026-06-17 "kernel:* Is Cap-Blind"
// amendment). Do NOT add a kernel:list_capabilities tool here.
//
// The KernelDiagnostics SPI + Community provider + exeris-kernel-diagnostics-cli have
// shipped (exeris-kernel v0.9.0, ADR-033 ACCEPTED). These handlers are placeholders
// until the Node-side adapter (src/transport/kernel-adapter.ts) lands in 0.4.0.

const PENDING_ADAPTER =
  "Not implemented yet — the KernelDiagnostics SPI + CLI have shipped (exeris-kernel v0.9.0, " +
  "ADR-033); blocked on the bridge-side kernel adapter (src/transport/kernel-adapter.ts, ROADMAP 0.4.0).";

export function registerKernelTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: "kernel:list_providers",
        description:
          "List all SPI providers registered with the running kernel, including driver origin (community/enterprise).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({
        content: [{ type: "text", text: PENDING_ADAPTER }],
        isError: true,
      }),
    },
    {
      definition: {
        name: "kernel:get_bootstrap_dag",
        description:
          "Snapshot of the kernel bootstrap dependency DAG — nodes (subsystems) with their phase, declared dependencies, and running state.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({
        content: [{ type: "text", text: PENDING_ADAPTER }],
        isError: true,
      }),
    },
    {
      definition: {
        name: "kernel:describe_subsystem",
        description:
          "Detail for a single kernel subsystem by name (e.g. memory, crypto, persistence, graph, transport, events, flow, http, security).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Subsystem name to describe." },
          },
          required: ["name"],
        },
      },
      // args.name must be forwarded to the diagnostics request once
      // src/transport/kernel-adapter.ts lands (0.4.0); the placeholder ignores it.
      handler: async () => ({
        content: [{ type: "text", text: PENDING_ADAPTER }],
        isError: true,
      }),
    },
  ];
}
