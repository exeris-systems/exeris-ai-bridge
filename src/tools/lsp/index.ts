import type { RegisteredTool } from "../types.js";

// Bridges agent queries to exeris-platform-lsp over JSON-RPC.
// Exposes @ExerisDomain types, action signatures, and codegen artefacts.
// Implementation lands in follow-up PRs per ADR-025 §Engineering Protocol.

export function registerLspTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: "lsp:list_domains",
        description: "List all @ExerisDomain types known to the active LSP session.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({
        content: [{ type: "text", text: "Not implemented yet — see ADR-025 §Engineering Protocol." }],
        isError: true,
      }),
    },
    {
      definition: {
        name: "lsp:describe_domain",
        description:
          "Return the source-model description of an @ExerisDomain type: fields, actions, generated artefacts.",
        inputSchema: {
          type: "object",
          properties: {
            qualifiedName: { type: "string", description: "Fully-qualified Java class name." },
          },
          required: ["qualifiedName"],
        },
      },
      handler: async () => ({
        content: [{ type: "text", text: "Not implemented yet — see ADR-025 §Engineering Protocol." }],
        isError: true,
      }),
    },
  ];
}
