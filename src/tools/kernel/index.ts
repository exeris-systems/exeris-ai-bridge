import type { RegisteredTool } from "../types.js";

// Read-only introspection of a running Exeris kernel via the KernelDiagnostics SPI.
// Crosses a process boundary by design — preserves The Wall (ADR-006).
// Blocked on the KernelDiagnostics SPI RFC; see ADR-025 §Engineering Protocol item 2.

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
        content: [
          {
            type: "text",
            text: "Not implemented yet — blocked on KernelDiagnostics SPI RFC (ADR-025 §Engineering Protocol item 2).",
          },
        ],
        isError: true,
      }),
    },
    {
      definition: {
        name: "kernel:list_capabilities",
        description: "List composed capabilities and their @Provides / @Requires graph per ADR-024.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({
        content: [
          {
            type: "text",
            text: "Not implemented yet — blocked on KernelDiagnostics SPI RFC (ADR-025 §Engineering Protocol item 2).",
          },
        ],
        isError: true,
      }),
    },
  ];
}
