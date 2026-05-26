#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config/env.js";
import { registerDocsTools } from "./tools/docs/index.js";
import { registerLspTools } from "./tools/lsp/index.js";
import { registerKernelTools } from "./tools/kernel/index.js";
import type { ToolDefinition, ToolHandler } from "./tools/types.js";
import { getServerVersion } from "./version.js";

const SERVER_NAME = "exeris-ai-bridge";

async function main(): Promise<void> {
  const config = loadConfig();

  const tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  for (const tool of [
    ...registerDocsTools(config),
    ...registerLspTools(),
    ...registerKernelTools(),
  ]) {
    tools.set(tool.definition.name, tool);
  }

  const server = new Server(
    { name: SERVER_NAME, version: getServerVersion() },
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
