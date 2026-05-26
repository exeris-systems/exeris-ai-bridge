import type { RegisteredTool } from "../types.js";

// Surfaces the exeris-docs ADR registry, HLA, whitepaper, and templates to agents.
// Filesystem-bound: reads ../exeris-docs/ relative to the bridge install root.
// Implementation lands in follow-up PRs per ADR-025 §Engineering Protocol.

export function registerDocsTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: "docs:list_adrs",
        description:
          "List all ADRs in the Exeris ecosystem registry with number, title, owning repo, scope, visibility, and status.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["proposed", "accepted", "superseded", "withdrawn"],
              description: "Optional filter by ADR status.",
            },
          },
        },
      },
      handler: async () => ({
        content: [{ type: "text", text: "Not implemented yet — see ADR-025 §Engineering Protocol." }],
        isError: true,
      }),
    },
    {
      definition: {
        name: "docs:get_adr",
        description: "Fetch the full content of a specific ADR by number.",
        inputSchema: {
          type: "object",
          properties: {
            number: { type: "integer", description: "ADR number, e.g. 24 for ADR-024." },
          },
          required: ["number"],
        },
      },
      handler: async () => ({
        content: [{ type: "text", text: "Not implemented yet — see ADR-025 §Engineering Protocol." }],
        isError: true,
      }),
    },
  ];
}
