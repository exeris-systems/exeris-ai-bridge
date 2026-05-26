import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registerDocsTools } from "./tools/docs/index.js";
import { registerLspTools } from "./tools/lsp/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import type { ToolDefinition, ToolHandler } from "./tools/types.js";

const SERVER_NAME = "exeris-ai-bridge";
const SERVER_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
})();

async function main(): Promise<void> {
  const tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  for (const tool of [...registerDocsTools(), ...registerLspTools(), ...registerKernelTools()]) {
    tools.set(tool.definition.name, tool);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.values()].map((t) => t.definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    return await tool.handler(request.params.arguments ?? {});
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("[exeris-ai-bridge] fatal:", err);
  process.exit(1);
});
